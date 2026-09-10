// Reminders scheduling display helpers (2026-09-10, split out of RemindersPanel.tsx):
// the ReminderInfo shape, the view union, and the pure date math the panel uses to
// classify reminders into Today/Upcoming (mirrors the scheduler's isDue() semantics
// in scheduler.js for display purposes only — firing decisions stay server-side).

export interface ReminderInfo {
  id: string;
  text: string;
  label: string;
  type: string;
  fireAt: number | null;
  weekday: number | null;
  hour: number | null;
  minute: number | null;
  everyMs: number | null;
  projectName: string;
  projectId: string;
  lastFiredAt: number | null;
  createdAt: number | null;
  linkedNoteText: string | null;
  /** F-4: persisted completed flag — completed reminders live in the Completed section
   *  instead of being deleted (older servers omit it; treat as active). */
  completed?: boolean;
}

export type ReminderView = 'today' | 'upcoming' | 'all' | 'nodate' | 'completed';

export const END_OF_TODAY = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};

export function isOverdue(fireAt: number): boolean {
  return fireAt < Date.now();
}

// Phase 5: recurring reminders (daily/weekly/interval) get a concrete NEXT fire time so the
// panel can classify them into Today/Upcoming instead of hiding them in All — mirrors the
// scheduler's isDue() semantics (scheduler.js) for display purposes only.
export function nextFireAt(r: ReminderInfo): number | null {
  if (r.type === 'oneshot' || r.type === 'todo') return r.fireAt;
  const now = new Date();
  if (r.type === 'daily' && r.hour !== null && r.minute !== null) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), r.hour, r.minute, 0, 0);
    if (d.getTime() > now.getTime()) return d.getTime();
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (r.type === 'weekly' && r.weekday !== null && r.hour !== null && r.minute !== null) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), r.hour, r.minute, 0, 0);
    const daysAhead = (r.weekday - today.getDay() + 7) % 7;
    const occ = today.getTime() + daysAhead * 86400000;
    if (occ > now.getTime()) return occ;
    return occ + 7 * 86400000;
  }
  if (r.type === 'interval' && r.everyMs) {
    const base = r.lastFiredAt ?? r.fireAt ?? 0;
    let next = base + r.everyMs;
    while (next <= now.getTime()) next += r.everyMs;
    return next;
  }
  return null;
}
