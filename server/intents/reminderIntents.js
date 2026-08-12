// Phase 4 (UPGRADE-ROADMAP.md, 2026-08-12): personal reminder intents — free-form NL
// dates via chrono-node (reminderParser.js), stored as `kind: 'reminder'` schedules.
// Deliberately NOT in WORKSPACE_DEV_ONLY_INTENTS: reminders are personal, usable from any
// workspace type. Phrase shapes stay close to the roadmap's "remind me [when] to [text]" /
// "list my reminders" / "cancel reminder <id>"; "show my reminders" keeps the "show me
// the todos" corpus-collision lesson from Phase 1.5 in mind (no "show me ..." shapes).
export const REMINDER_INTENTS = {
  'system.reminders.create': {
    opensPanel: 'reminders',
    examples: [
      'remind me tomorrow at 9am to renew my license',
      'remind me in 3 days to follow up',
      'remind me every friday at 5pm to call the accountant',
      'remind me daily at 9am to drink water',
      'remind me to water the plants at 8pm',
      'remind me at 7pm to take out the trash',
      'set a reminder for friday at 5pm to pay rent',
      'set a reminder to call the dentist tomorrow at 10am',
      'remind me to stretch every friday at 6pm',
    ],
  },
  'system.reminders.list': {
    examples: [
      'list my reminders', 'list reminders', 'show my reminders', 'what reminders do i have',
      'show the reminders', 'what are my reminders',
    ],
  },
  'system.reminders.cancel': {
    examples: [
      'cancel reminder s1', 'cancel my reminder s2', 'delete reminder s3', 'remove reminder s2',
      'cancel the reminder', 'cancel my reminder',
    ],
  },
};
