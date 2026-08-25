import React, { useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Terminal as TerminalIcon, ChevronDown, ChevronUp, Square, LayoutGrid, FolderOpen, History as HistoryIcon } from 'lucide-react';
import { shortCommand, portFromUrl } from '../utils/process';
import { CopyButton } from './ui/CopyButton';
import { HistoryPanel } from './HistoryPanel';
import { EmptyState } from './ui/EmptyState';
import { Skeleton } from './ui/Skeleton';

export interface ProcessInfo {
  projectId: string;
  command: string;
  pid: number | null;
  url: string | null;
  startedAt: string | null;
}

interface ProcessDockProps {
  processes: ProcessInfo[];
  processLogs: Record<string, string[]>;
  /** True while the first-selection ring-buffer replay is in flight (skeleton lines). */
  logLoading?: boolean;
  selectedProcessId: string | null;
  onSelectProcess: (projectId: string) => void;
  onStopProcess: (projectId: string) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  dockTab?: 'logs' | 'projects' | 'history';
  onSetDockTab?: (tab: 'logs' | 'projects' | 'history') => void;
  projects?: { id: string; name: string }[];
  activeProjectId?: string | null;
  onSendMessage?: (msg: string) => void;
  /** Phase T (2026-08-14): the tab whose workspace the History tab's REST call addresses. */
  tabId?: string | null;
}

/**
 * Phase 6 (PASS 6.2): bottom-collapsible Processes dock. Collapsed = one slim bar with a tab
 * per running process (command, port/URL, stop button); expanded = tab strip + live log area
 * fed from the same output/error_output stream the chat gets (server ring-buffer replay on
 * first selection + client-side live accumulation). Mounted as a flex-shrink-0 child inside
 * Terminal's root column — it pushes the chat area rather than overlaying it, so the chat
 * scroll container (flex-1 overflow-y-auto) is untouched.
 *
 * Phase 14 (PASS 3d): added a second expanded view — the Projects overview (every discovered
 * project + whether/where it's running, with per-project stop). The collapsed bar gains a
 * "Projects" tab next to the running toggle; the dock now also renders when nothing is
 * running (previously it auto-hid entirely), so the overview stays reachable as the project
 * list is the point of the tab.
 */
export function ProcessDock({
  processes,
  processLogs,
  logLoading = false,
  selectedProcessId,
  onSelectProcess,
  onStopProcess,
  expanded,
  onToggleExpanded,
  dockTab = 'logs',
  onSetDockTab,
  projects = [],
  activeProjectId = null,
  onSendMessage,
  tabId = null,
}: ProcessDockProps) {
  const lines = selectedProcessId ? (processLogs[selectedProcessId] || []) : [];
  // Audit 2026-08-17: join once per actual log change, not per render — the log body re-renders
  // on every chat message/dock state change otherwise.
  const logText = useMemo(() => lines.join('\n'), [lines]);

  // Phase 5: auto-scroll ONLY while the user is at (or near) the bottom of the log — reading
  // old output must not be yanked down by new chunks (same contract as TerminalMessages).
  // Switching the selected process forces a jump to the live tail regardless.
  const logContainerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevSelectedRef = useRef<string | null>(null);
  const handleLogScroll = () => {
    const el = logContainerRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    if (!expanded || dockTab !== 'logs') return;
    const el = logContainerRef.current;
    if (!el) return;
    const selectionChanged = prevSelectedRef.current !== selectedProcessId;
    prevSelectedRef.current = selectedProcessId;
    if (selectionChanged || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [expanded, dockTab, selectedProcessId, lines.length]);

  // Phase 5: out-of-band attribution. Output that arrives for a project the user is NOT
  // currently watching (scheduled fires, watchers, verify runs, auto-start) is invisible in
  // the chat and easy to miss in the dock — so a non-selected project that grows its log
  // gets an amber activity dot on its tab, cleared on selection. The log header also names
  // the selected project when it differs from the chat's active project.
  const [dirty, setDirty] = React.useState<Record<string, boolean>>({});
  const seenLengthsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const p of processes) {
      const len = (processLogs[p.projectId] || []).length;
      const seen = seenLengthsRef.current[p.projectId] ?? 0;
      if (len > seen && p.projectId !== selectedProcessId) {
        setDirty((d) => (d[p.projectId] ? d : { ...d, [p.projectId]: true }));
      }
      seenLengthsRef.current[p.projectId] = len;
    }
  }, [processes, processLogs, selectedProcessId]);

  const selectedProjectName = selectedProcessId
    ? projects.find((p) => p.id === selectedProcessId)?.name
    : undefined;
  const isOutOfBand = !!selectedProcessId && !!activeProjectId && selectedProcessId !== activeProjectId;

  // A project can track several processes at once (e.g. NetPulse's dashboard + watch loop).
  // The overview shows one row per project — prefer the process that exposes a URL so the
  // clickable link/port shown is the site, not the most recently started command.
  const runningByProject = new Map<string, ProcessInfo>();
  for (const p of processes) {
    const prev = runningByProject.get(p.projectId);
    if (!prev || (p.url && !prev.url)) runningByProject.set(p.projectId, p);
  }

  return (
    <AnimatePresence initial={false}>
      {(processes.length > 0 || projects.length > 0) && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="flex-shrink-0 border-t border-border-soft bg-surface/60 overflow-hidden"
        >
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                {dockTab === 'projects' ? (
                  <div className="max-h-64 overflow-y-auto p-3">
{projects.length === 0 ? (
                      <EmptyState
                        icon={<FolderOpen size={18} />}
                        title="No projects discovered yet"
                        hint="Scan a folder from the sidebar to populate the dock."
                        className="py-6"
                      />
                    ) : (
                      <div className="space-y-1">
                        {projects.map((proj) => {
                          const running = runningByProject.get(proj.id);
                          const port = running?.url ? portFromUrl(running.url) : null;
                          return (
                            <div
                              key={proj.id}
                              className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-xs ${
                                running
                                  ? 'bg-panel border-border-soft'
                                  : 'bg-transparent border-transparent'
                              }`}
                            >
                              <button
                                className="flex items-center gap-2 min-w-0 text-left"
                                title={running ? `Open log for ${proj.name}` : 'Not running'}
                                disabled={!running}
                                onClick={() => {
                                  if (!running) return;
                                  setDirty((d) => {
                                    if (!d[proj.id]) return d;
                                    const next = { ...d };
                                    delete next[proj.id];
                                    return next;
                                  });
                                  onSelectProcess(proj.id);
                                  onSetDockTab?.('logs');
                                }}
                              >
                                <FolderOpen size={12} className="text-fg-dim flex-shrink-0" />
                                <span className="truncate text-fg-muted hover:text-fg-strong">{proj.name}</span>
                                {running ? (
                                  <>
                                    <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse flex-shrink-0" />
                                    <span className="font-mono text-[10px] text-fg-subtle truncate">{shortCommand(running.command)}</span>
                                    {port && <span className="font-mono text-[10px] text-fg-dim flex-shrink-0">:{port}</span>}
                                  </>
                                ) : (
                                  <span className="text-[10px] text-fg-dim italic flex-shrink-0">idle</span>
                                )}
                              </button>
                              {running && (
                                <button
                                  onClick={() => onStopProcess(proj.id)}
                                  className="text-fg-faint hover:text-accent-red transition-colors flex-shrink-0"
                                  title={`Stop ${running.command}`}
                                >
                                  <Square size={10} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : dockTab === 'history' ? (
                  <HistoryPanel
                    projects={projects}
                    activeProjectId={activeProjectId}
                    onSendMessage={onSendMessage || (() => {})}
                    tabId={tabId}
                  />
                ) : (
                  <>
                    <div className="flex items-center justify-between px-4 pt-2">
                      <span className="text-[10px] text-fg-dim uppercase">
                        Live output
                        {isOutOfBand && selectedProjectName && (
                          <span className="ml-2 normal-case text-accent-orange" title="This output belongs to a project other than the one you are chatting in">
                            — {selectedProjectName}
                          </span>
                        )}
                      </span>
                      <CopyButton
                        text={logText}
                        title="Copy log"
                        size={10}
                        label="Copy"
                        feedback={false}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-panel hover:bg-panel-strong text-fg-dim hover:text-fg-strong transition-colors text-[10px]"
                      />
                    </div>
                    <div ref={logContainerRef} onScroll={handleLogScroll} className="max-h-64 overflow-y-auto p-3 font-mono text-xs text-fg-muted leading-relaxed whitespace-pre-wrap">
                      {logLoading ? (
                        <div className="space-y-1.5 py-1">
                          {[0, 1, 2, 3].map((i) => (
                            <Skeleton key={i} className="h-3 w-full" />
                          ))}
                        </div>
                      ) : (logText || 'No output yet.')}
                    </div>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto min-w-0 [scrollbar-width:thin]">
            <button
              onClick={() => {
                onSetDockTab?.('logs');
                onToggleExpanded();
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] text-fg-subtle hover:text-fg-strong hover:bg-panel transition-colors flex-shrink-0"
              title={expanded ? 'Collapse dock' : 'Expand dock'}
            >
              <TerminalIcon size={12} className="text-accent-blue" />
              <span>{processes.length} running</span>
              {expanded ? <ChevronDown size={12} className="text-fg-dim" /> : <ChevronUp size={12} className="text-fg-dim" />}
            </button>

            <button
              onClick={() => {
                // Phase 15: re-clicking Projects while it's the active expanded view collapses
                // the dock (toggle), matching the "N running" button — before, it was a no-op.
                if (expanded && dockTab === 'projects') {
                  onToggleExpanded();
                  return;
                }
                onSetDockTab?.('projects');
                if (!expanded) onToggleExpanded();
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] transition-colors flex-shrink-0 ${
                expanded && dockTab === 'projects'
                  ? 'bg-panel text-fg-strong border border-border-soft'
                  : 'text-fg-subtle hover:text-fg-strong hover:bg-panel'
              }`}
              title="All projects + where they're running"
            >
              <LayoutGrid size={12} className="text-accent-teal" />
              <span>Projects</span>
            </button>

            <button
              onClick={() => {
                // Phase 4: same toggle behavior as Projects — re-clicking while active collapses.
                if (expanded && dockTab === 'history') {
                  onToggleExpanded();
                  return;
                }
                onSetDockTab?.('history');
                if (!expanded) onToggleExpanded();
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] transition-colors flex-shrink-0 ${
                expanded && dockTab === 'history'
                  ? 'bg-panel text-fg-strong border border-border-soft'
                  : 'text-fg-subtle hover:text-fg-strong hover:bg-panel'
              }`}
              title="Action history + revert (file writes, edits, confirmed commands)"
            >
              <HistoryIcon size={12} className="text-indigo" />
              <span>History</span>
            </button>

            {processes.map((p) => {
              const selected = p.projectId === selectedProcessId;
              const port = p.url ? portFromUrl(p.url) : null;
              return (
                <div
                  key={`${p.projectId}:${p.pid ?? p.command}`}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono transition-colors flex-shrink-0 ${
                    selected
                      ? 'bg-accent-blue/20 border border-accent-blue/40 text-accent-blue'
                      : 'bg-panel border border-border-soft text-fg-subtle hover:text-fg-strong'
                  }`}
                >
                  <button
                    onClick={() => {
                      // Clearing the activity dot when the user actually looks at the log.
                      setDirty((d) => {
                        if (!d[p.projectId]) return d;
                        const next = { ...d };
                        delete next[p.projectId];
                        return next;
                      });
                      onSelectProcess(p.projectId);
                      onSetDockTab?.('logs');
                      if (!expanded) onToggleExpanded();
                    }}
                    className="flex items-center gap-1.5"
                    title={`${p.command}${p.startedAt ? ` — started ${new Date(p.startedAt).toLocaleTimeString()}` : ''}`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse flex-shrink-0" />
                    <span>{shortCommand(p.command)}</span>
                    {p.url && (
                      <span className={`text-[10px] ${selected ? 'text-accent-blue/70' : 'text-fg-dim'}`}>
                        :{port}
                      </span>
                    )}
                    {dirty[p.projectId] && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent-orange flex-shrink-0" title="New output arrived — click to view" />
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStopProcess(p.projectId);
                    }}
                    className="text-fg-faint hover:text-accent-red transition-colors flex-shrink-0"
                    title={`Stop ${p.command}`}
                  >
                    <Square size={10} />
                  </button>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
