import { StoredSession, TerminalMessage } from '../types';

/**
 * Converts a stored session's persisted message records back into renderable TerminalMessages
 * when a chat is reloaded from disk. Defensive against `messages` being undefined (a server-side
 * bug previously let it come back undefined for some sessions — see conversationStore.js's
 * migrateLegacySession — which would otherwise throw and make a chat's history look wiped on
 * reload).
 *
 * isMarkdown is persisted alongside content since 2026-08-04 (reloaded chats were silently
 * losing all styling — answers rendered as plain text because the flag was never stored).
 * Legacy records without the flag fall back to role-based defaults: bot answers are markdown
 * (the dominant legacy record; every builtin/streamed reply persisted with role 'bot'), while
 * user/error/warning and the ⚙️/🔧 system tool-trace lines stay plain exactly as they
 * rendered live.
 */
export function storedToTerminalMessages(messages: StoredSession['messages']): TerminalMessage[] {
  return (messages || []).map((m) => ({
    id: m.id,
    type: m.role as TerminalMessage['type'],
    content: m.content,
    isMarkdown: m.isMarkdown !== undefined ? m.isMarkdown : m.role === 'bot',
  }));
}
