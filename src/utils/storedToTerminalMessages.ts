import { StoredSession, TerminalMessage } from '../types';

/**
 * Converts a stored session's persisted message records back into renderable TerminalMessages
 * when a chat is reloaded from disk. Defensive against `messages` being undefined (a server-side
 * bug previously let it come back undefined for some sessions — see conversationStore.js's
 * migrateLegacySession — which would otherwise throw and make a chat's history look wiped on
 * reload).
 */
export function storedToTerminalMessages(messages: StoredSession['messages']): TerminalMessage[] {
  return (messages || []).map((m) => ({
    id: m.id,
    type: m.role as TerminalMessage['type'],
    content: m.content,
  }));
}
