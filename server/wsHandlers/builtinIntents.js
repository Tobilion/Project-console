import { gitHandlers } from './builtinGit.js';
import { chitChatHandlers } from './builtinChitChat.js';
import { fileNpmHandlers } from './builtinFileNpm.js';
import { projectKnowledgeHandlers } from './builtinProjectKnowledge.js';
import { projectContextHandlers } from './builtinProjectContext.js';
import { projectActionHandlers } from './builtinProjectActions.js';
import { diagnosticsHandlers } from './builtinDiagnostics.js';
import { generalFileHandlers } from './builtinGeneralFiles.js';
import { toolsHandlers } from './builtinTools.js';
import { pdfHandlers } from './builtinPdfTools.js';
import { reminderHandlers } from './builtinReminders.js';

// Phase 10 (2026-08-04, splitting builtinIntents.js into per-domain leaf modules): this file
// is now a pure orchestrator — every branch body lives in one of the domain modules
// (builtinGit / builtinChitChat / builtinFileNpm / builtinProjectKnowledge /
// builtinProjectContext / builtinProjectActions / builtinDiagnostics — the last added Phase 5,
// audit 2026-08-10). The merge map preserves the historical dispatch surface exactly; the
// `undo` alias existed as a literal branch in the original dispatcher and is folded into the
// lookup here.
const handlers = {
  ...gitHandlers,
  ...chitChatHandlers,
  ...fileNpmHandlers,
  ...projectKnowledgeHandlers,
  ...projectContextHandlers,
  ...projectActionHandlers,
  ...diagnosticsHandlers,
  ...generalFileHandlers,
  ...toolsHandlers,
  ...pdfHandlers,
  ...reminderHandlers,
};

/**
 * Handles all built-in (non-project-config, non-AI) conversational intents. Returns false if the action wasn't recognized.
 */
export async function handleBuiltinIntent(ws, action, input, project, sessionContext) {
  if (action === 'undo') action = 'system.chit_chat.undo';
  const handler = handlers[action];
  if (!handler) return false;
  const result = await handler(ws, action, input, project, sessionContext);
  return result === false ? false : true;
}
