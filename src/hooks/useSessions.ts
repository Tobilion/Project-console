import { useState, useCallback } from 'react';
import { ChatSession, StoredSession, TerminalMessage, Project } from '../types';
import { storedToTerminalMessages } from '../utils/storedToTerminalMessages';
import { makeMessage } from '../utils/makeMessage';

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TerminalMessage[]>([]);
  const [showWelcome, setShowWelcome] = useState(true);

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
        // reload). Guard is handled inside storedToTerminalMessages.
        setMessages(storedToTerminalMessages(s.messages));
        return s;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('switchSession failed:', err);
      setMessages(prev => [...prev, makeMessage('error', 'Could not load that chat\'s history — please try again.')]);
    }
    return null;
  }, []);

  const deleteSession = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      // 404 = the session is already gone server-side — the row is stale either way, drop it.
      if (res.ok || res.status === 404) {
        setSessions(prev => prev.filter(s => s.id !== sessionId));
        if (activeSessionId === sessionId) {
          setActiveSessionId(null);
          setMessages([]);
        }
      } else {
        setMessages(prev => [...prev, makeMessage('error', 'Could not delete that chat — please try again.')]);
      }
    } catch {
      setMessages(prev => [...prev, makeMessage('error', 'Could not delete that chat — please try again.')]);
    }
  };

  const renameSession = async (sessionId: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t })
      });
      const data = await res.json();
      if (res.ok && data.session) {
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title: data.session.title } : s));
      } else {
        setMessages(prev => [...prev, makeMessage('error', 'Could not rename that chat — please try again.')]);
      }
    } catch {
      setMessages(prev => [...prev, makeMessage('error', 'Could not rename that chat — please try again.')]);
    }
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
    messages, setMessages,
    showWelcome, setShowWelcome,
    fetchSessions, createSession, switchSession, deleteSession, renameSession, linkSessionToProject,
  };
}
