import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createResolveSafe } from '../../toolSandbox.js';
import { pendingConfirmations } from '../../state.js';
import { appendAction } from '../../actionHistory.js';
import { answer } from '../../wsReply.js';
import { MAX_TIDY_MOVES, MAX_PREVIEW_LINES, EXT_TO_CATEGORY, CATEGORY_LABEL } from './constants.js';

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

export { handleTidy };