import { useState, useCallback, useRef } from 'react';
import { ChatSession, StoredSession, TerminalMessage, Project } from '../types';
import { storedToTerminalMessages } from '../utils/storedToTerminalMessages';
import { makeMessage } from '../utils/makeMessage';

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TerminalMessage[]>([]);
  const [showWelcome, setShowWelcome] = useState(true);
  // Phase 6 (2026-08-17): pagination bookkeeping — how many stored messages the buffer
  // holds (`loadedHistory`) vs how many the log actually contains (`historyTotal`, from the
  // session index's messageCount). "Load earlier" stays visible until they're equal.
  const [historyTotal, setHistoryTotal] = useState(0);
  const [loadedHistory, setLoadedHistory] = useState(0);
  const loadingEarlierRef = useRef(false);

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err) {
      // Keep the previous (possibly stale) list — but don't fail silently: a dead server
      // otherwise looks like "no chats" with zero signal (audit 2026-08-17).
      // eslint-disable-next-line no-console
      console.error('fetchSessions failed:', err);
    }
  };

  const createSession = async (projectId?: string, projectName?: string, tabId?: string | null) => {
    try {
      const q = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
      const res = await fetch(`/api/sessions${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, projectName })
      });
      const data = await res.json();
      if (data.session) {
        setSessions(prev => [data.session, ...prev]);
        setActiveSessionId(data.session.id);
        setMessages([]);
        setHistoryTotal(0);
        setLoadedHistory(0);
        return data.session;
      }
    } catch {}
    // Failed create: never leave the previous conversation (which may belong to another tab)
    // visible under a null/stale active session — clear it so the caller lands on a clean slate.
    setActiveSessionId(null);
    setMessages([]);
    setHistoryTotal(0);
    setLoadedHistory(0);
    return null;
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
        setLoadedHistory(s.messages?.length || 0);
        setHistoryTotal(typeof data.total === 'number' ? data.total : (s.messages?.length || 0));
        return s;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('switchSession failed:', err);
      // Replace the buffer rather than appending — keeping the previous conversation's messages
      // here is how another tab's chat leaked into view after a failed tab switch.
      setMessages([makeMessage('error', 'Could not load that chat\'s history — please try again.')]);
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

  // Phase 6: fetch the page of stored messages BEFORE the ones already in the buffer and
  // prepend them. `before` = how many of the newest messages the client already holds, so
  // pages never overlap and nothing is skipped if new messages arrived meanwhile (they're
  // all in the skipped tail).
  const loadEarlierMessages = async () => {
    const sessionId = activeSessionId;
    if (!sessionId || loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    try {
      const res = await fetch(`/api/sessions/${sessionId}?before=${loadedHistory}&limit=200`);
      const data = await res.json();
      if (data.session && Array.isArray(data.session.messages) && data.session.messages.length > 0) {
        setMessages(prev => [...storedToTerminalMessages(data.session.messages), ...prev]);
        setLoadedHistory(loadedHistory + data.session.messages.length);
        setHistoryTotal(typeof data.total === 'number' ? data.total : historyTotal);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('loadEarlierMessages failed:', err);
    } finally {
      loadingEarlierRef.current = false;
    }
  };

  // Tab-switch reset (Phase T fix, 2026-08-14): the conversation buffer is shared by all tabs
  // and reloaded per switch. Clearing it up front guarantees a failed session create/load can
  // never leave the PREVIOUS tab's chat visible on the arriving tab.
  const resetConversation = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setHistoryTotal(0);
    setLoadedHistory(0);
  }, []);

  return {
    sessions, setSessions, activeSessionId, setActiveSessionId,
    messages, setMessages,
    showWelcome, setShowWelcome,
    historyTotal, loadedHistory, loadEarlierMessages,
    fetchSessions, createSession, switchSession, deleteSession, renameSession, linkSessionToProject,
    resetConversation,
  };
}
