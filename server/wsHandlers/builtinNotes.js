// Phase 5 (UPGRADE-ROADMAP.md, 2026-08-12): trigger handlers for user-authored scratch notes
// (notesStore.js — .console/notes.md). Notes are the user's own free text: writes are immediate
// with no confirmation, reads are unguarded, and nothing here touches the AI path. The create
// handler's under-specified reply carries the additive `openPanel: 'notes'` field so the web
// client lands in the Notes panel (CLI ignores openPanel per Phase 1.5 — the text stays
// self-sufficient).
import { appendNote, listNotes, deleteNote } from '../notesStore.js';
import { getSchedules, removeScheduleById } from '../schedules/scheduleStore.js';
import { readProfile } from '../routes/profileRoutes.js';
import { answer } from '../wsReply.js';

const CREATE_PREFIX_RE = /^(?:note|add\s+a\s+note|write\s+a\s+note|jot\s+down)\s*:\s*(.+)$/is;

export const noteHandlers = {
  'system.notes.create': async (ws, action, input, project, sessionContext) => {
    const m = input.match(CREATE_PREFIX_RE);
    const text = m ? m[1].trim() : '';
    if (!text) {
      ws.send(JSON.stringify({ type: 'answer', data: 'What should the note say? Try `note: buy milk` — you can also use the Notes panel (Tools > Notes).', openPanel: 'notes' }));
      return;
    }
    const result = await appendNote(project.path, text, sessionContext?.displayName || 'local');
    answer(ws, result.success ? `📝 ${result.data}` : result.error);
  },

  'system.notes.list': async (ws, action, input, project) => {
    const notes = await listNotes(project.path);
    if (notes.length === 0) {
      answer(ws, 'No notes yet. Try `note: buy milk` to jot something down.');
      return;
    }
    const rows = notes
      .slice()
      .reverse()
      .slice(0, 20)
      .map((n, i) => `${i + 1}. ${n.text}${n.date ? ` — ${n.date}` : ''}`);
    const more = notes.length > 20 ? `\n\n…and ${notes.length - 20} older notes (see .console/notes.md).` : '';
    answer(ws, `### Notes (${notes.length})\n\n${rows.join('\n')}${more}`);
  },

  'system.notes.search': async (ws, action, input, project) => {
    const q = input.replace(/^(?:search|find)\s+(?:my\s+)?notes?\s+(?:for|about|with)\s+/i, '').trim().replace(/[.?!]+$/, '');
    if (!q) {
      answer(ws, 'Search for what? Try `search my notes for wifi`.');
      return;
    }
    const notes = await listNotes(project.path);
    const ql = q.toLowerCase();
    const hits = notes
      .filter((n) => n.text.toLowerCase().includes(ql))
      .slice()
      .reverse()
      .slice(0, 10);
    if (hits.length === 0) {
      answer(ws, `No notes match "${q}".`);
      return;
    }
    const rows = hits.map((n) => `- ${n.text}${n.date ? ` (${n.date})` : ''}`);
    answer(ws, `Found **${hits.length}** note${hits.length === 1 ? '' : 's'} matching "${q}":\n\n${rows.join('\n')}`);
  },

  'system.notes.delete': async (ws, action, input, project, sessionContext) => {
    // Support both "delete the note: <text>" and bare "delete <text>" after the command prefix.
    const text = input
      .replace(/^(?:delete|remove|clear)\s+(?:the\s+)?(?:note|notes?)\s*(?::|about|for|with)?\s*/i, '')
      .trim()
      .replace(/[.?!]+$/, '');
    if (!text) {
      answer(ws, 'Which note should I delete? Try `delete note: buy milk` or pick one in the Notes panel.');
      return;
    }
    // Phase 2.2: before deleting the note, check for reminders linked to this note's text.
    // The linkedNoteText field on reminder schedules is set when a reminder is created "about"
    // a note. F-5 (2026-09-09): the profile's askBeforeDeleteLinkedNote setting (default true)
    // is now actually respected — previously linked reminders were always auto-cancelled even
    // when the user had asked to be prompted. The note itself is deleted first: when that
    // fails the reminders stay untouched (previously they were removed before the note
    // delete was even attempted, so a failed delete still destroyed them).
    const linkedReminders = getSchedules()
      .filter((s) => s.kind === 'reminder' && s.linkedNoteText && text.toLowerCase().includes(s.linkedNoteText.toLowerCase()));
    const result = await deleteNote(project.path, text);
    if (!result.success) {
      answer(ws, result.error);
      return;
    }
    if (linkedReminders.length === 0) {
      answer(ws, `🗑️ Deleted note: ${result.data}`);
      return;
    }
    if (readProfile().askBeforeDeleteLinkedNote === false) {
      let removedReminders = 0;
      for (const r of linkedReminders) {
        removeScheduleById(r.id);
        removedReminders++;
      }
      answer(ws, `🗑️ Deleted note: ${result.data} (and cancelled ${removedReminders} linked reminder${removedReminders > 1 ? 's' : ''})`);
      return;
    }
    sessionContext.pendingNoteDelete = {
      projectId: project.id,
      noteText: result.data,
      reminderIds: linkedReminders.map((r) => r.id),
    };
    const listed = linkedReminders.map((r) => `- ${r.text || r.id}`).join('\n');
    const plural = linkedReminders.length > 1;
    answer(ws, `🗑️ Deleted note: ${result.data}\n\nIt has ${linkedReminders.length} linked reminder${plural ? 's' : ''}:\n${listed}\n\nReply **yes** to cancel ${plural ? 'them' : 'it'} too, or **no** to keep ${plural ? 'them' : 'it'}.`);
  },
};
