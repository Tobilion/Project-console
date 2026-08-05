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
 *
 * Command output (persisted as a role-'output' record since 2026-08-05, or legacy
 * role-'bot' messages with isMarkdown:false merged from the 'start'/'output'/'end' stream) is
 * mapped to type 'output' so a reloaded chat renders the collapsible terminal block it had live
 * instead of a plain bubble (Phase 5, 2026-08-04; hardened Phase 14, 2026-08-05).
 * The 'Executing: ' prefix is produced by exactly one place in the server (executor.js's
 * 'start' event — verified by grep), so the legacy check is safe even for records that
 * predate the isMarkdown flag.
 */
export function storedToTerminalMessages(messages: StoredSession['messages']): TerminalMessage[] {
  return (messages || []).map((m) => {
    const isMarkdown = m.isMarkdown !== undefined ? m.isMarkdown : m.role === 'bot';
    const isCommandOutput = m.role === 'output' || (m.role === 'bot' && m.content.trimStart().startsWith('Executing: '));
    return {
      id: m.id,
      type: isCommandOutput ? 'output' : (m.role as TerminalMessage['type']),
      content: m.content,
      isMarkdown,
    };
  });
}
