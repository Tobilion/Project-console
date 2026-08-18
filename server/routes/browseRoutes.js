// Phase T2 (2026-08-14): arbitrary-folder browsing for the Folder Explorer panel — the
// General-mode gap: File Tools is project-scoped, so there was no way to browse a folder
// that isn't a scanned project. Listing + reveal only, deliberately: opening files goes
// through the chat intents (open_with / open_html) so the terminal stays the single source
// of truth. The path guard here is absolute-path + exists + is-directory — no shell, no
// project sandbox (this is the user's own machine and the same trust model as the scan box).
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { asyncHandler } from '../asyncHandler.js';

const MAX_BROWSE_ENTRIES = 2000;

function isValidBrowsePath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  // Windows drive paths (C:\...), UNC (\\server\share), POSIX absolute (/...). The
  // folder picker limitation (browser can't hand over absolute paths) is documented in
  // the panel — pasting is the supported path, same as the scan box.
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

export function registerBrowseRoutes(app) {
  // Directory listing of any absolute path. Entries are sorted folders-first then by name
  // (same convention as fileToolsRoutes listEntries); dotfiles are included (the explorer
  // panel shows everything, unlike the project-scoped file browser which skips them).
  app.get('/api/browse', asyncHandler(async (req, res) => {
    const raw = req.query.path;
    if (!isValidBrowsePath(raw)) {
      return res.status(400).json({ error: 'Browse requires an absolute path (e.g. C:\\Users\\you\\Documents).' });
    }
    const dir = path.resolve(raw);
    let st;
    try { st = fs.statSync(dir); } catch { return res.status(404).json({ error: `Folder not found: ${dir}` }); }
    if (!st.isDirectory()) return res.status(400).json({ error: 'Not a folder.' });

    const entries = [];
    try {
      for (const name of fs.readdirSync(dir)) {
        if (entries.length >= MAX_BROWSE_ENTRIES) break;
        const p = path.join(dir, name);
        let es;
        try { es = fs.statSync(p); } catch { continue; }
        entries.push({
          name,
          path: p,
          isDir: es.isDirectory(),
          size: es.isDirectory() ? 0 : es.size,
          modifiedAt: es.mtimeMs,
        });
      }
    } catch {
      return res.status(500).json({ error: 'Could not read the folder.' });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: dir, entries });
  }));

  // Reveal any absolute file/folder in the OS file explorer (explorer /select on Windows,
  // open -R on macOS, xdg-open fallback) — the Folder Explorer's "Reveal in folder" action.
  app.post('/api/browse/reveal', asyncHandler(async (req, res) => {
    const raw = req.body?.path;
    if (!isValidBrowsePath(raw)) {
      return res.status(400).json({ error: 'Reveal requires an absolute path.' });
    }
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: `Not found: ${abs}` });
    try {
      if (process.platform === 'win32') {
        // explorer.exe always exits with code 1 even on success; detached so it outlives us.
        spawn('explorer.exe', [`/select,${abs}`], { detached: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', ['-R', abs], { detached: true }).unref();
      } else {
        spawn('xdg-open', [path.dirname(abs)], { detached: true }).unref();
      }
    } catch (err) {
      return res.status(500).json({ error: `Could not open the folder: ${err.message}` });
    }
    res.json({ success: true });
  }));

  // Open any absolute file (or folder) in its OS default app — file association on Windows
  // (start), open on macOS, xdg-open on Linux. The Folder Explorer's double-click/Enter
  // action: "open in default app" is deliberately a direct endpoint here (no chat intent
  // needed — the panel already lives in the terminal's confirm-free zone for read-only
  // ops, and opening a file in its associated app is the same trust level as reveal).
  app.post('/api/browse/open', asyncHandler(async (req, res) => {
    const raw = req.body?.path;
    if (!isValidBrowsePath(raw)) {
      return res.status(400).json({ error: 'Open requires an absolute path.' });
    }
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: `Not found: ${abs}` });
    // cmd.exe re-parses the command line it receives: `&`, `|`, `<`, `>`, `^` and `"` are
    // meaningful to the shell even inside a quoted argument, so a path containing any of them
    // would be reinterpreted as new commands. None of these are legal in a Windows filename,
    // and the macOS/Linux branches pass the path as a single argv element, so the same guard
    // is a harmless no-op there.
    if (/[&|<>^"\x00-\x1f]/.test(abs)) {
      return res.status(400).json({ error: 'Path contains characters that cannot be opened safely.' });
    }
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', abs], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [abs], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (err) {
      return res.status(500).json({ error: `Could not open: ${err.message}` });
    }
    res.json({ success: true });
  }));
}
