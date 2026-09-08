// Phase 5 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Notes panel.
// D-7 (2026-09-08): create/delete were previously chat-trigger-only ("note: ...", "delete
// note: ..." round-tripped through the full WS/matcher pipeline purely to reach these same
// notesStore.js functions) — now direct REST, same as the read-only list endpoint always
// was. This mirrors the exact server-side behavior the chat handlers in builtinNotes.js use
// (including the delete path's linked-reminder cleanup), so switching the panel over changes
// latency, not behavior. The chat commands themselves are untouched and still work
// identically for the CLI and for typed natural-language phrasing.
import { listNotes, appendNote, deleteNote } from '../notesStore.js';
import { getSchedules, removeScheduleById } from '../schedules/scheduleStore.js';
import { resolveProject } from '../state.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerNoteRoutes(app) {
  app.get('/api/projects/:id/notes', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const notes = await listNotes(project.path);
    res.json({ notes });
  }));

  // Create (also used for the panel's "save edit" — appendNote's exact-dedupe makes an
  // unchanged re-save a no-op, matching the chat path's existing behavior). Attribution:
  // the chat path passes the WS connection's display name (Phase 19, LAN multi-user); a
  // plain REST call has no session to read that from, so it attributes as 'local' — the
  // same value single-user installs (the overwhelming majority) always got anyway.
  app.post('/api/projects/:id/notes', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { text } = req.body || {};
    const result = await appendNote(project.path, text, 'local');
    res.json(result);
  }));

  // Delete by exact note text (same normalized-match contract as deleteNote itself). Mirrors
  // builtinNotes.js's system.notes.delete handler exactly, including the Phase 2.2 cleanup of
  // any reminder schedules linked to this note's text.
  app.delete('/api/projects/:id/notes', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { text } = req.body || {};
    const linkedReminders = getSchedules()
      .filter((s) => s.kind === 'reminder' && s.linkedNoteText && String(text || '').toLowerCase().includes(s.linkedNoteText.toLowerCase()));
    for (const r of linkedReminders) removeScheduleById(r.id);
    const result = await deleteNote(project.path, text);
    res.json({ ...result, removedReminders: linkedReminders.length });
  }));
}
