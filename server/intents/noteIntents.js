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
      'can you show my notes', 'show my notes please', 'can you show me my notes', 'please show my notes', 'hey show my notes', 'show my notes asap',
    ],
  },
  'system.notes.search': {
    examples: [
      'search my notes for wifi', 'find my notes about the trip', 'search my notes for meeting',
    ],
  },
  'system.notes.delete': {
    examples: [
      'delete note: buy milk', 'remove the note about the trip', 'delete my note about wifi',
      'delete note: remember the wifi password',
    ],
  },
  // F-5(1) (2026-09-10): the recycle bin — every example names the trash explicitly
  // (trash/recycle/deleted notes) so these shapes can never near-dupe the plain
  // list/search/delete clusters.
  'system.notes.trash': {
    opensPanel: 'notes',
    examples: [
      'show deleted notes', 'show my recycle bin', 'what is in the trash',
      'restore note: buy milk', 'restore the deleted note about wifi', 'empty the trash',
    ],
  },
};
