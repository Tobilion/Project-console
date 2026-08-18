import { TerminalMessage } from '../types';
import { makeId } from '../hooks/wsCtx';

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
  // makeId (crypto.randomUUID when available) instead of Date.now(): two messages created in
  // the same millisecond used to get duplicate React keys and drop the last one (audit
  // 2026-08-17).
  return { id: makeId(), type, content, timestamp: Date.now(), ...extra };
}
