// Phase 2 (2026-08-10): the bounded, human-readable set of notifiable events. `test` is
// deliberately NOT a toggleable event — `test notification` fires on demand regardless of
// rules. Keep this list small and explicit: a notification needs a clear "why did this fire"
// story, and an unbounded event vocabulary is how notification systems become noise.

export const NOTIFY_EVENTS = {
  'dev-server-crash': {
    label: 'dev server crashed',
    description: 'a tracked dev server exits unexpectedly (or stops answering its URL)',
    alias: ['dev server crash', 'server crash', 'the server crashes', 'a dev server crashes'],
  },
  'schedule-find': {
    label: 'a scheduled check finds something',
    description: 'a scheduled or triggered command (Phase 1) produces non-empty output',
    alias: ['scheduled check', 'schedule found something', 'a schedule finds something', 'schedule output'],
  },
  'task-done': {
    label: 'a background task finishes',
    description: 'a background task completes (success or failure) — e.g. the deferred type-check',
    alias: ['task done', 'background task', 'a task finishes', 'task finished'],
  },
};

export const NOTIFY_EVENT_KEYS = Object.keys(NOTIFY_EVENTS);

/** Map user phrasing ("dev server crash", "scheduled check") onto a canonical event id, or
 *  null when nothing matches. Accepts the canonical id, the human label, or an alias. */
export function resolveEventName(text) {
  const t = (text || '').trim().toLowerCase();
  if (NOTIFY_EVENT_KEYS.includes(t)) return t;
  for (const [id, ev] of Object.entries(NOTIFY_EVENTS)) {
    if (ev.label === t) return id;
    for (const alias of ev.alias) {
      if (t === alias || t.includes(alias)) return id;
    }
  }
  return null;
}

/** Multi-line list of every event and what it means — used in enable/reject answers. */
export function eventListText() {
  return NOTIFY_EVENT_KEYS.map((k) => `  - **${k}** — ${NOTIFY_EVENTS[k].description}`).join('\n');
}