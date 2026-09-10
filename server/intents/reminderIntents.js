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
      'set alarm for 9am tomorrow',
      'set an alarm at 7pm',
      'alarm',
      // D-8 (2026-09-08): the phrasing the user asked for by name — "add reminder to..."
      'add reminder to renew my license tomorrow at 9am',
      'add a reminder to call the dentist tomorrow at 10am',
      'add reminder to water the plants at 8pm',
    ],
  },
  'system.reminders.list': {
    examples: [
      'list my reminders', 'list reminders', 'show my reminders', 'what reminders do i have',
      'show the reminders', 'what are my reminders',
    
      'list hey, reeminders',
      'list my remidders...',
      'list my alerts teanks...',
      'HEY, LIT MY MES REMIND',
      'could you list my alarms!!',
      'Yo show my alerts thanks',
      'what are alarms my',
      'quickly reminders ilst',
      'display the reminders now',
      'show my alerts',
      'reminders um i do have what :)',
      'hi, reminders show the!!',
      'pelase list my reminders',
      'DO REMINDERS WHAT HAVE I',
      'show the alarms',
      'tell me my reminders',
      'reminders the show',
      'HE, REMINDERS LIST MY',
      'what are the remminders',
      'REMINDERS I DO HAVE WHAT',
      'hi, list my alarrms 🙏',
      'hey, what are my reimnders :p',
      'COULD YOU TELL ME THE REMINDERS!!',
      'what are my alarms'
      ],
  },
  'system.reminders.cancel': {
    examples: [
      'cancel reminder s1', 'cancel my reminder s2', 'delete reminder s3', 'remove reminder s2',
      'cancel the reminder', 'cancel my reminder',
      'mark reminder s1 as done', 'mark my reminder as done', 'mark all reminders as done',
      'complete reminder s1', 'finish reminder s1',
    
      'as alerts all mark hi, doen',
      'cancel my remidner!',
      'deltee alarm s3',
      'hey, cancel reminder thanks my!!',
      'hey, cancel the aalarm please',
      'drrop reminder s3...',
      'the canceel hey reminder',
      'can you cancel the alarm!',
      'cancel me reminder you for can my 🙏',
      'cancel my alert',
      'can you alarm s1 cmplete',
      'cancel my alert thaanks',
      'can you cancel my aalert 🙏',
      'mark all alarms as done thanks',
      'hi, cancel my alarm',
      'Can you cancel the alarm',
      'Um as alarms mark done all'
      ],
  },
};
