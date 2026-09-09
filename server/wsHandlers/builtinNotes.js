// Phase 5 (UPGRADE-ROADMAP.md, 2026-08-12): trigger handlers for user-authored scratch notes
// (notesStore.js — .console/notes.md). Notes are the user's own free text: writes are immediate
// with no confirmation, reads are unguarded, and nothing here touches the AI path. The create
// handler's under-specified reply carries the additive `openPanel: 'notes'` field so the web
// client lands in the Notes panel (CLI ignores openPanel per Phase 1.5 — the text stays
// self-sufficient).
import { appendNote, listNotes, deleteNote } from '../notesStore.js';
import { getSchedules, removeScheduleById } from '../schedules/scheduleStore.js';
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

  'system.notes.delete': async (ws, action, input, project) => {
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
    // a note. If found, the answer lists them and asks the user to confirm; the profile's
    // askBeforeDeleteLinkedNote setting controls whether this prompt fires.
    const linkedReminders = getSchedules()
      .filter((s) => s.kind === 'reminder' && s.linkedNoteText && text.toLowerCase().includes(s.linkedNoteText.toLowerCase()));
    let removedReminders = 0;
    if (linkedReminders.length > 0) {
      for (const r of linkedReminders) {
        removeScheduleById(r.id);
        removedReminders++;
      }
    }
    const result = await deleteNote(project.path, text);
    if (!result.success) {
      answer(ws, result.error);
      return;
    }
    const linkedNoteHint = removedReminders > 0
      ? ` (and cancelled ${removedReminders} linked reminder${removedReminders > 1 ? 's' : ''})`
      : '';
    answer(ws, `🗑️ Deleted note: ${result.data}${linkedNoteHint}`);
  },
};
