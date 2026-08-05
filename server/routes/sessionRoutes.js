import { listSessions, getSession, createSession, deleteSession, renameSession, linkSessionToProject } from '../conversationStore.js';
import { state } from '../state.js';

export function registerSessionRoutes(app) {
  app.get('/api/sessions', async (req, res) => {
    const sessions = await listSessions();
    res.json({ sessions });
  });

  app.post('/api/sessions', async (req, res) => {
    const { projectId, projectName } = req.body || {};
    const project = projectId ? state.activeProjectsCache.find((p) => p.id === projectId) : null;
    const session = await createSession(projectId, projectName, project?.path);
    res.json({ session });
  });

  app.get('/api/sessions/:id', async (req, res) => {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  });

  // Rename a chat (manual title; the auto-title from the first message never clobbers it)
  app.patch('/api/sessions/:id', async (req, res) => {
    const { title } = req.body || {};
    const session = await renameSession(req.params.id, title);
    if (!session) return res.status(400).json({ error: 'Invalid title or session not found' });
    res.json({ session });
  });

  // Link an orphan session to a project (e.g. after New Chat then selecting a project)
  app.patch('/api/sessions/:id/link', async (req, res) => {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const session = await linkSessionToProject(req.params.id, projectId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    const ok = await deleteSession(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  });
}
