// Seed phrases for the NLP.js classifier, as [phrase, intent] tuples. Split out of nlpEngine.js
// (Phase 2 modularization) as pure data — nlpEngine.initializeDefaultIntents re-adds each via
// `manager.addDocument('en', phrase, intent)` in the same order, so training behavior is
// byte-identical to the previous inline form.

export const NLP_SEED_INTENTS = [
  // Greetings
  ['hi', 'system.chit_chat.greeting'],
  ['hello', 'system.chit_chat.greeting'],
  ['hey', 'system.chit_chat.greeting'],
  ['yo', 'system.chit_chat.greeting'],
  ['good morning', 'system.chit_chat.greeting'],
  ['good evening', 'system.chit_chat.greeting'],
  ['good afternoon', 'system.chit_chat.greeting'],
  ['greetings', 'system.chit_chat.greeting'],
  ['hey there', 'system.chit_chat.greeting'],

  // Status / how are you
  ['how are you', 'system.chit_chat.status'],
  ['how are you doing', 'system.chit_chat.status'],
  ["how's it going", 'system.chit_chat.status'],
  ["what's up", 'system.chit_chat.status'],
  ['how is everything', 'system.chit_chat.status'],
  ['sup', 'system.chit_chat.status'],
  ["what's happening", 'system.chit_chat.status'],
  ['how are things', 'system.chit_chat.status'],

  // Gratitude
  ['thanks', 'system.chit_chat.gratitude'],
  ['thank you', 'system.chit_chat.gratitude'],
  ['thank you very much', 'system.chit_chat.gratitude'],
  ['awesome', 'system.chit_chat.gratitude'],
  ['great thanks', 'system.chit_chat.gratitude'],
  ['appreciate it', 'system.chit_chat.gratitude'],

  // Clear console
  ['clear', 'system.chit_chat.clear'],
  ['clear console', 'system.chit_chat.clear'],
  ['clear chat', 'system.chit_chat.clear'],
  ['cls', 'system.chit_chat.clear'],

  // Help
  ['help', 'system.chit_chat.help'],
  ['what can you do', 'system.chit_chat.help'],
  ['list commands', 'system.chit_chat.help'],
  ['show me what you can do', 'system.chit_chat.help'],

  // Git
  ['git status', 'system.chit_chat.git_status'],
  ['show changes', 'system.chit_chat.git_status'],

  // Deploy (commit + push — Vercel-connected projects deploy on push)
  ['deploy', 'system.chit_chat.deploy'],
  ['deploy the site', 'system.chit_chat.deploy'],
  ['deploy this', 'system.chit_chat.deploy'],
  ['push live', 'system.chit_chat.deploy'],
  ['push my changes', 'system.chit_chat.deploy'],
  ['commit and push', 'system.chit_chat.deploy'],
  ['push to git', 'system.chit_chat.deploy'],
  ['publish the site', 'system.chit_chat.deploy'],
  ['go live', 'system.chit_chat.deploy'],

  // Follow-up
  ['explain more', 'system.chit_chat.explain_followup'],
  ['tell me more', 'system.chit_chat.explain_followup'],
  ['elaborate', 'system.chit_chat.explain_followup'],
  ['deep dive', 'system.chit_chat.explain_followup'],
  ['give me more details', 'system.chit_chat.explain_followup'],

  // Knowledge / Overview
  ['describe', 'project.knowledge.overview'],
  ['info', 'project.knowledge.overview'],
  ['what is this project', 'project.knowledge.overview'],
  ['overview', 'project.knowledge.overview'],
  ['project overview', 'project.knowledge.overview'],

  ['what is the stack', 'project.knowledge.stack'],
  ['tech stack', 'project.knowledge.stack'],
  ['what tech does it use', 'project.knowledge.stack'],

  ['what are the commands', 'project.knowledge.commands'],
  ['how do i run this', 'project.knowledge.commands'],
  ['show me the commands', 'project.knowledge.commands'],

  ['known issues', 'project.knowledge.gotchas'],
  ['what are the gotchas', 'project.knowledge.gotchas'],

  ['architecture', 'project.knowledge.architecture'],
  ['how is the project built', 'project.knowledge.architecture'],
  ['project structure', 'project.knowledge.architecture'],

  // Context-aware intents (Phase 4)
  ['show me the project structure', 'project.context.structure'],
  ['what are the directories', 'project.context.structure'],
  ['list the folders', 'project.context.structure'],
  ['folder structure', 'project.context.structure'],
  ['directory tree', 'project.context.structure'],

  ['what languages', 'project.context.languages'],
  ['what programming languages', 'project.context.languages'],
  ['what language is this', 'project.context.languages'],
  ['which languages are used', 'project.context.languages'],

  ['how many files', 'project.context.file_count'],
  ['project size', 'project.context.file_count'],
  ['how big is this project', 'project.context.file_count'],
  ['file count', 'project.context.file_count'],
  ['total files', 'project.context.file_count'],

  ['what is the entry point', 'project.context.entry_point'],
  ['where does the app start', 'project.context.entry_point'],
  ['main file', 'project.context.entry_point'],
  ['entry point', 'project.context.entry_point'],

  ['give me a summary', 'project.context.tech_preview'],
  ['project summary', 'project.context.tech_preview'],
  ['tl dr', 'project.context.tech_preview'],
  ['summary', 'project.context.tech_preview'],
  ['what do i need to know', 'project.context.tech_preview'],
];
