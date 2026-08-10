import { listSessions, getSession, createSession, deleteSession, renameSession, linkSessionToProject } from '../conversationStore.js';
import { readIndex } from '../sessionIndex.js';
import { readFullSessionHistory, formatExportMarkdown, formatExportJson } from '../sessionExport.js';
import { state } from '../state.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerSessionRoutes(app) {
  app.get('/api/sessions', asyncHandler(async (req, res) => {
    const sessions = await listSessions();
    res.json({ sessions });
  }));

  app.post('/api/sessions', asyncHandler(async (req, res) => {
    const { projectId, projectName } = req.body || {};
    const project = projectId ? state.activeProjectsCache.find((p) => p.id === projectId) : null;
    const session = await createSession(projectId, projectName, project?.path);
    res.json({ session });
  }));

  app.get('/api/sessions/:id', asyncHandler(async (req, res) => {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  }));

  // Complete-session export (Phase 0): the FULL persisted NDJSON history, not the 200-message
  // reload cap getSession applies. The frontend downloads this blob and renames it client-side;
  // the server just serves the formatted text (no temp file, nothing for Vite's watcher to see).
  app.get('/api/sessions/:id/export', asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const idx = await readIndex();
    const meta = idx[sessionId];
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    const entries = await readFullSessionHistory(sessionId) || [];
    if (req.query.format === 'json') {
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.send(JSON.stringify(formatExportJson(entries, meta), null, 2));
    } else {
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.send(formatExportMarkdown(entries, meta));
    }
  }));

  // Rename a chat (manual title; the auto-title from the first message never clobbers it)
  app.patch('/api/sessions/:id', asyncHandler(async (req, res) => {
    const { title } = req.body || {};
    const session = await renameSession(req.params.id, title);
    if (!session) return res.status(400).json({ error: 'Invalid title or session not found' });
    res.json({ session });
  }));

  // Link an orphan session to a project (e.g. after New Chat then selecting a project)
  app.patch('/api/sessions/:id/link', asyncHandler(async (req, res) => {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const session = await linkSessionToProject(req.params.id, projectId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  }));

  app.delete('/api/sessions/:id', asyncHandler(async (req, res) => {
    const ok = await deleteSession(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  }));
}
