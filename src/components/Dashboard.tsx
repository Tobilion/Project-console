import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, GitCommit, FileWarning, Globe, Terminal, FolderGit2, MessageSquare, UploadCloud, Copy, RefreshCw, Search, Radio, Play, Square } from 'lucide-react';
import { formatPath } from '../utils/formatPath';
import { apiFetchJson } from '../utils/apiFetch';
import { HistoryPanel } from './HistoryPanel';
import type { Project } from '../types';

interface DashboardEntry {
  id: string;
  name: string;
  path: string;
  workspaceType?: 'dev' | 'general';
  uncommitted: string[];
  recentCommits: string[];
  devUrl: string | null;
  running: boolean;
  runningCommand: string | null;
  isGitRepo: boolean;
  aheadCount: number;
  hasUpstream: boolean;
}

interface DashboardProps {
  onClose: () => void;
  refreshSignal?: number;
  projects: Project[];
  /** Phase 1: fallback mode for entries the server hasn't classified yet (pre-feature cache).
   *  Per-card rendering is driven by the entry's OWN workspaceType — the server persists the
   *  switch in console.config.json, so each card reflects its project's real mode. */
  workspaceMode?: 'dev' | 'general';
  onSelectProject: (p: Project) => Promise<void> | void;
  onSendMessage: (content: string) => Promise<void> | void;
}

type DashboardTab = 'projects' | 'live';

export const Dashboard = ({ onClose, refreshSignal = 0, projects, workspaceMode = 'dev', onSelectProject, onSendMessage }: DashboardProps) => {
  const [entries, setEntries] = useState<DashboardEntry[]>([]);
  const [tab, setTab] = useState<DashboardTab>('projects');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Phase 19: connected users (LAN attribution labels — hidden for the single-user case).
  const [users, setUsers] = useState<{ name: string }[]>([]);

  // Phase 1: a card in general mode hides git/npm/dev-server panels and actions behind a
  // placeholder — file tools/notes/reminders cards arrive in later phases (the roadmap
  // explicitly says not to invent fake data for them yet). Fallback to the dashboard-level
  // mode only when the server hasn't classified the entry (stale cache from before Phase 1).
  const entryMode = (e: DashboardEntry) => e.workspaceType ?? workspaceMode;

  const fetchDashboard = useCallback(async () => {
    const data = await apiFetchJson<DashboardEntry[]>('/api/dashboard');
    if (data) setEntries(data);
  }, []);

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
    setTimeout(() => setRefreshing(false), 400);
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
    await onSelectProject(project);
    await onSendMessage(text);
    onClose();
  };

  const handleOpenChat = async (entry: DashboardEntry) => {
    const project = projects.find((p) => p.id === entry.id);
    if (!project) return;
    await onSelectProject(project);
    onClose();
  };

  // Run/Stop route through the normal chat flow (same pattern as handlePush) — the command
  // lands on the same confirm cards the user would get from typing it, never a bypass.
  const handleRun = async (entry: DashboardEntry) => {
    const project = projects.find((p) => p.id === entry.id);
    if (!project) return;
    await onSelectProject(project);
    await onSendMessage('run the site');
    onClose();
  };

  const handleStop = async (entry: DashboardEntry) => {
    const project = projects.find((p) => p.id === entry.id);
    if (!project) return;
    await onSelectProject(project);
    await onSendMessage('stop the server');
    onClose();
  };

  const handleCopyPath = async (entry: DashboardEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((id) => (id === entry.id ? null : id)), 1500);
    } catch {
      // Clipboard API unavailable (non-HTTPS/non-localhost context) — silently no-op, nothing
      // sensitive is at stake and there's no good fallback UI for a stray copy button.
    }
  };

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0 flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-fg-strong">Dashboard</h2>
          <div className="flex items-center gap-1 bg-scrim-faint rounded-lg p-0.5 border border-border-soft">
            <button
              onClick={() => setTab('projects')}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${tab === 'projects' ? 'bg-panel-strong text-fg-strong' : 'text-fg-dim hover:text-fg-muted'}`}
            >
              Projects
            </button>
            <button
              onClick={() => setTab('live')}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${tab === 'live' ? 'bg-panel-strong text-fg-strong' : 'text-fg-dim hover:text-fg-muted'}`}
            >
              <Radio size={11} />
              Live Sites
              {liveEntries.length > 0 && <span className="text-[10px] text-fg-dim">({liveEntries.length})</span>}
            </button>
          </div>
          {totalUncommitted > 0 && (
            <span className="text-xs text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded">
              {totalUncommitted} uncommitted
            </span>
          )}
          {totalUnpushed > 0 && (
            <span className="text-xs text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded">
              {totalUnpushed} unpushed
            </span>
          )}
          {totalRunning > 0 && (
            <span className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded">
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
          <button onClick={handleManualRefresh} className="p-1 text-fg-dim hover:text-fg-strong transition-colors" title="Refresh">
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="p-1 text-fg-dim hover:text-fg-muted transition-colors">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1">
        {tab === 'live' ? (
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
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${entry.running ? 'bg-green-400 animate-pulse' : 'bg-fg-dim'}`} />
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
                  className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 flex-shrink-0 font-mono"
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
          <motion.div
            key={entry.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="bg-panel rounded-xl border border-border-soft p-4 cursor-pointer"
            onClick={() => setExpandedId((id) => (id === entry.id ? null : entry.id))}
          >
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <FolderGit2 size={16} className="text-[#00d4a3] flex-shrink-0" />
                <h3 className="text-sm font-bold text-fg-strong truncate">{entry.name}</h3>
               <span className="text-[10px] text-fg-dim font-mono truncate hidden lg:inline" title={entry.path}>
                   {formatPath(entry.path)}
                 </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {!isGeneral && (
                <>
                {entry.uncommitted.length > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded">
                    <FileWarning size={12} />
                    {entry.uncommitted.length}
                  </span>
                )}
                {entry.aheadCount > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded">
                    <UploadCloud size={12} />
                    {entry.aheadCount} unpushed
                  </span>
                )}
                {entry.runningCommand && (
                  <span className="flex items-center gap-1 text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">
                    <Terminal size={12} />
                    running
                  </span>
                )}
                {entry.devUrl && (
                  <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">
                    <Globe size={12} />
                    live
                  </span>
                )}
                </>
                )}
              </div>
            </div>

            {isGeneral ? (
              <div className="text-xs text-fg-dim border border-dashed border-border-soft rounded-lg px-3 py-4">
                <span className="text-fg-muted">General workspace</span> — file tools, notes, and
                reminders arrive in later phases. Open it in chat to browse or edit files.
              </div>
            ) : (
            <div className="grid grid-cols-12 gap-3 text-xs">
              <div className="col-span-3">
                <span className="text-[10px] tracking-wider uppercase text-fg-dim font-bold">Uncommitted</span>
                {entry.uncommitted.length > 0 ? (
                  <div className="mt-1 max-h-20 overflow-y-auto space-y-0.5 font-mono text-yellow-300/70">
                    {entry.uncommitted.slice(0, 10).map((line, j) => (
                      <div key={j} className="truncate">{line}</div>
                    ))}
                    {entry.uncommitted.length > 10 && (
                      <div className="text-fg-dim italic">+{entry.uncommitted.length - 10} more</div>
                    )}
                  </div>
                ) : (
                  <div className="mt-1 text-fg-dim italic">Clean</div>
                )}
              </div>

              <div className="col-span-7">
                <span className="text-[10px] tracking-wider uppercase text-fg-dim font-bold flex items-center gap-1">
                  <GitCommit size={12} />
                  Recent commits
                </span>
                {entry.recentCommits.length > 0 ? (
                  <div className="mt-1 space-y-0.5 font-mono text-fg-subtle">
                    {entry.recentCommits.map((line, j) => (
                      <div key={j} className="truncate">{line}</div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-fg-dim italic">No commits</div>
                )}
              </div>

              <div className="col-span-2">
                <span className="text-[10px] tracking-wider uppercase text-fg-dim font-bold">Status</span>
                <div className="mt-1 space-y-1 font-mono">
                  {entry.runningCommand ? (
                    <div className="text-blue-400 truncate" title={entry.runningCommand}>
                      <Terminal size={12} className="inline mr-1" />
                      {entry.runningCommand}
                    </div>
                  ) : null}
                  {entry.devUrl ? (
                    <a
                      href={entry.devUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-green-400 hover:text-green-300 truncate block"
                    >
                      <Globe size={12} className="inline mr-1" />
                      {entry.devUrl}
                    </a>
                  ) : null}
                  {!entry.runningCommand && !entry.devUrl ? (
                    <div className="text-fg-dim italic">Idle</div>
                  ) : null}
                </div>
              </div>
            </div>
            )}
            <AnimatePresence>
              {expandedId === entry.id && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div
                    className="flex items-center gap-2 pt-3 mt-3 border-t border-border-soft flex-wrap"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => handleOpenChat(entry)}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-scrim-faint hover:bg-panel-strong text-fg-strong border border-border-soft transition-colors"
                    >
                      <MessageSquare size={12} />
                      Open in chat
                    </button>
                    {!isGeneral && !entry.runningCommand && (
                      <button
                        onClick={() => handleRun(entry)}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-teal-500/10 hover:bg-teal-500/20 text-[#00d4a3] border border-teal-500/20 transition-colors"
                      >
                        <Play size={12} />
                        Run
                      </button>
                    )}
                    {!isGeneral && (entry.runningCommand || entry.devUrl) && (
                      <button
                        onClick={() => handleStop(entry)}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-colors"
                      >
                        <Square size={12} />
                        Stop
                      </button>
                    )}
                    {!isGeneral && needsPush(entry) && (
                      <button
                        onClick={() => handlePush(entry)}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-accent/10 hover:bg-accent/20 text-accent border border-accent/20 transition-colors"
                      >
                        <UploadCloud size={12} />
                        {entry.uncommitted.length > 0 ? 'Commit & push' : 'Push'}
                      </button>
                    )}
                    {!isGeneral && entry.devUrl && (
                      <a
                        href={entry.devUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 transition-colors"
                      >
                        <Globe size={12} />
                        Open site
                      </a>
                    )}
                    <button
                      onClick={() => handleCopyPath(entry)}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-scrim-faint hover:bg-panel-strong text-fg-dim border border-border-soft transition-colors"
                    >
                      <Copy size={12} />
                      {copiedId === entry.id ? 'Copied' : 'Copy path'}
                    </button>
                  </div>
                  <div
                    className="mt-3 pt-3 border-t border-border-soft"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <HistoryPanel
                      projects={[{ id: entry.id, name: entry.name }]}
                      activeProjectId={entry.id}
                      onSendMessage={onSendMessage}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
          );
        })}
        {entries.length === 0 && (
          <div className="text-sm text-fg-dim italic text-center py-12">
            No projects loaded — scan a directory to get started.
          </div>
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
