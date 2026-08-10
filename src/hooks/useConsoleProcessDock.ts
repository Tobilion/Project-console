import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../types';
import { apiFetchJson } from '../utils/apiFetch';

/** Live view of a tracked process (GET /api/processes — the server's runningProcesses map). */
export interface ProcessInfo {
  projectId: string;
  command: string;
  pid: number | null;
  url: string | null;
  startedAt: string | null;
}

/**
 * Phase 6 (PASS 6.1/6.2) Processes-dock state, extracted from useConsole.ts. `processes`
 * mirrors GET /api/processes (refetched on mount, on every 'processes_update' WS event, and
 * with the 5s active-servers poll — the poll lives in the useConsole orchestrator's mount
 * effect). `processLogs` is a per-process line tail capped at 2000 (matching the server-side
 * ring buffer): live chunks append from the incoming output/error_output stream, and the
 * server-side history is replayed into the log the first time a tab is selected so a
 * reconnecting client still sees recent output.
 *
 * `getActiveProject` is a ref-read getter (not a value) so the callbacks never go stale —
 * commands always run for the session's active project, which is where live output chunks
 * are attributed.
 */
export function useConsoleProcessDock(
  wsRef: React.MutableRefObject<WebSocket | null>,
  getActiveProject: () => Project | null,
) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [processLogs, setProcessLogs] = useState<Record<string, string[]>>({});
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [dockExpanded, setDockExpanded] = useState(false);
  // Phase 14 (PASS 3d): which expanded view the dock shows — the live process logs (default,
  // Phase 6 behavior) or the new Projects overview (every discovered project + whether/where
  // it's running). Tabs in the collapsed bar switch between them; selecting a process tab or
  // the running toggle switches back to 'logs'.
  const [dockTab, setDockTab] = useState<'logs' | 'projects' | 'history'>('logs');

  // Phase 6 (PASS 6.1): live view of runningProcesses for the dock. Prunes logs of dead
  // projects and keeps the selected tab valid (prefer the session's active project, fall back
  // to the first running one).
  const fetchProcesses = useCallback(async () => {
    const list = await apiFetchJson<ProcessInfo[]>('/api/processes');
    if (!list) return;
    setProcesses(list);
    const runningIds = new Set(list.map((p: any) => p.projectId));
    setProcessLogs(prev => {
      const next: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(prev)) if (runningIds.has(k)) next[k] = v;
      return next;
    });
    setSelectedProcessId(cur => {
      if (cur && runningIds.has(cur)) return cur;
      const activeId = getActiveProject()?.id;
      if (activeId && runningIds.has(activeId)) return activeId;
      return list[0]?.projectId || null;
    });
  }, [getActiveProject]);

  // Phase 6 (PASS 6.2): replay the server ring buffer for a process log into the dock.
  const fetchProcessLog = useCallback(async (projectId: string) => {
    const data = await apiFetchJson<{ lines: string[] }>(`/api/processes/${encodeURIComponent(projectId)}/log`);
    if (!data) return;
    if (Array.isArray(data.lines)) setProcessLogs(prev => ({ ...prev, [projectId]: data.lines }));
  }, []);

  // Phase 6 (PASS 6.2): tail accumulation for the dock log. Commands always run for the
  // session's active project, so incoming stdout/stderr chunks are attributed to it.
  const appendProcessOutput = useCallback((text: string) => {
    const pid = getActiveProject()?.id;
    if (!pid) return;
    setProcessLogs(prev => {
      const lines = [...(prev[pid] || []), ...text.split('\n')];
      if (lines.length > 2000) lines.splice(0, lines.length - 2000);
      return { ...prev, [pid]: lines };
    });
  }, [getActiveProject]);

  // Phase 6 (PASS 6.2): Processes-dock stop button — sends 'stop_process' (server routes it
  // through the same shared stopTrackedProcess path "stop server" and the AI stopProcess tool
  // use; no new kill logic).
  const handleStopProcess = useCallback((projectId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop_process', payload: { projectId } }));
    }
  }, [wsRef]);

  // Phase 6 (PASS 6.2): replay the server-side ring buffer the first time a dock tab is
  // selected. After that the live output/error_output stream (client-side accumulation) keeps
  // the log current — re-fetching later would overwrite fresher client lines with a slightly
  // older server snapshot, so it's fetch-on-first-selection only.
  const prevSelectedProcessRef = useRef<string | null>(null);
  useEffect(() => {
    const pid = selectedProcessId;
    if (!pid) return;
    setProcessLogs(prev => (prev[pid] ? prev : { ...prev, [pid]: [] }));
    const firstTime = prevSelectedProcessRef.current !== pid;
    prevSelectedProcessRef.current = pid;
    if (firstTime) fetchProcessLog(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProcessId, fetchProcessLog]);

  return {
    processes,
    processLogs,
    selectedProcessId,
    setSelectedProcessId,
    dockExpanded,
    setDockExpanded,
    dockTab,
    setDockTab,
    fetchProcesses,
    fetchProcessLog,
    appendProcessOutput,
    handleStopProcess,
  };
}
