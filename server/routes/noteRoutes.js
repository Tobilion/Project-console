// Phase 5 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Notes panel.
// D-7 (2026-09-08): create/delete were previously chat-trigger-only ("note: ...", "delete
// note: ..." round-tripped through the full WS/matcher pipeline purely to reach these same
// notesStore.js functions) — now direct REST, same as the read-only list endpoint always
// was. This mirrors the exact server-side behavior the chat handlers in builtinNotes.js use
// (including the delete path's linked-reminder cleanup), so switching the panel over changes
// latency, not behavior. The chat commands themselves are untouched and still work
// identically for the CLI and for typed natural-language phrasing.
import { listNotes, appendNote, deleteNote, replaceNoteText, listTrash, restoreTrash, emptyTrash } from '../notesStore.js';
import { getSchedules, removeScheduleById } from '../schedules/scheduleStore.js';
import { readProfile } from './profileRoutes.js';
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

  // F-6 in-place edit: replace a note's text without appending a fresh line (the old
  // panel saveEdit appended, orphaning the previous version). Same twin-safe contract
  // as delete/restore — ambiguity and cross-line dupes refuse, nothing is removed.
  app.put('/api/projects/:id/notes', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { oldText, newText } = req.body || {};
    res.json(await replaceNoteText(project.path, oldText, newText));
  }));

  // Delete by exact note text (same normalized-match contract as deleteNote itself). Mirrors
  // builtinNotes.js's system.notes.delete handler exactly, including the Phase 2.2 cleanup of
  // any reminder schedules linked to this note's text — with the same F-5 askBeforeDeleteLinkedNote
  // policy: a stateless REST call cannot ask, so when the setting is on (the default) linked
  // reminders are KEPT and reported back (linkedKept) for the caller to surface; only with the
  // setting explicitly off are they cancelled inline (removedReminders), matching the chat path.
  // The note itself is deleted first either way, so a failed delete never destroys reminders.
  app.delete('/api/projects/:id/notes', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { text } = req.body || {};
    const result = await deleteNote(project.path, text);
    if (!result.success) return res.json({ ...result, removedReminders: 0, linkedKept: 0 });
    const linkedReminders = getSchedules()
      .filter((s) => s.kind === 'reminder' && s.linkedNoteText && String(text || '').toLowerCase().includes(s.linkedNoteText.toLowerCase()));
    if (readProfile().askBeforeDeleteLinkedNote === false) {
      for (const r of linkedReminders) removeScheduleById(r.id);
      return res.json({ ...result, removedReminders: linkedReminders.length, linkedKept: 0 });
    }
    res.json({ ...result, removedReminders: 0, linkedKept: linkedReminders.length });
  }));

  // F-5(1) recycle bin: list what's deleted, restore one back to the live list, or
  // empty the trash permanently. Same D-7 direct-REST pattern as create/delete (no
  // chat round-trip); the chat `system.notes.trash` handler calls the same store
  // functions, so panel and chat can never diverge. `{ ok: false }` at HTTP 200 on
  // failure (apiFetchJson discards non-2xx bodies — the FileToolsPanel lesson).
  app.get('/api/projects/:id/notes/trash', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ trash: await listTrash(project.path) });
  }));

  app.post('/api/projects/:id/notes/restore', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { text } = req.body || {};
    res.json(await restoreTrash(project.path, text));
  }));

  app.post('/api/projects/:id/notes/trash/empty', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(await emptyTrash(project.path));
  }));
}
