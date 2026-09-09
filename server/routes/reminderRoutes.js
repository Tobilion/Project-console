// Phase 4 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Reminders panel — the
// read-only list endpoint the interactive panel uses for its Today/Upcoming/All sections.
// D-7 (2026-09-08): reminders were never confirm-gated or journaled (unlike tidy/pdf ops) —
// builtinReminders.js's create/cancel handlers are plain scheduleStore.js calls with no
// checkpoint, no appendAction — so there is no safety contract to replicate here beyond
// calling the exact same functions. POST/DELETE below do exactly that, skipping only the
// WS/matcher round-trip; parseReminderInput still does all the natural-language parsing
// (the panel's composer/quick-add already produce chat-shaped phrases, e.g. "remind me
// tomorrow at 9am to call the dentist" — reusing the same parser means create behavior can
// never diverge between the chat and panel paths).
import { getSchedules, addSchedule, getScheduleById, removeScheduleById, setReminderCompleted, snoozeReminder } from '../schedules/scheduleStore.js';
import { parseReminderInput } from '../schedules/reminderParser.js';
import { resolveProject } from '../state.js';

export function registerReminderRoutes(app) {
  app.get('/api/reminders', (req, res) => {
    const reminders = getSchedules()
      .filter((s) => s.kind === 'reminder')
      .map((s) => ({
        id: s.id,
        text: s.text,
        label: s.label,
        type: s.type,
        fireAt: s.fireAt ?? null,
        weekday: s.weekday ?? null,
        hour: s.hour ?? null,
        minute: s.minute ?? null,
        everyMs: s.everyMs ?? null,
        projectName: s.projectName,
        projectId: s.projectId,
        lastFiredAt: s.lastFiredAt ?? null,
        createdAt: s.createdAt ?? null,
        createdBy: s.createdBy ?? 'local',
        linkedNoteText: s.linkedNoteText ?? null,
        completed: s.completed === true,
      }));
    res.json({ reminders });
  });

  // Create — mirrors builtinReminders.js's system.reminders.create exactly (same
  // parseReminderInput + linkedNoteText detection + addSchedule call), just reached directly
  // instead of via the chat matcher. Body: { phrase, projectId? } — projectId lets a REST
  // caller attribute the reminder to the active project the way the chat path's dispatched
  // `project` argument does; falls back to the general workspace when omitted.
  app.post('/api/reminders', (req, res) => {
    const phrase = typeof req.body?.phrase === 'string' ? req.body.phrase : '';
    if (!phrase.trim()) return res.json({ ok: false, error: 'Missing phrase.' });
    const parsed = parseReminderInput(phrase);
    if (!parsed.ok) return res.json({ ok: false, error: parsed.reason });
    const project = resolveProject(req.body?.projectId, req.query.tab) || resolveProject('__general__');
    const noteMatch = parsed.text.match(/^(?:see|check|read|open|review)\s+(?:the\s+)?(?:my\s+)?note\s*(?::|about|for)?\s*(.+)/i);
    const linkedNoteText = noteMatch ? noteMatch[1].trim() : null;
    const schedule = addSchedule({
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      spec: parsed,
      kind: 'reminder',
      text: parsed.text,
      fireAt: parsed.fireAt ?? null,
      weekday: parsed.weekday ?? null,
      firstFireAt: parsed.firstFireAt ?? null,
      createdBy: 'local',
      linkedNoteText,
    });
    res.json({ ok: true, schedule });
  });

  // Cancel — mirrors system.reminders.cancel's id-resolution rules (bare numeric ids get the
  // `s`-prefix rewrite, a command-schedule id is refused with the same message).
  app.delete('/api/reminders/:id', (req, res) => {
    let id = req.params.id;
    if (/^\d+$/.test(id)) id = `s${id}`;
    const existing = getScheduleById(id);
    if (existing && existing.kind !== 'reminder') {
      return res.json({ ok: false, error: `"${id}" is a command schedule, not a reminder.` });
    }
    const removed = removeScheduleById(id);
    if (!removed) return res.json({ ok: false, error: `No reminder "${id}".` });
    res.json({ ok: true, removed });
  });

  // Complete / reopen (F-4, 2026-09-09) — sets the persisted completed flag instead of
  // deleting the record (DELETE above stays the explicit hard-delete). Body { completed }
  // defaults true; false reopens. Same id-resolution + failure conventions as cancel.
  app.post('/api/reminders/:id/complete', (req, res) => {
    let id = req.params.id;
    if (/^\d+$/.test(id)) id = `s${id}`;
    const completed = req.body?.completed !== false;
    const schedule = setReminderCompleted(id, completed);
    if (!schedule) return res.json({ ok: false, error: `No reminder "${id}".` });
    res.json({ ok: true, completed: schedule.completed === true, schedule });
  });

  // Snooze (E-2, 2026-09-09) — defers a fired reminder by N minutes (default 10, clamped
  // 1–1440) by scheduling one extra oneshot copy; the original's own cadence is untouched.
  // Same id-resolution rules as cancel; same { ok: false }-at-200 failure convention.
  app.post('/api/reminders/:id/snooze', (req, res) => {
    let id = req.params.id;
    if (/^\d+$/.test(id)) id = `s${id}`;
    const result = snoozeReminder(id, req.body?.minutes);
    if (!result) return res.json({ ok: false, error: `No snoozable reminder "${id}".` });
    res.json({ ok: true, minutes: result.minutes, schedule: result.schedule });
  });
}
