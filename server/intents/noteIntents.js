// Phase 5 (UPGRADE-ROADMAP.md, 2026-08-12): user-authored scratch notes — "note: <text>",
// "show my notes", "search my notes for X". Deliberately NOT in WORKSPACE_DEV_ONLY_INTENTS:
// notes are personal, usable from any workspace type. The create intent carries the
// `opensPanel: 'notes'` tag; the handler echoes it back as `openPanel` when the input is
// under-specified so web users land in the Notes panel.
export const NOTE_INTENTS = {
  'system.notes.create': {
    opensPanel: 'notes',
    examples: [
      'note: buy milk',
      'note: call the dentist tomorrow',
      'add a note: remember the wifi password',
      'add a note: ship the invoice on friday',
      'note: meeting notes - q3 roadmap',
    ],
  },
  'system.notes.list': {
    examples: [
      'show my notes', 'read my notes', 'show me my notes', 'what are my notes', 'read my notes back to me',
    ],
  },
  'system.notes.search': {
    examples: [
      'search my notes for wifi', 'find my notes about the trip', 'search my notes for meeting',
    ],
  },
};
