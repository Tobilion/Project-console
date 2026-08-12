// Phase 4 (UPGRADE-ROADMAP.md, 2026-08-12): personal reminder trigger handlers. Reminders
// reuse the Phase 1 schedule store (data/schedules.json) with `kind: 'reminder'` — they are
// personal, not project assets: creation records the active project for delivery preference
// and display, `list my reminders` shows all of them, and `cancel reminder <id>` works from
// any project (removeScheduleById, not the project-scoped removeSchedule used by command
// schedules — that asymmetry is deliberate and documented in CLAUDE.md).

import { parseReminderInput } from '../schedules/reminderParser.js';
import { addSchedule, getSchedules, getScheduleById, removeScheduleById } from '../schedules/scheduleStore.js';

export const reminderHandlers = {
  'system.reminders.create': async (ws, action, input, project) => {
    const parsed = parseReminderInput(input);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ type: 'answer', data: parsed.reason, openPanel: 'reminders' }));
      return;
    }
    const schedule = addSchedule({
      projectId: project.id,
      projectName: project.name,
      spec: parsed,
      kind: 'reminder',
      text: parsed.text,
      fireAt: parsed.fireAt ?? null,
      weekday: parsed.weekday ?? null,
      firstFireAt: parsed.firstFireAt ?? null,
    });
    ws.send(JSON.stringify({
      type: 'answer',
      data: `Reminder set 🔔 — **${schedule.id}**: ${schedule.label} → "${schedule.text}".\n\nIt posts to whatever chat is open when it fires (otherwise to the schedule log). Manage with \`list my reminders\` / \`cancel reminder ${schedule.id}\`.`,
    }));
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
      return `${i + 1}. **${s.id}**${owner} — ${s.label} → "${s.text}" — last fired ${last}`;
    });
    ws.send(JSON.stringify({ type: 'answer', data: `### Reminders\n\n${rows.join('\n')}` }));
  },

  'system.reminders.cancel': async (ws, action, input, project) => {
    const m = input.match(/^cancel\s+reminder\s+(\S+)$/i) || input.match(/^delete\s+reminder\s+(\S+)$/i) || input.match(/^remove\s+reminder\s+(\S+)$/i);
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
