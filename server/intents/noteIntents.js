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
    
      'notes quickly are please what my 🙏',
      'NOTES ASAP MY SHOW UM',
      'So can you show my memos!',
      'UM PLEASE SHOW MY EMOS',
      'show me my jot dowss',
      'please ttell me my notes',
      'notes show me my',
      'me show my you you can memos me for can',
      'CAN YOU NOTES MY SHOW ASAP',
      'um show my memos',
      'show my memos asap',
      'list me my notes',
      'hi, list my notes asap',
      'my show notes',
      'SHOW MY MEMOS PLEASE ASAP',
      'SHOW MY JOT DOWNS',
      'notes you hey, my show can',
      'yo show my jot downs 🙏',
      'show my jot downs please',
      'Read my notes kack to me for me :p',
      'YO MEMOS SHOW MY 🙏',
      'please list my notes',
      'Can you show please me memos my',
      'show notes me my you can...',
      'can you list my notes',
      'Can you list my notes',
      'show my memos',
      'list my notes asap asap...',
      'Notes could my you sow',
      'could you please my show notes'
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
    
      'could you drop note: buy milk now',
      'Dnlete note: buy milk',
      'so dglete note: buy milk :p',
      'deete note: remember the wifi password',
      'dxop note: buy milk',
      'so drop note: remember the wifi pussword',
      'hi, clear my ntoe about wifi asap',
      'yo note: buy milk delete',
      'hi, drop note: remember the wifi password'
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
