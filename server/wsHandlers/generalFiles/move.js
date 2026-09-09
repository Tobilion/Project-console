import fs from 'fs';
import path from 'path';
import { createResolveSafe } from '../../toolSandbox.js';
import { appendAction } from '../../actionHistory.js';
import { answer } from '../../wsReply.js';
import { queueGeneralOp } from './queue.js';

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

export { handleMove };