import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { X, FolderGit2, Globe, Radio, RefreshCw, Search } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { EmptyState } from './ui/EmptyState';
import { Skeleton } from './ui/Skeleton';
import type { Project } from '../types';
import { DashboardProjectCard } from './dashboard/projectCard';
import type { DashboardEntry } from './dashboard/projectCard';

interface DashboardProps {
  onClose: () => void;
  refreshSignal?: number;
  projects: Project[];
  /** Phase 1: fallback mode for entries the server hasn't classified yet (pre-feature cache).
   *  Per-card rendering is driven by the entry's OWN workspaceType — the server persists the
   *  switch in console.config.json, so each card reflects its project's real mode. */
  workspaceMode?: 'dev' | 'general';
  /** Server's current scan directory (used to shorten project paths for display). */
  scanPath?: string;
  /** Phase T (2026-08-14): the tab whose workspace the dashboard lists (null = global). */
  tabId?: string | null;
  onSelectProject: (p: Project) => Promise<void> | void;
  /** Phase 2 (2026-08-17): like onSelectProject but REUSES the project's open chat when one
   *  exists — card action buttons (Run/Stop/Push/Open chat) must not hijack the view into an
   *  empty new session. */
  onSelectProjectReuse: (p: Project) => Promise<void> | void;
  onSendMessage: (content: string) => Promise<void> | void;
  /** Phase 5: jump to the dock's log tab filtered to this project. */
  onViewLogs: (projectId: string) => void;
}

type DashboardTab = 'projects' | 'live';

export const Dashboard = ({ onClose, refreshSignal = 0, projects, workspaceMode = 'dev', scanPath, tabId = null, onSelectProject, onSelectProjectReuse, onSendMessage, onViewLogs }: DashboardProps) => {
  const [entries, setEntries] = useState<DashboardEntry[]>([]);
  const [tab, setTab] = useState<DashboardTab>('projects');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // True once the first dashboard fetch has resolved — the tab's empty states say "no
  // projects/URLs" which is misleading while the initial fetch is still in flight.
  const [loaded, setLoaded] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const refreshingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the transient-state timers on unmount so their delayed setState can't fire on a
  // dead dashboard (and hold its closures alive after it unmounted).
  useEffect(() => () => {
    if (refreshingTimer.current) clearTimeout(refreshingTimer.current);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  // Phase 19: connected users (LAN attribution labels — hidden for the single-user case).
  const [users, setUsers] = useState<{ name: string }[]>([]);

  // Phase 1: a card in general mode hides git/npm/dev-server panels and actions behind a
  // placeholder — file tools/notes/reminders cards arrive in later phases (the roadmap
  // explicitly says not to invent fake data for them yet). Fallback to the dashboard-level
  // mode only when the server hasn't classified the entry (stale cache from before Phase 1).
  const entryMode = (e: DashboardEntry) => e.workspaceType ?? workspaceMode;

  const fetchDashboard = useCallback(async () => {
    const q = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
    const data = await apiFetchJson<DashboardEntry[]>(`/api/dashboard${q}`);
    if (data) {
      setEntries(data);
      setLoaded(true);
      setFetchError(false);
    } else {
      // Server unreachable/failed — stop the perpetual "Loading…" spinner and surface the
      // failure with a retry (audit 2026-08-17: the old code only set loaded on success, so a
      // dead server left the Projects tab spinning forever).
      setLoaded(true);
      setFetchError(true);
    }
  }, [tabId]);

  useEffect(() => {
    fetchDashboard();
    const id = setInterval(fetchDashboard, 5000);
    return () => clearInterval(id);
  }, [fetchDashboard]);

  // Phase 19: poll connected users (same cadence as the dashboard refresh).
  useEffect(() => {
    let cancelled = false;
    const fetchUsers = async () => {
      const data = await apiFetchJson<{ users: { name: string }[] }>('/api/connected-users');
      if (!cancelled && data) setUsers(data.users || []);
    };
    fetchUsers();
    const id = setInterval(fetchUsers, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Re-fetch immediately when the server signals a state change via WebSocket
  useEffect(() => {
    if (refreshSignal > 0) fetchDashboard();
  }, [refreshSignal, fetchDashboard]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await fetchDashboard();
    if (refreshingTimer.current) clearTimeout(refreshingTimer.current);
    refreshingTimer.current = setTimeout(() => setRefreshing(false), 400);
  };

  // Dirty/running projects surface first — the ones that actually need attention shouldn't be
  // buried below a long list of idle, clean projects (QoL request, 2026-08-10).
  const filteredEntries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? entries.filter((e) => e.name.toLowerCase().includes(needle))
      : entries;
    return [...filtered].sort((a, b) => {
      const score = (e: DashboardEntry) =>
        (e.uncommitted.length > 0 || e.aheadCount > 0 ? 2 : 0) + (e.running || e.devUrl ? 1 : 0);
      return score(b) - score(a);
    });
  }, [entries, filter]);

  const liveEntries = useMemo(() => entries.filter((e) => e.devUrl), [entries]);

  const totalUncommitted = entries.reduce((sum, e) => sum + e.uncommitted.length, 0);
  const totalRunning = entries.filter(e => e.runningCommand || e.devUrl).length;
  const totalUnpushed = entries.filter(e => e.aheadCount > 0).length;

  const needsPush = (entry: DashboardEntry) => entry.isGitRepo && (entry.uncommitted.length > 0 || entry.aheadCount > 0 || !entry.hasUpstream);

  const handlePush = async (entry: DashboardEntry) => {
    const project = projects.find((p) => p.id === entry.id);
    if (!project) return;
    // Dirty working tree -> stage+commit+push so the button always "just works"; a clean tree
    // with commits already ahead only needs a bare push. Sent as a normal chat message (not a
    // direct/bypassed command) so it goes through the same confirm_prompt flow as if the user
    // had typed it themselves — the button is a shortcut into chat, not a silent auto-push.
    const text = entry.uncommitted.length > 0 ? 'commit and push my changes' : 'push my changes';
    await onSelectProjectReuse(project);
    await onSendMessage(text);
    onClose();
  };

  const handleOpenChat = async (entry: DashboardEntry) => {
    const project = projects.find((p) => p.id === entry.id);
    if (!project) return;
    await onSelectProjectReuse(project);
    onClose();
  };

  // Run/Stop route through the normal chat flow (same pattern as handlePush) — the command
  // lands on the same confirm cards the user would get from typing it, never a bypass.
  const handleRun = async (entry: DashboardEntry) => {
    const project = projects.find((p) => p.id === entry.id);
    if (!project) return;
    await onSelectProjectReuse(project);
    await onSendMessage('run the site');
    onClose();
  };

  const handleStop = async (entry: DashboardEntry) => {
    const project = projects.find((p) => p.id === entry.id);
    if (!project) return;
    await onSelectProjectReuse(project);
    await onSendMessage('stop the server');
    onClose();
  };

  const handleCopyPath = async (entry: DashboardEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
      setCopiedId(entry.id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId((id) => (id === entry.id ? null : id)), 1500);
    } catch {
      // Clipboard API unavailable (non-HTTPS/non-localhost context) — silently no-op, nothing
      // sensitive is at stake and there's no good fallback UI for a stray copy button.
    }
  };

  return (
    <div data-tour="dashboard-grid" className="flex flex-col gap-4 h-full overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0 flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-fg-strong">Dashboard</h2>
          <div className="flex items-center gap-1 bg-scrim-faint rounded-lg p-0.5 border border-border-soft">
            <button
              data-tour="dashboard-projects-tab"
              onClick={() => setTab('projects')}
              className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${tab === 'projects' ? 'bg-panel-strong text-fg-strong' : 'text-fg-dim hover:text-fg-muted'}`}
            >
              Projects
            </button>
            <button
              data-tour="dashboard-live-tab"
              onClick={() => setTab('live')}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg transition-colors ${tab === 'live' ? 'bg-panel-strong text-fg-strong' : 'text-fg-dim hover:text-fg-muted'}`}
            >
              <Radio size={11} />
              Live Sites
              {liveEntries.length > 0 && <span className="text-[10px] text-fg-dim">({liveEntries.length})</span>}
            </button>
          </div>
          {totalUncommitted > 0 && (
            <span className="text-xs text-accent-orange bg-accent-orange/10 px-2 py-0.5 rounded">
              {totalUncommitted} uncommitted
            </span>
          )}
          {totalUnpushed > 0 && (
            <span className="text-xs text-accent-orange bg-accent-orange/10 px-2 py-0.5 rounded">
              {totalUnpushed} unpushed
            </span>
          )}
          {totalRunning > 0 && (
            <span className="text-xs text-accent-green bg-accent-green/10 px-2 py-0.5 rounded">
              {totalRunning} running
            </span>
          )}
          {users.length > 1 && (
            <span className="text-xs text-accent bg-accent/10 px-2 py-0.5 rounded" title="Connected users (LAN mode — attribution labels, no accounts)">
              {users.length} connected: {users.map((u) => u.name).join(', ')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {tab === 'projects' && (
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter projects..."
                className="pl-6 pr-2 py-1 text-xs bg-scrim-faint border border-border-soft rounded-lg text-fg-strong placeholder:text-fg-dim focus:outline-none focus:border-accent/50 w-40"
              />
            </div>
          )}
          <button onClick={handleManualRefresh} className="p-2 text-fg-dim hover:text-fg-strong transition-colors" title="Refresh">
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="p-2 text-fg-dim hover:text-fg-muted transition-colors" aria-label="Close dashboard">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1">
        {!loaded && entries.length === 0 ? (
          <div className="text-sm text-fg-dim italic text-center py-12">Loading…</div>
        ) : fetchError && entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <p className="text-sm text-fg-muted">Could not reach the server.</p>
            <button onClick={() => { setLoaded(false); setFetchError(false); fetchDashboard(); }} className="px-4 h-9 rounded-lg bg-accent-blue text-white text-xs font-semibold hover:bg-accent-blue/80 transition-colors">
              Retry
            </button>
          </div>
        ) : tab === 'live' ? (
          liveEntries.length === 0 ? (
            <div className="text-sm text-fg-dim italic text-center py-12">
              No projects have a known dev URL yet — start a dev server from a project's chat to record one.
            </div>
          ) : (
            liveEntries.map((entry, i) => (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="bg-panel rounded-xl border border-border-soft p-4 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* Live truth comes from the server's probe at dashboard-build time (entry.running),
                      NOT runningCommand — there'd otherwise always be tracked-process absence for the
                      console's own card and for servers started outside this console (reported live
                      2026-08-11: both showed "process not currently running" while answering). */}
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${entry.running ? 'bg-accent-green animate-pulse' : 'bg-fg-dim'}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-fg-strong truncate">{entry.name}</div>
                    <div className="text-[10px] text-fg-dim">
                      {entry.running ? 'live now' : 'recorded — not currently answering'}
                    </div>
                  </div>
                </div>
                <a
                  href={entry.devUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-accent-green hover:text-accent-green/80 flex-shrink-0 font-mono"
                >
                  <Globe size={12} />
                  {entry.devUrl}
                </a>
              </motion.div>
            ))
          )
        ) : (
        <>
        {filteredEntries.map((entry, i) => {
          const isGeneral = entryMode(entry) === 'general';
          return (
            <DashboardProjectCard
              key={entry.id}
              entry={entry}
              isGeneral={isGeneral}
              expanded={expandedId === entry.id}
              copiedId={copiedId === entry.id}
              needsPush={needsPush(entry)}
              scanPath={scanPath}
              index={i}
              onToggleExpand={() => setExpandedId((id) => (id === entry.id ? null : entry.id))}
              onOpenChat={() => handleOpenChat(entry)}
              onViewLogs={() => onViewLogs(entry.id)}
              onRun={() => handleRun(entry)}
              onStop={() => handleStop(entry)}
              onPush={() => handlePush(entry)}
              onCopyPath={() => handleCopyPath(entry)}
              onSendMessage={onSendMessage}
            />
          );
        })}
        {entries.length === 0 && !loaded && !fetchError && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 py-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        )}
        {entries.length === 0 && loaded && !fetchError && (
          <EmptyState
            icon={<FolderGit2 size={18} />}
            title="No projects loaded"
            hint="Scan a directory to get started — paste a folder path into the scan box in the sidebar."
            className="py-12"
          />
        )}
        {entries.length > 0 && filteredEntries.length === 0 && (
          <div className="text-sm text-fg-dim italic text-center py-12">
            No projects match "{filter}".
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
};
