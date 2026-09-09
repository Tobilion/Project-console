import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { walkDir } from '../../toolScan.js';
import { createResolveSafe } from '../../toolSandbox.js';
import { pendingConfirmations } from '../../state.js';
import { appendAction } from '../../actionHistory.js';
import { answer } from '../../wsReply.js';
import { MAX_RESULTS, MAX_HASH_FILES, MAX_HASH_FILE_BYTES, MAX_PREIMAGE_BYTES, MAX_PREVIEW_LINES } from './constants.js';

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

export { handleDuplicates, handleDuplicatesDelete };