import { listSessions, getSession, createSession, deleteSession, renameSession, linkSessionToProject } from '../conversationStore.js';
import { readIndex } from '../sessionIndex.js';
import { readFullSessionHistory, formatExportMarkdown, formatExportJson } from '../sessionExport.js';
import { resolveProject, getTabWorkspace, state } from '../state.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerSessionRoutes(app) {
  app.get('/api/sessions', asyncHandler(async (req, res) => {
    const sessions = await listSessions();
    res.json({ sessions });
  }));

  app.post('/api/sessions', asyncHandler(async (req, res) => {
    const { projectId, projectName } = req.body || {};
    // Phase T (2026-08-14): resolve inside the requesting tab's workspace so a session
    // created from a second tab's project list captures THAT folder's path.
    const project = projectId ? resolveProject(projectId, req.query.tab) : null;
    // Per-chat workspace memory: remember which scan root this chat was created in (the tab's
    // workspace, or the global default when the tab id is absent / the default tab) so a
    // sidebar click can switch the app back to that location — including General chats, which
    // have no projectPath to route by.
    const ws = req.query.tab ? getTabWorkspace(req.query.tab) : null;
    const workspacePath = ws?.scanDirectory || state.currentScanDirectory || null;
    const session = await createSession(projectId, projectName, project?.path, workspacePath);
    res.json({ session });
  }));

  app.get('/api/sessions/:id', asyncHandler(async (req, res) => {
    // Phase 6 (2026-08-17): pagination — ?before=<N> skips the N newest messages (the page
    // the client already holds), ?limit=<N> sizes the page (1..500, default 200 — existing
    // clients without the params get exactly the old last-200 shape). `total` rides along so
    // the client can show "load earlier" until it has everything; the index's messageCount is
    // maintained on every append (sessionIndex.js), so no extra file read is needed.
    const before = Math.max(0, parseInt(req.query.before ?? '0', 10) || 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '200', 10) || 200, 1), 500);
    const session = await getSession(req.params.id, { limit, before });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const idx = await readIndex();
    const total = idx[req.params.id]?.messageCount ?? session.messages.length;
    res.json({ session, total });
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
