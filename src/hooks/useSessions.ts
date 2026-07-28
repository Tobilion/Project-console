import { useState, useCallback } from 'react';
import { ChatSession, StoredSession, TerminalMessage, Project } from '../types';

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TerminalMessage[]>([]);
  const [showSessions, setShowSessions] = useState(true);
  const [showWelcome, setShowWelcome] = useState(true);
  const draftMessages = { current: messages };
  const draftSetMessages = setMessages;

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {}
  };

  const createSession = async (projectId?: string, projectName?: string) => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, projectName })
      });
      const data = await res.json();
      if (data.session) {
        setSessions(prev => [data.session, ...prev]);
        setActiveSessionId(data.session.id);
        setMessages([]);
      }
    } catch {}
  };

  const switchSession = useCallback(async (sessionId: string, projects?: Project[]) => {
    setActiveSessionId(sessionId);
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      const data = await res.json();
      if (data.session) {
        const s: StoredSession = data.session;
        // `s.messages` should always be an array (server-side bug previously let it come back
        // undefined for some sessions — see conversationStore.js's migrateLegacySession — which
        // threw here and got silently swallowed below, making a chat's history look wiped on
        // reload). Guard defensively either way instead of trusting the server unconditionally.
        setMessages((s.messages || []).map(m => ({
          id: m.id,
          type: m.role as TerminalMessage['type'],
          content: m.content
        })));
        return s;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('switchSession failed:', err);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        type: 'error',
        content: 'Could not load that chat\'s history — please try again.'
      }]);
    }
    return null;
  }, []);

  const deleteSession = async (sessionId: string) => {
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setMessages([]);
      }
    } catch {}
  };

  const linkSessionToProject = async (sessionId: string, projectId: string) => {
    try {
      await fetch(`/api/sessions/${sessionId}/link`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId })
      });
    } catch {}
  };

  return {
    sessions, setSessions, activeSessionId, setActiveSessionId,
    messages, setMessages, showSessions, setShowSessions,
    showWelcome, setShowWelcome, draftMessages, draftSetMessages,
    fetchSessions, createSession, switchSession, deleteSession, linkSessionToProject,
  };
}
