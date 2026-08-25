// Mount lifecycle + background polling (2026-08-24, split out of useConsole.ts): the
// session fetch, WS connect, tab restore, Ollama status probe, active-servers poll and the
// 5s dashboard/process refresh loop. One concern — "what runs while the app is open" —
// with the cleanup (disconnect + interval clear) in the same place it mounts.

import { useEffect, useCallback } from 'react';
import { apiFetchJson } from '../utils/apiFetch';

export interface UseConsolePollingDeps {
  fetchSessions: () => void;
  connectWebSocket: () => void;
  disconnect: () => void;
  restoreTabs: () => void;
  fetchOllamaStatus: () => void;
  fetchProcesses: () => void;
  setActiveServers: React.Dispatch<React.SetStateAction<Array<{ projectId: string; command: string; pid: number | null; url: string | null }>>>;
  setKnownDevUrls: React.Dispatch<React.SetStateAction<string[]>>;
}

export function useConsolePolling({
  fetchSessions,
  connectWebSocket,
  disconnect,
  restoreTabs,
  fetchOllamaStatus,
  fetchProcesses,
  setActiveServers,
  setKnownDevUrls,
}: UseConsolePollingDeps) {
  const fetchActiveServers = useCallback(async () => {
    const data = await apiFetchJson<Array<{ projectId: string; command: string; pid: number | null; url: string | null }>>('/api/active-servers');
    if (data) {
      setActiveServers(data);
      const urls = data.map(s => s.url).filter((u): u is string => !!u);
      // Audit 2026-08-17: keep the array IDENTITY stable when nothing is actually new — the
      // old Set-spread rebuilt the array on every poll even with zero additions, which
      // re-rendered TerminalMessages (its URL-chip check reads this array) on every 5s poll.
      if (urls.length) setKnownDevUrls(prev => {
        const added = urls.filter(u => !prev.includes(u));
        return added.length ? [...prev, ...added] : prev;
      });
    }
  }, [setActiveServers, setKnownDevUrls]);

  // Phase T2 fix (2026-08-14): restoreTabs used to be awaited BEFORE fetchSessions/WS
  // connect, so a slow multi-tab restore (each persisted tab re-scans its root server-side)
  // left the chat list empty and the socket unconnected for a long time — history looked
  // wiped. Sessions + WS now start immediately; tab restore runs in the background and
  // swaps the active tab's project list in when it finishes.
  useEffect(() => {
    fetchSessions();
    connectWebSocket();
    restoreTabs();
    fetch('/api/ollama/status').then(r => r.ok ? r.json() : null).then(s => { if (s) fetchOllamaStatus(); }).catch(() => {});
    fetchActiveServers();
    fetchProcesses();
    const serverPollId = setInterval(() => {
      fetchActiveServers();
      fetchProcesses();
    }, 5000);
    return () => {
      clearInterval(serverPollId);
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}