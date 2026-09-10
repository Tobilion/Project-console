import { listSessions, getSession, createSession, deleteSession, renameSession, linkSessionToProject, shareSession, unshareSession } from '../conversationStore.js';
import { findUser } from '../auth/userStore.js';
import { readIndex } from '../sessionIndex.js';
import { readFullSessionHistory, formatExportMarkdown, formatExportJson } from '../sessionExport.js';
import { resolveProject, getTabWorkspace, state } from '../state.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerSessionRoutes(app) {
  // Portal (2026-09-10): each user's chats are theirs — the list filters to
  // unowned (legacy) + own sessions, admins see everything. req.authUser rides the
  // auth gate (undefined while disarmed → unfiltered, byte-identical to before).
  app.get('/api/sessions', asyncHandler(async (req, res) => {
    const sessions = await listSessions({ forUser: req.authUser || undefined });
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
    const session = await createSession(projectId, projectName, project?.path, workspacePath, req.authUser?.username || null);
    res.json({ session });
  }));

  // Portal ownership gate shared by the single-session routes below: 404 when missing,
  // 403 when owned by someone else (non-admin, not shared-with). Disarmed traffic only
  // ever meets unowned sessions, so behavior there is unchanged. Shared users may read
  // and chat; only the owner or an admin may rename, delete, link, or change sharing.
  const canSee = (meta, me) =>
    !meta.owner || (me && (me.username === meta.owner || me.role === 'admin')) ||
    (me && Array.isArray(meta.sharedWith) && meta.sharedWith.includes(me.username));
  async function sessionAccess(req, { write = false } = {}) {
    const idx = await readIndex();
    const meta = idx[req.params.id];
    if (!meta) return { status: 404 };
    const me = req.authUser;
    if (!meta.owner) return { meta };
    if (canSee(meta, me) && !write) return { meta };
    if (me && (me.username === meta.owner || me.role === 'admin')) return { meta };
    return { status: 403 };
  }

  app.get('/api/sessions/:id', asyncHandler(async (req, res) => {
    // Phase 6 (2026-08-17): pagination — ?before=<N> skips the N newest messages (the page
    // the client already holds), ?limit=<N> sizes the page (1..500, default 200 — existing
    // clients without the params get exactly the old last-200 shape). `total` rides along so
    // the client can show "load earlier" until it has everything; the index's messageCount is
    // maintained on every append (sessionIndex.js), so no extra file read is needed.
    const before = Math.max(0, parseInt(req.query.before ?? '0', 10) || 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '200', 10) || 200, 1), 500);
    const access = await sessionAccess(req);
    if (access.status === 404) return res.status(404).json({ error: 'Session not found' });
    if (access.status === 403) return res.status(403).json({ error: 'That chat belongs to another user.' });
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
    const access = await sessionAccess(req);
    if (access.status === 404) return res.status(404).json({ error: 'Session not found' });
    if (access.status === 403) return res.status(403).json({ error: 'That chat belongs to another user.' });
    const idx = await readIndex();
    const meta = idx[sessionId];
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
    const access = await sessionAccess(req, { write: true });
    if (access.status === 404) return res.status(400).json({ error: 'Invalid title or session not found' });
    if (access.status === 403) return res.status(403).json({ error: 'That chat belongs to another user.' });
    const { title } = req.body || {};
    const session = await renameSession(req.params.id, title);
    if (!session) return res.status(400).json({ error: 'Invalid title or session not found' });
    res.json({ session });
  }));

  // Link an orphan session to a project (e.g. after New Chat then selecting a project)
  app.patch('/api/sessions/:id/link', asyncHandler(async (req, res) => {
    const access = await sessionAccess(req, { write: true });
    if (access.status) return res.status(access.status).json({ error: access.status === 404 ? 'Session not found' : 'That chat belongs to another user.' });
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const session = await linkSessionToProject(req.params.id, projectId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  }));

  app.delete('/api/sessions/:id', asyncHandler(async (req, res) => {
    const access = await sessionAccess(req, { write: true });
    if (access.status === 404) return res.status(404).json({ error: 'Session not found' });
    if (access.status === 403) return res.status(403).json({ error: 'That chat belongs to another user.' });
    const ok = await deleteSession(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  }));

  // Share a chat with another account (owner or admin only; target must exist).
  // Shared users can read and chat in it; rename/delete/link/sharing stay with the
  // owner and admins. Unowned (legacy) chats need no sharing — everyone sees them.
  app.post('/api/sessions/:id/share', asyncHandler(async (req, res) => {
    const access = await sessionAccess(req, { write: true });
    if (access.status === 404) return res.status(404).json({ error: 'Session not found' });
    if (access.status === 403) return res.status(403).json({ error: 'Only the owner or an admin can share this chat.' });
    const { username } = req.body || {};
    if (!username || !findUser(username)) return res.status(404).json({ error: 'Unknown user.' });
    const result = await shareSession(req.params.id, username, req.authUser);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, sharedWith: result.sharedWith });
  }));

  app.delete('/api/sessions/:id/share/:username', asyncHandler(async (req, res) => {
    const access = await sessionAccess(req, { write: true });
    if (access.status === 404) return res.status(404).json({ error: 'Session not found' });
    if (access.status === 403) return res.status(403).json({ error: 'Only the owner or an admin can change sharing.' });
    const result = await unshareSession(req.params.id, req.params.username, req.authUser);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, sharedWith: result.sharedWith });
  }));
}
