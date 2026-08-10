import fs from 'fs';
import path from 'path';
import { discoverProjects } from '../projectScanner.js';
import { indexProject } from '../codebaseIndexer.js';
import { semanticMatcher } from '../semanticMatcher.js';
import { nlpEngine } from '../nlpEngine.js';
import { setupMockProjectsIfMissing } from '../mockProjects.js';
import { state, projectsMutex } from '../state.js';
import { broadcast } from '../wsServer.js';
import { asyncHandler } from '../asyncHandler.js';
import { projectChatLogPath } from '../sessionExport.js';
import { listActions } from '../actionHistory.js';

// A plain browser tab (not Electron/Tauri) can never receive an absolute host filesystem path
// from <input type="file" webkitdirectory> — that's a deliberate File API restriction, not a
// bug. The frontend's native "Browse for folder" button can only recover the *folder name*
// (via webkitRelativePath's first segment), so when a bare name (no drive letter / no leading
// slash) comes in here, search a small set of likely roots for a directory with that name
// instead of failing outright. This covers the common case (folder lives under the current
// scan root or its parent, e.g. anything under `C:\Users\<you>\Desktop`) without pretending to
// be a full arbitrary-path picker, which a plain web page fundamentally cannot be.
function looksAbsolute(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

function resolveScanTarget(candidate) {
  const trimmed = candidate.trim();
  if (looksAbsolute(trimmed)) return trimmed;

  const roots = [
    path.dirname(state.currentScanDirectory),
    state.currentScanDirectory,
  ];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const match = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === trimmed.toLowerCase());
      if (match) return path.join(root, match.name);
    } catch {
      // root doesn't exist or isn't readable — try the next one
    }
  }
  return null;
}

export function registerProjectRoutes(app, dirname) {
  // Current project list, scanned from state.currentScanDirectory
  app.get('/api/projects', asyncHandler(async (req, res) => {
    const dirToScan = setupMockProjectsIfMissing(state.currentScanDirectory, dirname);
    const projects = await discoverProjects(dirToScan);
    await projectsMutex.runExclusive(async () => {
      state.activeProjectsCache = projects;
    });
    semanticMatcher.clearProjectIntents().catch(() => {});
    semanticMatcher.addProjectIntents(projects).catch(() => {});
    res.json({
      scanPath: state.currentScanDirectory,
      projects
    });
  }));

  // Change the directory being scanned and rescan it. This is the endpoint the
  // frontend's "Scan" box actually calls (see src/App.tsx handleScan). Wrapped in
  // asyncHandler: a POST without a JSON body leaves req.body undefined, and the
  // destructure used to throw before the handler's own try/catch ever saw it — an
  // unwrapped async rejection that hung the request (audit 2026-08-06, Phase 2).
  app.post('/api/scan-path', asyncHandler(async (req, res) => {
    const { path: newPath } = req.body || {};

    if (!newPath || typeof newPath !== 'string' || newPath.trim() === '') {
      return res.status(400).json({ success: false, error: 'Directory path is required.' });
    }

    const sanitizedPath = newPath.trim();

    let resolvedPath = sanitizedPath;
    if (!looksAbsolute(sanitizedPath)) {
      const found = resolveScanTarget(sanitizedPath);
      if (!found) {
        return res.status(400).json({
          success: false,
          error: `Couldn't find a folder named "${sanitizedPath}" automatically. Browser folder pickers ` +
            `can't reveal a full path for security reasons — please paste the complete path instead ` +
            `(e.g. C:\\Users\\you\\Desktop\\${sanitizedPath}).`,
        });
      }
      resolvedPath = found;
    }

    try {
      // Move the mock-seed inside the try too — it does filesystem work that can throw, and
      // previously sat outside the handler's only guard (audit 2026-08-06, Phase 2).
      const effectivePath = setupMockProjectsIfMissing(resolvedPath, dirname);
      const projects = await discoverProjects(effectivePath);
      state.currentScanDirectory = resolvedPath;
      await projectsMutex.runExclusive(async () => {
        state.activeProjectsCache = projects;
      });

      res.json({
        success: true,
        scanPath: state.currentScanDirectory,
        projects
      });

      nlpEngine.train(projects).catch((err) => {
        console.error('Background NLP retrain failed:', err.message);
      });
      semanticMatcher.clearProjectIntents().catch(() => {});
      semanticMatcher.addProjectIntents(projects).catch(() => {});
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }));

  // Re-index a specific project's codebase and broadcast the update to connected clients.
  app.post('/api/projects/:id/index', asyncHandler(async (req, res) => {
    const project = state.activeProjectsCache.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const idx = await indexProject(project.path);
    project.codebaseIndex = idx;
    broadcast({ type: 'project_updated', data: project });
    res.json({ success: true, codebaseIndex: idx });
  }));

  // Phase 4: action history for the ProcessDock History tab (most-recent-first, capped).
  app.get('/api/projects/:id/action-history', asyncHandler(async (req, res) => {
    const project = state.activeProjectsCache.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '30', 10) || 30, 1), 200);
    res.json({ actions: listActions(project.path, { limit }) });
  }));

  // "Export whole project" (Phase 0): direct download of the project's existing
  // .console/chat-log.md — already a complete human-readable transcript of every session in
  // that project (chatLog.js), no generation logic needed here, just exposure.
  app.get('/api/projects/:id/chat-log', asyncHandler(async (req, res) => {
    const project = state.activeProjectsCache.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const logPath = await projectChatLogPath(project.path);
    if (!logPath) return res.status(404).json({ error: 'No chat log yet for this project — send a message first.' });
    // folderName is a real Windows filesystem name (cannot contain / " etc.), safe as a
    // Content-Disposition filename.
    res.download(logPath, `${project.folderName}-chat-log.md`);
  }));
}
