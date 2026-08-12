// Phase 4 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Reminders panel — the
// read-only list endpoint the interactive panel uses for its Today/Upcoming/All sections.
// Mutations (create/complete/cancel) go through the normal WS trigger-command path so
// confirmation, journaling, and the terminal stay the single source of truth (same contract
// as the PDF Tools panel's REST read-only endpoints).
import { getSchedules } from '../schedules/scheduleStore.js';

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
      }));
    res.json({ reminders });
  });
}
