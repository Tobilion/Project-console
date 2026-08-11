// Phase 2 (UPGRADE-ROADMAP.md, 2026-08-11): general-mode file tools — find by name/content,
// tidy by category/date, duplicate detection + deletion. Trigger-mode-only: no model involved,
// zero AI dependency (plain substring search, sha256 hashing). Read-only shapes (find,
// duplicates) answer immediately; mutating shapes (tidy, duplicates_delete) go through the
// standard confirm flow with a move/delete preview and journal every change through
// actionHistory.js so `revert action <id>` undoes them. Every path is validated by
// createResolveSafe (toolSandbox.js — the same symlink-aware escape rejection the AI tools
// use), never a hand-rolled check.
//
// Design note: these handlers write via plain fs calls journaled directly through appendAction
// (new `file_move` action type) rather than via a tools.js wrapped tool — there is no move
// tool in the tool layer, and Phase 12 of the roadmap explicitly defers that refactor to a
// dedicated audit. The journal + revert contract is identical either way.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { walkDir, isTextFile } from '../toolScan.js';
import { createResolveSafe } from '../toolSandbox.js';
import { pendingConfirmations } from '../state.js';
import { appendAction } from '../actionHistory.js';

const MAX_RESULTS = 20;          // find/duplicates answer cap (matches big-list intent conventions)
const MAX_CONTENT_FILE_BYTES = 20000; // don't substring-scan huge files (codebaseData.MAX_FILE_READ_BYTES)
const MAX_HASH_FILES = 2000;     // duplicates scan cap — bounded walk, never a full-disk hash storm
const MAX_HASH_FILE_BYTES = 50 * 1024 * 1024; // skip bigger files with a note rather than hashing them
const MAX_PREIMAGE_BYTES = 1_000_000; // same inline pre-image cap as tools.js wrapMutatingTool
const MAX_TIDY_MOVES = 100;      // one tidy run is bounded; the user re-runs for the rest
const MAX_PREVIEW_LINES = 12;    // confirm prompt shows a sample, not a wall of moves

// Extension -> category folder for "organize by type". Deliberately conservative: only these
// well-known media/document families move; unknown extensions stay where they are.
const CATEGORY_BY_EXT = {
  images: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic'],
  documents: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt', '.epub'],
  spreadsheets: ['.xls', '.xlsx', '.csv', '.ods'],
  presentations: ['.ppt', '.pptx', '.odp'],
  archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'],
  audio: ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'],
  video: ['.mp4', '.mkv', '.avi', '.mov', '.webm'],
};
const EXT_TO_CATEGORY = new Map();
for (const [cat, exts] of Object.entries(CATEGORY_BY_EXT)) {
  for (const ext of exts) EXT_TO_CATEGORY.set(ext, cat);
}
const CATEGORY_LABEL = {
  images: 'Images', documents: 'Documents', spreadsheets: 'Spreadsheets',
  presentations: 'Presentations', archives: 'Archives', audio: 'Audio', video: 'Video',
};

const answer = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data }));

/**
 * Extracts the search query from "find files matching X" / "search my files for X" /
 * "search for X in my files" / "find files with the word X" shapes. Returns
 * { type: 'content'|'name', query } or null — the handler asks instead of guessing when
 * nothing extracts (same conservative-parse policy as parseFileNameOnly).
 */
export function extractFindQuery(input) {
  const contentShapes = [
    /\b(?:containing|matching|mentioning|with the (?:word|text|content))\s+(.+?)(?:\s+in\s+(?:my|the|these|all)\s+(?:files|documents|folder|project)|$)/i,
    /\bfor\s+(.+?)\s+in\s+(?:my|the|these|all)\s+(?:files|documents|folder|project)\b/i,
    /\bsearch\s+(?:my|all|the)\s+(?:files|documents|folder)\s+for\s+(.+?)\s*$/i,
    /\b(?:about|on)\s+(.+?)\s*$/i,
  ];
  for (const re of contentShapes) {
    const m = input.match(re);
    if (m && m[1] && m[1].trim()) return { type: 'content', query: m[1].trim().replace(/[.?!]+$/, '') };
  }
  const nameShape = input.match(/\b(?:named\s+like|matching)\s+(.+?)\s*$/i);
  if (nameShape && nameShape[1].trim()) return { type: 'name', query: nameShape[1].trim() };
  return null;
}

/** Absolute paths of the project's files, reusing the tool layer's ignore-dirs walk. */
async function projectFiles(root) {
  return walkDir(root);
}

/** Case-insensitive plain-substring content scan; no regex, zero ReDoS surface. */
async function searchContents(root, files, needle) {
  const hits = [];
  for (const file of files) {
    if (hits.length >= MAX_RESULTS) break;
    if (!isTextFile(file)) continue;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (size > MAX_CONTENT_FILE_BYTES) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_RESULTS; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path: path.relative(root, file).replace(/\\/g, '/'), line: i + 1, text: lines[i].trim().substring(0, 120) });
      }
    }
  }
  return hits;
}

async function handleFind(ws, action, input, project, sessionContext) {
  const parsed = extractFindQuery(input);
  if (!parsed) {
    answer(ws, `I can search by **file name** or **content** — try \`find files matching report\`, \`search my files for budget\`, or \`search for rent in my files\`.`);
    return true;
  }
  const files = await projectFiles(project.path);
  const needle = parsed.query.toLowerCase();

  if (parsed.type === 'name') {
    const matches = files
      .map((f) => path.relative(project.path, f).replace(/\\/g, '/'))
      .filter((rel) => rel.toLowerCase().includes(needle) || path.basename(rel).toLowerCase().includes(needle))
      .slice(0, MAX_RESULTS);
    answer(ws, matches.length
      ? `Found ${matches.length === MAX_RESULTS ? 'at least ' + MAX_RESULTS : matches.length} file${matches.length === 1 ? '' : 's'} matching **${parsed.query}**:\n\n${matches.map((m) => `- \`${m}\``).join('\n')}`
      : `No files matching **${parsed.query}** in **[${project.name}]**.`);
    return true;
  }

  const hits = await searchContents(project.path, files, needle);
  if (hits.length === 0) {
    answer(ws, `No file contents match **${parsed.query}** in **[${project.name}]**.`);
    return true;
  }
  const lines = hits.map((h) => `- \`${h.path}:${h.line}\` — ${h.text}`);
  const more = hits.length === MAX_RESULTS ? '\n\n*More results are capped at ' + MAX_RESULTS + ' — narrow the search to see the rest.*' : '';
  answer(ws, `${hits.length === 1 ? '1 file contains' : hits.length + ' files contain'} **${parsed.query}**:\n\n${lines.join('\n')}${more}`);
  return true;
}

/** Builds the tidy move plan (relative paths). Returns { moves, skipped } or { error }. */
export function planTidy(root, input) {
  const byDate = /\bby\s+(?:date|year|month)\b|\borganize\s+by\s+(?:year|month)\b/i.test(input);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return { error: `Could not read the folder: ${err.message}` };
  }
  const moves = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name === 'console.config.json') continue;
    let destDir;
    if (byDate) {
      const st = fs.statSync(path.join(root, entry.name), { throwIfNoEntry: false });
      if (!st) continue;
      const d = new Date(st.mtimeMs);
      destDir = byDate && /\bby\s+month\b|\borganize\s+by\s+month\b/i.test(input)
        ? String(d.getFullYear()) + '/' + String(d.getMonth() + 1).padStart(2, '0')
        : String(d.getFullYear());
    } else {
      const cat = EXT_TO_CATEGORY.get(path.extname(entry.name).toLowerCase());
      if (!cat) continue;
      destDir = CATEGORY_LABEL[cat];
    }
    // Never re-move a file already living in one of our own category/date folders.
    const parent = path.basename(path.dirname(path.join(root, entry.name)));
    if (Object.values(CATEGORY_LABEL).includes(parent) || /^\d{4}(?:\/\d{2})?$/.test(parent)) continue;
    // Forward-slash `to` (like findDuplicates' rel paths): consistent previews, journal entries
    // and revert messages on every platform; path.resolve still resolves it on win32.
    moves.push({ from: entry.name, to: path.join(destDir, entry.name).replace(/\\/g, '/') });
    if (moves.length >= MAX_TIDY_MOVES) break;
  }
  return { moves };
}

export async function performTidy(root, moves) {
  const resolveSafe = createResolveSafe(root);
  let moved = 0;
  for (const m of moves) {
    let fromAbs, toAbs;
    try {
      fromAbs = resolveSafe(m.from);
      toAbs = resolveSafe(m.to);
    } catch (err) {
      return { ok: false, error: err.message, moved };
    }
    try {
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      fs.renameSync(fromAbs, toAbs);
      appendAction(root, {
        type: 'file_move',
        description: `Moved ${m.from} -> ${m.to}`,
        from: m.from,
        to: m.to,
      });
      moved++;
    } catch (err) {
      return { ok: false, error: `Move of ${m.from} failed: ${err.message}`, moved };
    }
  }
  return { ok: true, moved };
}

async function handleTidy(ws, action, input, project, sessionContext) {
  const { moves, error } = planTidy(project.path, input);
  if (error) {
    answer(ws, error);
    return true;
  }
  if (moves.length === 0) {
    answer(ws, `Nothing to tidy in **[${project.name}]** — the folder's files are already organized (or none match the media/document categories).`);
    return true;
  }
  const preview = moves.slice(0, MAX_PREVIEW_LINES).map((m) => `  ${m.from} -> ${m.to}`).join('\n');
  const more = moves.length > MAX_PREVIEW_LINES ? `\n  …and ${moves.length - MAX_PREVIEW_LINES} more` : '';
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId: project.id,
    command: `tidy ${moves.length} file(s) in ${project.name}`,
    trigger: input,
    createdAt: Date.now(),
    generalFileOp: { kind: 'tidy', moves },
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: `Move ${moves.length} file(s) into subfolders?\n\n${preview}${more}\n\nThis is reversible via "revert action <id>" after it runs.`,
    trigger: 'general_files_tidy',
  }));
  return true;
}

/** sha256 duplicate groups over the project files. Returns { groups, skippedBig, totalWasted } */
export async function findDuplicates(root) {
  const groups = new Map(); // hash -> [{path, size, mtime}]
  let skippedBig = 0;
  let scanned = 0;
  const files = await walkDir(root);
  for (const file of files) {
    if (scanned >= MAX_HASH_FILES) break;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.size === 0 || st.size > MAX_HASH_FILE_BYTES) { if (st.size > MAX_HASH_FILE_BYTES) skippedBig++; continue; }
    let hash;
    try {
      hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch { continue; }
    scanned++;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push({ path: rel, size: st.size, mtime: st.mtimeMs });
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  const totalWasted = dupGroups.reduce((sum, g) => sum + g[0].size * (g.length - 1), 0);
  return { groups: dupGroups, skippedBig, totalWasted };
}

async function handleDuplicates(ws, action, input, project, sessionContext) {
  const { groups, skippedBig, totalWasted } = await findDuplicates(project.path);
  if (groups.length === 0) {
    answer(ws, `No duplicate files found in **[${project.name}]**.`);
    return true;
  }
  const shown = groups.slice(0, MAX_RESULTS);
  const lines = shown.map((g, i) => {
    const kb = Math.max(1, Math.round(g[0].size / 1024));
    return `${i + 1}. **${g.length} copies of ${kb}KB**\n${g.map((f) => `   - \`${f.path}\``).join('\n')}`;
  });
  const more = groups.length > MAX_RESULTS ? `\n\n…and ${groups.length - MAX_RESULTS} more duplicate groups.` : '';
  const bigNote = skippedBig > 0 ? `\n\n*${skippedBig} file(s) over 50MB were skipped.*` : '';
  answer(ws, `Found **${groups.length} duplicate group${groups.length === 1 ? '' : 's'}** in **[${project.name}]** (${totalWasted > 0 ? `~${Math.max(1, Math.round(totalWasted / 1024))}KB wasted` : 'no measurable waste'}):\n\n${lines.join('\n\n')}${more}${bigNote}\n\nTo delete the older copies, say \`delete duplicates, keep newest\`.`);
  return true;
}

/** Keep-newest selection: for each group, the file(s) to delete = every member but the newest. */
export async function planDuplicateDeletes(root) {
  const { groups } = await findDuplicates(root);
  const deletes = [];
  for (const g of groups) {
    const newest = g.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    for (const f of g) if (f.path !== newest.path) deletes.push(f.path);
  }
  return deletes;
}

export async function performDuplicateDeletes(root, files) {
  const resolveSafe = createResolveSafe(root);
  let deleted = 0;
  let skippedJournal = 0;
  for (const rel of files) {
    let abs;
    try {
      abs = resolveSafe(rel);
    } catch (err) {
      return { ok: false, error: err.message, deleted, skippedJournal };
    }
    let preContent = null;
    try {
      const st = fs.statSync(abs);
      if (st.size <= MAX_PREIMAGE_BYTES) preContent = fs.readFileSync(abs, 'utf-8');
    } catch {
      return { ok: false, error: `Could not read ${rel} before deleting.`, deleted, skippedJournal };
    }
    try {
      fs.rmSync(abs, { force: true });
    } catch (err) {
      return { ok: false, error: `Delete of ${rel} failed: ${err.message}`, deleted, skippedJournal };
    }
    if (preContent === null) {
      // Same convention as tools.js wrapMutatingTool: files too large for an inline pre-image
      // are skipped in the history log rather than logged without a restore source.
      skippedJournal++;
    } else {
      appendAction(root, { type: 'file_write', description: `Deleted duplicate ${rel}`, path: rel, existed: true, preContent });
    }
    deleted++;
  }
  return { ok: true, deleted, skippedJournal };
}

async function handleDuplicatesDelete(ws, action, input, project, sessionContext) {
  const files = await planDuplicateDeletes(project.path);
  if (files.length === 0) {
    answer(ws, `No duplicate files found in **[${project.name}]** — nothing to delete.`);
    return true;
  }
  const preview = files.slice(0, MAX_PREVIEW_LINES).map((f) => `  - ${f}`).join('\n');
  const more = files.length > MAX_PREVIEW_LINES ? `\n  …and ${files.length - MAX_PREVIEW_LINES} more` : '';
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId: project.id,
    command: `delete ${files.length} duplicate file(s) in ${project.name}`,
    trigger: input,
    createdAt: Date.now(),
    generalFileOp: { kind: 'duplicates_delete', files },
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: `Delete ${files.length} duplicate file(s), keeping the newest copy of each group?\n\n${preview}${more}\n\nThe newest copy in each group is kept. Reversible via "revert action <id>" after it runs.`,
    trigger: 'general_files_duplicates_delete',
  }));
  return true;
}

export const generalFileHandlers = {
  'general.files.find': handleFind,
  'general.files.tidy': handleTidy,
  'general.files.duplicates': handleDuplicates,
  'general.files.duplicates_delete': handleDuplicatesDelete,
};
