import { basicHandlers } from './chitChat/basic.js';
import { docHandlers, answerDocMatches, pushTargetQuestion } from './chitChat/howDoI.js';
import { toolsHandlers } from './chitChat/tools.js';
import { supportHandlers } from './chitChat/support.js';
import { mathHandlers } from './chitChat/calculate.js';

/**
 * system.chit_chat.* handlers (Phase 10 step 3, extracted verbatim from builtinIntents.js).
 * Thin dispatcher over the chitChat/ domain leaves (basic/doc/tools/support/math).
 * Full (ws, action, input, project, sessionContext) signature for uniform dispatch.
 * `undo` is also reachable via the bare `'undo'` alias — the dispatcher maps it onto this
 * handler (key 'system.chit_chat.undo') before calling.
 */
export const chitChatHandlers = {
  ...basicHandlers,
  ...docHandlers,
  ...toolsHandlers,
  ...supportHandlers,
  ...mathHandlers,
};

// Re-exported so connectionInterceptors.js keeps importing them from this barrel.
export { answerDocMatches, pushTargetQuestion };