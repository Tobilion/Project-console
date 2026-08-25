// WS micro-actions (2026-08-24, split out of useConsole.ts): the small "send one WS message"
// handlers. Each is a stable useCallback with an explicit wsRef dependency — nothing here
// reads React state at call time, so the callbacks never go stale.

import { useCallback } from 'react';
import type { TerminalMessage } from '../types';
import { makeMessage } from '../utils/makeMessage';

export interface UseConsoleWsActionsDeps {
  wsRef: React.MutableRefObject<WebSocket | null>;
  setMessages: React.Dispatch<React.SetStateAction<TerminalMessage[]>>;
}

export function useConsoleWsActions({ wsRef, setMessages }: UseConsoleWsActionsDeps) {
  // Requested directly (2026-07-29) after an AI query ran for 5+ minutes with no way to stop
  // it — CPU-only Ollama inference has no upper bound, and there was previously no cancel path
  // at all. Sends a 'cancel' WS message (server aborts the in-flight fetch or kills a running
  // trigger-mode command — see connection.js); the busy indicators clear themselves once the
  // server's own response to the cancel arrives, same as any other end-of-turn signal.
  const handleCancel = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }
  }, [wsRef]);

  // Switching chats/projects must stop a still-streaming AI turn — its tokens/tool output
  // would otherwise land in the newly-opened chat and its final answer would persist into
  // whatever session becomes current. Deliberately NOT handleCancel(): the 'cancel' message
  // also kills running commands/dev servers (see the 'cancel' case in connectionRoutes.js),
  // and switching chats must never tear down a dev server the user started (audit 2026-08-06,
  // Phase 3). 'abort_ai' releases the turn's confirm cards and aborts the query, nothing else.
  const handleAbortTurn = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'abort_ai' }));
    }
  }, [wsRef]);

  // Requested directly (2026-08-04): click on a non-blocking "did you mean" chip — sends
  // 'did_you_mean_pick' (server resolves a pending disambiguation question with the pick, or
  // dispatches the intent directly — see connection.js's routeMessage).
  const handleDidYouMeanPick = useCallback((intent: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'did_you_mean_pick', payload: { intent } }));
    }
  }, [wsRef]);

  // Dashboard Run/Stop-style one-click controls: sends the raw command through the tool
  // channel (risky: false — the server's own risk classifier still gates it).
  const handleDirectCommand = useCallback((command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setMessages(prev => [...prev, makeMessage('user', command)]);
    wsRef.current.send(JSON.stringify({
      type: 'execute_tool',
      payload: { tool: 'executeCommand', args: { command, risky: false } }
    }));
  }, [wsRef, setMessages]);

  return { handleCancel, handleAbortTurn, handleDidYouMeanPick, handleDirectCommand };
}