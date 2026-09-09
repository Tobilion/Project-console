import fs from 'fs';
import path from 'path';
import { createResolveSafe } from '../../toolSandbox.js';
import { appendAction } from '../../actionHistory.js';
import { answer } from '../../wsReply.js';
import { queueGeneralOp } from './queue.js';

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

export { handleRename };