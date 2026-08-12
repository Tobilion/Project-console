// Phase 9 (UPGRADE-ROADMAP.md, 2026-08-12): trigger handlers for backups. Creating a zip is
// read-only w.r.t. the source (no confirm gate) but journals the created file through
// appendAction so it appears in "recent actions" and `revert action <id>` deletes it.
// The answer carries the absolute path (CLI-usable) plus a markdown download link (web).
import path from 'path';
import { createBackup, listBackups } from '../backupStore.js';
import { appendAction } from '../actionHistory.js';

const answer = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data }));

function downloadLink(projectId, fileName) {
  return `/api/projects/${encodeURIComponent(projectId)}/backup-file?name=${encodeURIComponent(fileName)}`;
}

export const backupHandlers = {
  'backup.create': async (ws, action, input, project) => {
    // Optional subfolder: "backup the src folder" / "zip the data directory".
    const subMatch = input.match(/(?:backup|zip|export)\s+(?:the\s+)?([\w./-]+)\s+(?:folder|directory|subfolder)?\s*(?:as\s+a\s+zip)?$/i);
    let subPath = null;
    if (subMatch && subMatch[1] && !/^(this|my|the|project|folder|it|everything)$/i.test(subMatch[1])) {
      subPath = subMatch[1].replace(/[\\/]+$/, '');
    }
    const result = await createBackup(project, subPath);
    if (!result.ok) {
      answer(ws, result.error);
      return;
    }
    const rel = result.relPath === '.' ? project.name : result.relPath;
    // Journal the created zip (file_write, existed:false) — revert action <id> deletes it.
    // NOTE: the zip lives in data/backups (outside the project), so the journaled path is
    // `backups/<name>.zip` — the revert path below special-cases that prefix to the backups
    // dir; the generic file_write revert (which resolves inside the project) would miss it.
    try {
      const relFile = `backups/${path.basename(result.file)}`;
      await appendAction(project.path, {
        type: 'file_write',
        path: relFile,
        existed: false,
        preContent: null,
      });
    } catch {}
    const sizeMb = (result.size / 1024 / 1024).toFixed(1);
    answer(ws, `Backup created — **${rel}** zipped (${sizeMb} MB).\n\n**Path:** \`${result.file}\`\n\n[download the zip](${downloadLink(project.id, path.basename(result.file))})\n\nDelete it anytime with \`revert action <id>\` (it shows in "recent actions").`);
  },

  'backup.list': async (ws, action, input, project) => {
    const backups = listBackups(project);
    if (backups.length === 0) {
      answer(ws, 'No backups yet for this project. Try `backup this folder`.');
      return;
    }
    const rows = backups.map((b, i) => {
      const d = new Date(b.mtime);
      return `${i + 1}. **${b.name}** — ${(b.size / 1024 / 1024).toFixed(1)} MB, ${d.toLocaleString()}`;
    });
    answer(ws, `### Backups (${backups.length})\n\n${rows.join('\n')}\n\nCreate one with \`backup this folder\`.`);
  },
};
