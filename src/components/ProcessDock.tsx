import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Terminal as TerminalIcon, ChevronDown, ChevronUp, Square, LayoutGrid, FolderOpen } from 'lucide-react';
import { shortCommand, portFromUrl } from '../utils/process';
import { CopyButton } from './ui/CopyButton';

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
  selectedProcessId: string | null;
  onSelectProcess: (projectId: string) => void;
  onStopProcess: (projectId: string) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  dockTab?: 'logs' | 'projects';
  onSetDockTab?: (tab: 'logs' | 'projects') => void;
  projects?: { id: string; name: string }[];
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
  selectedProcessId,
  onSelectProcess,
  onStopProcess,
  expanded,
  onToggleExpanded,
  dockTab = 'logs',
  onSetDockTab,
  projects = [],
}: ProcessDockProps) {
  const lines = selectedProcessId ? (processLogs[selectedProcessId] || []) : [];
  const logText = lines.join('\n');
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded && dockTab === 'logs' && lines.length > 0) {
      logEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [expanded, dockTab, lines.length]);

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
                      <div className="text-xs text-fg-faint px-1">No projects discovered yet — scan a folder first.</div>
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
                                  onSelectProcess(proj.id);
                                  onSetDockTab?.('logs');
                                }}
                              >
                                <FolderOpen size={12} className="text-fg-dim flex-shrink-0" />
                                <span className="truncate text-fg-muted hover:text-fg-strong">{proj.name}</span>
                                {running ? (
                                  <>
                                    <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] animate-pulse flex-shrink-0" />
                                    <span className="font-mono text-[10px] text-fg-subtle truncate">{shortCommand(running.command)}</span>
                                    {port && <span className="font-mono text-[10px] text-fg-faint flex-shrink-0">:{port}</span>}
                                  </>
                                ) : (
                                  <span className="text-[10px] text-fg-faint italic flex-shrink-0">idle</span>
                                )}
                              </button>
                              {running && (
                                <button
                                  onClick={() => onStopProcess(proj.id)}
                                  className="text-fg-faint hover:text-red-400 transition-colors flex-shrink-0"
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
                ) : (
                  <>
                    <div className="flex items-center justify-between px-4 pt-2">
                      <span className="text-[10px] text-fg-faint uppercase">Live output</span>
                      <CopyButton
                        text={logText}
                        title="Copy log"
                        size={10}
                        label="Copy"
                        feedback={false}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-panel hover:bg-panel-strong text-fg-dim hover:text-fg-strong transition-colors text-[10px]"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto p-3 font-mono text-xs text-fg-muted leading-relaxed whitespace-pre-wrap">
                      {logText || 'No output yet.'}
                      <div ref={logEndRef} />
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
              <TerminalIcon size={12} className="text-[#3d6bff]" />
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
              <LayoutGrid size={12} className="text-[#00d4a3]" />
              <span>Projects</span>
            </button>

            {processes.map((p) => {
              const selected = p.projectId === selectedProcessId;
              const port = p.url ? portFromUrl(p.url) : null;
              return (
                <div
                  key={`${p.projectId}:${p.pid ?? p.command}`}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono transition-colors flex-shrink-0 ${
                    selected
                      ? 'bg-[#3d6bff]/20 border border-[#3d6bff]/40 text-[#3d6bff]'
                      : 'bg-panel border border-border-soft text-fg-subtle hover:text-fg-strong'
                  }`}
                >
                  <button
                    onClick={() => {
                      onSelectProcess(p.projectId);
                      onSetDockTab?.('logs');
                      if (!expanded) onToggleExpanded();
                    }}
                    className="flex items-center gap-1.5"
                    title={`${p.command}${p.startedAt ? ` — started ${new Date(p.startedAt).toLocaleTimeString()}` : ''}`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] animate-pulse flex-shrink-0" />
                    <span>{shortCommand(p.command)}</span>
                    {p.url && (
                      <span className={`text-[10px] ${selected ? 'text-[#3d6bff]/70' : 'text-fg-faint'}`}>
                        :{port}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStopProcess(p.projectId);
                    }}
                    className="text-fg-faint hover:text-red-400 transition-colors flex-shrink-0"
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
