// Phase 5 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Notes panel — the read-only
// note list endpoint. Adding a note goes through the normal WS trigger-command path ("note: ...")
// so the terminal stays the single source of truth.
import { listNotes } from '../notesStore.js';
import { resolveProject } from '../state.js';

export function registerNoteRoutes(app) {
  app.get('/api/projects/:id/notes', async (req, res) => {
    const project = resolveProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const notes = await listNotes(project.path);
    res.json({ notes });
  });
}
