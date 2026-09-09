// Phase 4 (UPGRADE-ROADMAP.md, 2026-08-12): personal reminder trigger handlers. Reminders
// reuse the Phase 1 schedule store (data/schedules.json) with `kind: 'reminder'` — they are
// personal, not project assets: creation records the active project for delivery preference
// and display, `list my reminders` shows all of them, and `cancel reminder <id>` works from
// any project (removeScheduleById, not the project-scoped removeSchedule used by command
// schedules — that asymmetry is deliberate and documented in CLAUDE.md).

import { parseReminderInput } from '../schedules/reminderParser.js';
import { addSchedule, getSchedules, getScheduleById, removeScheduleById } from '../schedules/scheduleStore.js';

export const reminderHandlers = {
  'system.reminders.create': async (ws, action, input, project, sessionContext) => {
    const parsed = parseReminderInput(input);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ type: 'answer', data: parsed.reason, openPanel: 'reminders' }));
      return;
    }
    // Phase 2.2: detect "see the note: <text>" phrases — when the reminder text starts with
    // "see the note:" we extract the note reference so the panel can show a clickable link
    // back to the Notes panel, and deleting that note cascades to cancel this reminder.
    const noteMatch = parsed.text.match(/^(?:see|check|read|open|review)\s+(?:the\s+)?(?:my\s+)?note\s*(?::|about|for)?\s*(.+)/i);
    const linkedNoteText = noteMatch ? noteMatch[1].trim() : null;
    const schedule = addSchedule({
      projectId: project.id,
      projectName: project.name,
      spec: parsed,
      kind: 'reminder',
      text: parsed.text,
      fireAt: parsed.fireAt ?? null,
      weekday: parsed.weekday ?? null,
      firstFireAt: parsed.firstFireAt ?? null,
      createdBy: sessionContext?.displayName || 'local',
      linkedNoteText,
    });
    // Phase 4 audit (2026-08-12): dateless reminders are TODOs — they live in the list's
    // No Date section and never fire, so the answer must not promise delivery.
    const data = parsed.type === 'todo'
      ? `Added to your list 📋 — **${schedule.id}**: "${schedule.text}" (no date set).\n\nManage with \`list my reminders\` / \`cancel reminder ${schedule.id}\`.`
      : `Reminder set 🔔 — **${schedule.id}**: ${schedule.label} → "${schedule.text}".\n\nIt posts to whatever chat is open when it fires (otherwise to the schedule log). Manage with \`list my reminders\` / \`cancel reminder ${schedule.id}\`.`;
    ws.send(JSON.stringify({ type: 'answer', data }));
  },

  'system.reminders.list': async (ws, action, input, project) => {
    const reminders = getSchedules().filter((s) => s.kind === 'reminder');
    if (reminders.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No reminders set. Try `remind me tomorrow at 9am to renew my license`.' }));
      return;
    }
    const rows = reminders.map((s, i) => {
      const last = s.lastFiredAt ? new Date(s.lastFiredAt).toLocaleString() : 'never';
      const owner = s.projectId === project.id ? '' : ` (${s.projectName || s.projectId})`;
      const noteLink = s.linkedNoteText ? ` 📝 "${s.linkedNoteText.slice(0, 30)}"` : '';
      // Todos (dateless reminders) render with their own label — no "fires" language.
      if (s.type === 'todo') return `${i + 1}. **${s.id}**${owner} — 📋 "${s.text}" (no date)${noteLink}`;
      return `${i + 1}. **${s.id}**${owner} — ${s.label} → "${s.text}" — last fired ${last}${noteLink}`;
    });
    // F-11 (2026-09-08/09): additive `card` alongside the plain markdown `data` above — same
    // shape src/types.ts's ReminderCardItem/TerminalMessageCard expect, so the web client can
    // render this as an Apple-Reminders-style checklist (src/components/terminal/ReminderCard.tsx)
    // while the CLI (which only ever reads `data`, see server/cli-client.js) is unaffected.
    const card = {
      type: 'reminders',
      items: reminders.map((s) => ({ id: s.id, text: s.text, label: s.type === 'todo' ? null : s.label, type: s.type })),
    };
    ws.send(JSON.stringify({ type: 'answer', data: `### Reminders\n\n${rows.join('\n')}`, card }));
  },

  'system.reminders.cancel': async (ws, action, input, project) => {
    // Support "mark all reminders as done" — cancels every reminder in one shot.
    if (/^mark\s+all\s+reminders?\s+as\s+done$/i.test(input.trim()) || /^complete\s+all\s+reminders?$/i.test(input.trim())) {
      const all = getSchedules().filter((s) => s.kind === 'reminder');
      if (all.length === 0) {
        ws.send(JSON.stringify({ type: 'answer', data: 'No reminders to complete.' }));
        return;
      }
      for (const r of all) removeScheduleById(r.id);
      ws.send(JSON.stringify({ type: 'answer', data: `Completed and removed ${all.length} reminder${all.length > 1 ? 's' : ''}.` }));
      return;
    }
    const m = input.match(/^cancel\s+reminder\s+(\S+)$/i) || input.match(/^delete\s+reminder\s+(\S+)$/i) || input.match(/^remove\s+reminder\s+(\S+)$/i) || input.match(/^mark\s+reminder\s+(\S+)\s+as\s+done$/i) || input.match(/^complete\s+reminder\s+(\S+)$/i) || input.match(/^finish\s+reminder\s+(\S+)$/i);
    let id = m ? m[1] : null;
    if (!id) {
      ws.send(JSON.stringify({ type: 'answer', data: 'Which one? `list my reminders` shows the ids — then `cancel reminder <id>`.' }));
      return;
    }
    // Ids are `s<counter>`; a bare number is what a user naturally types after seeing the
    // list ("cancel reminder 8") — normalize it so both spellings resolve.
    if (/^\d+$/.test(id)) id = `s${id}`;
    const existing = getScheduleById(id);
    if (existing && existing.kind !== 'reminder') {
      ws.send(JSON.stringify({ type: 'answer', data: `\`${id}\` is a command schedule, not a reminder — use \`remove schedule ${id}\` for it.` }));
      return;
    }
    const removed = removeScheduleById(id);
    ws.send(JSON.stringify({
      type: 'answer',
      data: removed
        ? `Cancelled reminder \`${removed.id}\` ("${removed.text}", ${removed.label}).`
        : `No reminder \`${id}\` — try \`list my reminders\`.`,
    }));
  },
};
