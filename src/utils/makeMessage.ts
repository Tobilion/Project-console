import { TerminalMessage } from '../types';

/**
 * Builds a TerminalMessage with a fresh id — the overwhelmingly common shape across hooks is
 * `{ id: Date.now().toString(), type, content, ...extras }`; centralizing it keeps the call
 * sites free of id boilerplate. `extra` may include an `id` override for the (rare) cases
 * that need a stable/composed id (e.g. search-result bookkeeping).
 */
export function makeMessage(
  type: TerminalMessage['type'],
  content: string,
  extra?: Partial<Omit<TerminalMessage, 'type' | 'content'>>,
): TerminalMessage {
  return { id: Date.now().toString(), type, content, timestamp: Date.now(), ...extra };
}
