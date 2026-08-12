// Split into category files under server/intents/ (2026-07-30, requested directly — "make it
// easier to manage" as the phrase count grew toward ~2000). Pure reorganization: every intent key
// and example phrase is identical to before, just grouped into smaller files by category instead
// of one ~970-line object literal. `semanticMatcher.js`, `matcher.js`, `nlpEngine.js`, and
// `learnedIntents.js` all import `{ INTENTS }` from this file exactly as before — nothing
// downstream needed to change.
import { CHIT_CHAT_INTENTS } from './intents/chitChatIntents.js';
import { PROJECT_KNOWLEDGE_INTENTS } from './intents/projectKnowledgeIntents.js';
import { PROJECT_CONTEXT_INTENTS } from './intents/projectContextIntents.js';
import { GIT_INTENTS } from './intents/gitIntents.js';
import { NPM_AND_FILE_INTENTS } from './intents/npmAndFileIntents.js';
import { MISC_INTENTS } from './intents/miscIntents.js';
import { DIAGNOSTICS_INTENTS } from './intents/diagnosticsIntents.js';
import { GENERAL_FILE_INTENTS } from './intents/generalFileIntents.js';
import { TOOL_PANEL_INTENTS } from './intents/toolPanelIntents.js';
import { PDF_INTENTS } from './intents/pdfIntents.js';
import { REMINDER_INTENTS } from './intents/reminderIntents.js';
import { NOTE_INTENTS } from './intents/noteIntents.js';
import { CSV_INTENTS } from './intents/csvIntents.js';

export const INTENTS = {
  ...CHIT_CHAT_INTENTS,
  ...PROJECT_KNOWLEDGE_INTENTS,
  ...PROJECT_CONTEXT_INTENTS,
  ...GIT_INTENTS,
  ...NPM_AND_FILE_INTENTS,
  ...MISC_INTENTS,
  ...DIAGNOSTICS_INTENTS,
  ...GENERAL_FILE_INTENTS,
  ...TOOL_PANEL_INTENTS,
  ...PDF_INTENTS,
  ...REMINDER_INTENTS,
  ...NOTE_INTENTS,
  ...CSV_INTENTS,
};
