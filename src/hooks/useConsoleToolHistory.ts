import { useCallback, useState } from 'react';
import type { ToolCallEntry, TerminalMessage } from '../types';
import { makeMessage } from '../utils/makeMessage';

/**
 * Tool-call history for the trace panel, extracted from useConsole.ts. `addToolCall` is fed
 * by the 'tool_result' WS case (via the WsCtx bag); `rerunToolCall` re-sends a non-gated tool
 * call through the same execute_tool message the rest of the UI uses.
 */
export function useConsoleToolHistory(
  wsRef: React.MutableRefObject<WebSocket | null>,
  setMessages: React.Dispatch<React.SetStateAction<TerminalMessage[]>>,
) {
  const [toolHistory, setToolHistory] = useState<ToolCallEntry[]>([]);
  const [showToolHistory, setShowToolHistory] = useState(false);

  const addToolCall = useCallback((tool: string, args: Record<string, any>, result: any) => {
    const isGated = ['writeFile', 'editFile', 'insertAtLine'].includes(tool) ||
      (tool === 'executeCommand' && args?.risky);
    setToolHistory(prev => [{
      id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
      tool, args, result,
      timestamp: Date.now(),
      gated: isGated,
    }, ...prev].slice(0, 100));
  }, []);

  const rerunToolCall = useCallback((entry: ToolCallEntry) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (entry.gated) {
      setMessages(prev => [...prev, makeMessage(
        'system',
        `To re-run a gated tool (${entry.tool}), switch to AI mode and describe what you want. This tool (${entry.tool}) requires approval before running.`
      )]);
      return;
    }
    wsRef.current.send(JSON.stringify({
      type: 'execute_tool',
      payload: { tool: entry.tool, args: entry.args }
    }));
  }, [wsRef, setMessages]);

  return {
    toolHistory,
    showToolHistory,
    setShowToolHistory,
    addToolCall,
    rerunToolCall,
  };
}
