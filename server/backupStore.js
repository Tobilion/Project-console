// Phase 9 (UPGRADE-ROADMAP.md, 2026-08-12): backup/export a project folder to a timestamped
// zip. Follows workspaceTransfer.js's conventions (gitignored output location, absolute path
// + download link in the answer, size cap) but zips arbitrary project content rather than the
// workspace bundle format. Zipping is read-only w.r.t. the source (nothing modified/deleted),
// so no risky-command confirm gate — but every created zip IS journaled through appendAction
// (file_write, existed: false) so it shows in "recent actions" and `revert action <id>`
// deletes it.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// archiver is CommonJS — the project's other CJS deps (ws, chrono-node, pdf-lib) resolve
// through createRequire for the same reason.
const require = createRequire(import.meta.url);
const archiver = require('archiver');

const BACKUPS_DIR = path.join(process.cwd(), 'data', 'backups');

// Consistent order of magnitude with workspaceTransfer.js's 50MB bundle cap — raw files (not
// JSON), so the same 50MB ceiling is the honest bound; anything over is refused outright.
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

// Skip the usual suspects so a backup isn't a node_modules/.git/.console mirror.
const IGNORE_DIRS = new Set(['node_modules', '.git', '.console', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv']);

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Zip a project (or a named subfolder within it) into data/backups/. Returns
 *  { ok, file, relPath, size } or { ok: false, error }. */
export async function createBackup(project, subPath) {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  } catch {
    return { ok: false, error: 'Could not create the backups directory.' };
  }

  const root = project.path;
  let target = root;
  if (subPath && subPath !== '.') {
    target = path.resolve(root, subPath);
    if (!isInside(root, target) || !fs.existsSync(target)) {
      return { ok: false, error: `Subfolder not found inside the project: ${subPath}` };
    }
  }

  // Size guard before zipping — walk the target tree and refuse over the cap.
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (IGNORE_DIRS.has(name)) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { stack.push(p); continue; }
      total += st.size;
      if (total > MAX_BACKUP_BYTES) {
        return { ok: false, error: `Folder is over the ${Math.round(MAX_BACKUP_BYTES / 1024 / 1024)}MB backup cap — pick a subfolder or remove large files first.` };
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = (project.folderName || project.id || 'project').replace(/[^a-z0-9_-]/gi, '-');
  const file = path.join(BACKUPS_DIR, `${safeName}-${stamp}.zip`);
  const relPath = path.relative(root, target) || '.';

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(file);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      // Preserve the folder structure inside the zip: the root entry is the target's basename.
      archive.directory(target, relPath === '.' ? path.basename(target) : relPath);
      archive.finalize();
    });
  } catch {
    try { fs.unlinkSync(file); } catch {}
    return { ok: false, error: 'Zipping failed — check disk space and folder permissions.' };
  }

  const st = fs.statSync(file);
  return { ok: true, file, relPath, size: st.size };
}

/** Existing backups for a project, newest first: [{ file, name, size, mtime }]. */
export function listBackups(project) {
  const prefix = `${(project.folderName || project.id || 'project').replace(/[^a-z0-9_-]/gi, '-')}-`;
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return [];
    return fs.readdirSync(BACKUPS_DIR)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.zip'))
      .map((name) => {
        const p = path.join(BACKUPS_DIR, name);
        let st;
        try { st = fs.statSync(p); } catch { return null; }
        return { file: p, name, size: st.size, mtime: st.mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export function backupsDir() {
  return BACKUPS_DIR;
}
