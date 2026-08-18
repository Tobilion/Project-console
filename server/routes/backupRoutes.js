// Phase 9 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Backup panel — read-only
// backup listing + download. Creating a backup goes through the normal WS trigger-command
// path ("backup this folder") so journaling and answers stay in the terminal.
import fs from 'fs';
import path from 'path';
import { resolveProject } from '../state.js';
import { listBackups, backupsDir } from '../backupStore.js';

export function registerBackupRoutes(app) {
  // List the project's backups, newest first — for the panel's Time Machine-style list.
  app.get('/api/projects/:id/backups', (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ backups: listBackups(project) });
  });

  // Project subdirectories for the panel's subfolder picker (one level, relative paths).
  app.get('/api/projects/:id/folders', (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const folders = [];
    try {
      for (const name of fs.readdirSync(project.path)) {
        const p = path.join(project.path, name);
        try {
          if (fs.statSync(p).isDirectory() && !name.startsWith('.')) folders.push(name);
        } catch {}
      }
    } catch {}
    folders.sort((a, b) => a.localeCompare(b));
    res.json({ folders });
  });

  // Download one backup by name — basename-validated so the lookup stays inside the
  // backups dir (same pattern as the workspace-export download).
  app.get('/api/projects/:id/backup-file', (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const prefix = `${(project.folderName || project.id || 'project').replace(/[^a-z0-9_-]/gi, '-')}-`;
    if (!name || path.basename(name) !== name || !name.startsWith(prefix) || !name.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid backup name.' });
    }
    const file = path.join(backupsDir(), name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Backup not found.' });
    res.download(file, name);
  });
}
