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
  const actionIds = []; // journal ids, one per move — the undo toast's batch revert consumes them
  for (const m of moves) {
    let fromAbs, toAbs;
    try {
      fromAbs = resolveSafe(m.from);
      toAbs = resolveSafe(m.to);
    } catch (err) {
      return { ok: false, error: err.message, moved, actionIds };
    }
    try {
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      fs.renameSync(fromAbs, toAbs);
      const id = appendAction(root, {
        type: 'file_move',
        description: `Moved ${m.from} -> ${m.to}`,
        from: m.from,
        to: m.to,
      });
      if (id) actionIds.push(id);
      moved++;
    } catch (err) {
      return { ok: false, error: `Move of ${m.from} failed: ${err.message}`, moved, actionIds };
    }
  }
  return { ok: true, moved, actionIds };
}

async function handleTidy(ws, action, input, project, sessionContext) {
  // Phase 2 audit (2026-08-12): the File Tools panel's move-preview table lets the user
  // exclude individual moves before confirming — it sends `tidy this folder: a.txt, b.txt`
  // (a colon + comma-separated file names after the verb), and the plan is filtered to just
  // those files. Plain "tidy this folder" keeps the full-plan behavior.
  const listMatch = input.match(/:\s*([\w.,\s-]+)$/);
  let onlyFiles = null;
  if (listMatch) {
    onlyFiles = listMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  const { moves, error } = planTidy(project.path, input.replace(/:\s*[\w.,\s-]+$/, ''));
  if (error) {
    answer(ws, error);
    return true;
  }
  const filtered = onlyFiles && onlyFiles.length > 0
    ? moves.filter((m) => onlyFiles.includes(m.from))
    : moves;
  if (filtered.length === 0) {
    answer(ws, `Nothing to tidy in **[${project.name}]** — the folder's files are already organized (or none match the media/document categories).`);
    return true;
  }
  const preview = filtered.slice(0, MAX_PREVIEW_LINES).map((m) => `  ${m.from} -> ${m.to}`).join('\n');
  const more = filtered.length > MAX_PREVIEW_LINES ? `\n  …and ${filtered.length - MAX_PREVIEW_LINES} more` : '';
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId: project.id,
    command: `tidy ${filtered.length} file(s) in ${project.name}`,
    trigger: input,
    createdAt: Date.now(),
    generalFileOp: { kind: 'tidy', moves: filtered },
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: `Move ${filtered.length} file(s) into subfolders?\n\n${preview}${more}\n\nThis is reversible via "revert action <id>" after it runs.`,
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
  const actionIds = []; // journal ids — the undo toast's batch revert restores the deleted copies
  for (const rel of files) {
    let abs;
    try {
      abs = resolveSafe(rel);
    } catch (err) {
      return { ok: false, error: err.message, deleted, skippedJournal, actionIds };
    }
    let preContent = null;
    try {
      const st = fs.statSync(abs);
      if (st.size <= MAX_PREIMAGE_BYTES) preContent = fs.readFileSync(abs, 'utf-8');
    } catch {
      return { ok: false, error: `Could not read ${rel} before deleting.`, deleted, skippedJournal, actionIds };
    }
    try {
      fs.rmSync(abs, { force: true });
    } catch (err) {
      return { ok: false, error: `Delete of ${rel} failed: ${err.message}`, deleted, skippedJournal, actionIds };
    }
    if (preContent === null) {
      // Same convention as tools.js wrapMutatingTool: files too large for an inline pre-image
      // are skipped in the history log rather than logged without a restore source.
      skippedJournal++;
    } else {
      const id = appendAction(root, { type: 'file_write', description: `Deleted duplicate ${rel}`, path: rel, existed: true, preContent });
      if (id) actionIds.push(id);
    }
    deleted++;
  }
  return { ok: true, deleted, skippedJournal, actionIds };
}

async function handleDuplicatesDelete(ws, action, input, project, sessionContext) {
  // Phase 2 audit (2026-08-12): the File Tools panel's duplicates view has per-row checkboxes
  // — it sends `delete duplicates, keep newest: <file1, file2>` to delete only the selected
  // older copies. Plain "delete duplicates, keep newest" keeps the whole-plan behavior.
  const listMatch = input.match(/:\s*([\w.,\s/-]+)$/);
  let onlyFiles = null;
  if (listMatch) {
    onlyFiles = listMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  const all = await planDuplicateDeletes(project.path);
  const files = onlyFiles && onlyFiles.length > 0
    ? all.filter((f) => onlyFiles.includes(f))
    : all;
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
  'general.files.rename': handleRename,
  'general.files.move': handleMove,
};

/**
 * Phase 8 follow-up (2026-08-24): rename one file/folder within its directory. Same safety
 * shape as tidy/duplicates_delete — resolveSafe containment, confirm-gated, journaled as
 * `file_move` (from -> to) so `revert action <id>` moves it back. The new name must be a BARE
 * name in the same directory (cross-folder moves are the `move` intent), and an existing
 * target is refused (never overwrite — an overwritten file's pre-image can't be journaled).
 */
export async function performRename(root, from, to) {
  const resolveSafe = createResolveSafe(root);
  let absFrom, absTo;
  try {
    absFrom = resolveSafe(from);
    absTo = resolveSafe(to);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (path.dirname(absFrom) !== path.dirname(absTo)) {
    return { ok: false, error: 'Rename stays in the same folder — use "move X into Y" to move between folders.' };
  }
  if (!fs.existsSync(absFrom)) return { ok: false, error: `"${from}" doesn't exist.` };
  if (fs.existsSync(absTo)) return { ok: false, error: `"${to}" already exists — the console never overwrites.` };
  try {
    fs.renameSync(absFrom, absTo);
  } catch (err) {
    return { ok: false, error: `Rename failed: ${err.message}` };
  }
  const relFrom = path.relative(root, absFrom).replace(/\\/g, '/');
  const relTo = path.relative(root, absTo).replace(/\\/g, '/');
  const id = appendAction(root, { type: 'file_move', description: `Renamed ${relFrom} -> ${relTo}`, from: relFrom, to: relTo });
  return { ok: true, from: relFrom, to: relTo, actionIds: id ? [id] : [] };
}

/** Move one file/folder into an existing subfolder (drag-and-drop target). Journaled the same
 *  way as rename (file_move), refused when the target name is already taken. */
export async function performMove(root, file, targetDir) {
  const resolveSafe = createResolveSafe(root);
  let absFile, absDir;
  try {
    absFile = resolveSafe(file);
    absDir = resolveSafe(targetDir);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!fs.existsSync(absFile)) return { ok: false, error: `"${file}" doesn't exist.` };
  let dirStat;
  try { dirStat = fs.statSync(absDir); } catch { return { ok: false, error: `"${targetDir}" isn't a folder in this project.` }; }
  if (!dirStat.isDirectory()) return { ok: false, error: `"${targetDir}" isn't a folder.` };
  const absTo = path.join(absDir, path.basename(absFile));
  if (fs.existsSync(absTo)) return { ok: false, error: `"${path.basename(absFile)}" already exists in ${targetDir} — the console never overwrites.` };
  try {
    fs.renameSync(absFile, absTo);
  } catch (err) {
    return { ok: false, error: `Move failed: ${err.message}` };
  }
  const relFrom = path.relative(root, absFile).replace(/\\/g, '/');
  const relTo = path.relative(root, absTo).replace(/\\/g, '/');
  const id = appendAction(root, { type: 'file_move', description: `Moved ${relFrom} -> ${relTo}`, from: relFrom, to: relTo });
  return { ok: true, from: relFrom, to: relTo, actionIds: id ? [id] : [] };
}

function queueGeneralOp(ws, project, input, payload, commandText, trigger) {
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId: project.id,
    command: commandText,
    trigger: input,
    createdAt: Date.now(),
    generalFileOp: payload,
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: `${commandText}?\n\nReversible via "revert action <id>" after it runs.`,
    trigger,
  }));
  return true;
}

async function handleRename(ws, action, input, project, sessionContext) {
  const m = input.match(/^rename\s+(.+?)\s+(?:to|as)\s+([^\r\n]+)$/i);
  if (!m) {
    answer(ws, `Say \`rename <file> to <newname>\` — e.g. \`rename main.py to app.py\`. Use \`move <file> into <folder>\` to move between folders.`);
    return true;
  }
  const from = m[1].trim();
  const to = m[2].trim();
  // The new name must be a bare name — a path separator means "move", which has its own intent.
  if (/[\\/]/.test(to)) {
    answer(ws, `The new name must stay in the same folder — \`${to}\` looks like a path. Use \`move ${from} into <folder>\` instead.`);
    return true;
  }
  const targetDir = path.dirname(from);
  const toRel = targetDir === '.' ? to : `${targetDir}/${to}`;
  return queueGeneralOp(
    ws, project, input,
    { kind: 'rename', from, to: toRel },
    `Rename \`${from}\` to \`${to}\``,
    'general_files_rename',
  );
}

async function handleMove(ws, action, input, project, sessionContext) {
  const m = input.match(/^move\s+(.+?)\s+into\s+(.+?)$/i);
  if (!m) {
    answer(ws, `Say \`move <file> into <folder>\` — e.g. \`move main.py into src\`.`);
    return true;
  }
  const file = m[1].trim().replace(/^the\s+file\s+/i, '').trim();
  const targetDir = m[2].trim().replace(/^the\s+folder\s+/i, '').trim();
  return queueGeneralOp(
    ws, project, input,
    { kind: 'move', file, targetDir },
    `Move \`${file}\` into \`${targetDir}\``,
    'general_files_move',
  );
}
