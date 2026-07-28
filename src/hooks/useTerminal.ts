import { useState } from 'react';
import { Project, TerminalMessage, PendingMemorySuggestion } from '../types';

export function useTerminal(
  wsRef: React.MutableRefObject<WebSocket | null>,
  activeProject: Project | null,
  activeSessionId: string | null,
  setMessages: React.Dispatch<React.SetStateAction<TerminalMessage[]>>,
) {
  const [pendingConfirm, setPendingConfirm] = useState<{ token: string; command: string } | null>(null);
  const [pendingToolConfirm, setPendingToolConfirm] = useState<{ token: string; tool: string; args: any } | null>(null);
  const [pendingMemorySuggestion, setPendingMemorySuggestion] = useState<PendingMemorySuggestion | null>(null);

  const handleSendMessage = async (content: string) => {
    if (!activeProject || !wsRef.current) return;
    if (wsRef.current.readyState !== WebSocket.OPEN) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (wsRef.current?.readyState === WebSocket.OPEN) break;
      }
    }
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    setMessages(prev => [...prev, { id: Date.now().toString(), type: 'user', content }]);
    wsRef.current.send(JSON.stringify({
      type: 'execute',
      payload: { projectId: activeProject.id, input: content, sessionId: activeSessionId }
    }));
  };

  const handleConfirm = (confirmed: boolean) => {
    if (!pendingConfirm || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'confirm_response', payload: { token: pendingConfirm.token, confirmed } }));
    setPendingConfirm(null);
  };

  const handleToolConfirm = (confirmed: boolean) => {
    if (!pendingToolConfirm || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'confirm_response', payload: { token: pendingToolConfirm.token, confirmed } }));
    setPendingToolConfirm(null);
  };

  // Responds to a proactive project-memory nudge (see PendingMemorySuggestion) — the server
  // keys these by active project, not a token, so no token is sent back.
  const handleMemorySuggestionRespond = (accept: boolean) => {
    if (!pendingMemorySuggestion || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'memory_suggestion_respond', payload: { accept } }));
    setPendingMemorySuggestion(null);
  };

  return {
    pendingConfirm, setPendingConfirm,
    pendingToolConfirm, setPendingToolConfirm,
    pendingMemorySuggestion, setPendingMemorySuggestion,
    handleSendMessage, handleConfirm, handleToolConfirm, handleMemorySuggestionRespond,
  };
}
