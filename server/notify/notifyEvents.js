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
  'collision-found': {
    label: 'new intent collisions appear',
    description: 'a boot-time sweep finds intent-embedding overlaps that were not present on the previous boot (see collisions.js)',
    alias: ['collision', 'intent collision', 'new collision', 'collisions appeared'],
  },
  // Phase 15 (2026-08-12): generalized file-watch / home-automation events — notification-
  // only, never a command trigger (same "notification only" separation Phase 4 uses for
  // reminders: a file-watch rule must never be a backdoor to running commands on file change).
  'file-changed': {
    label: 'a watched file changes',
    description: 'any file inside a watched folder is modified (debounced per folder)',
    alias: ['file changed', 'files change', 'a file changes', 'files changed'],
  },
  'file-added': {
    label: 'a new file appears',
    description: 'a new file is created inside a watched folder',
    alias: ['file added', 'a new file', 'new file appears', 'a file is added'],
  },
  'folder-stale': {
    label: 'a watched folder goes stale',
    description: 'no changes in a watched folder for the configured number of days',
    alias: ['folder stale', 'hasn\'t changed', 'no changes in', 'stale folder'],
  },
  'reminder-fired': {
    label: 'a reminder fires',
    description: 'a Phase 4 reminder delivers (also makes it eligible for desktop/webhook when nobody is watching the console)',
    alias: ['reminder fired', 'a reminder fires', 'reminder goes off', 'reminder'],
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