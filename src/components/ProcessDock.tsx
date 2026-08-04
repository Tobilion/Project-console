import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Terminal as TerminalIcon, ChevronDown, ChevronUp, Square } from 'lucide-react';
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
}

/**
 * Phase 6 (PASS 6.2): bottom-collapsible Processes dock. Collapsed = one slim bar with a tab
 * per running process (command, port/URL, stop button); expanded = tab strip + live log area
 * fed from the same output/error_output stream the chat gets (server ring-buffer replay on
 * first selection + client-side live accumulation). Mounted as a flex-shrink-0 child inside
 * Terminal's root column — it pushes the chat area rather than overlaying it, so the chat
 * scroll container (flex-1 overflow-y-auto) is untouched.
 */
export function ProcessDock({
  processes,
  processLogs,
  selectedProcessId,
  onSelectProcess,
  onStopProcess,
  expanded,
  onToggleExpanded,
}: ProcessDockProps) {
  const lines = selectedProcessId ? (processLogs[selectedProcessId] || []) : [];
  const logText = lines.join('\n');
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded && lines.length > 0) {
      logEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [expanded, lines.length]);

  return (
    <AnimatePresence initial={false}>
      {processes.length > 0 && (
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
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto">
            <button
              onClick={onToggleExpanded}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] text-fg-subtle hover:text-fg-strong hover:bg-panel transition-colors flex-shrink-0"
              title={expanded ? 'Collapse dock' : 'Expand dock'}
            >
              <TerminalIcon size={12} className="text-[#3d6bff]" />
              <span>{processes.length} running</span>
              {expanded ? <ChevronDown size={12} className="text-fg-dim" /> : <ChevronUp size={12} className="text-fg-dim" />}
            </button>

            {processes.map((p) => {
              const selected = p.projectId === selectedProcessId;
              const port = p.url ? portFromUrl(p.url) : null;
              return (
                <div
                  key={p.projectId}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono transition-colors flex-shrink-0 ${
                    selected
                      ? 'bg-[#3d6bff]/20 border border-[#3d6bff]/40 text-[#3d6bff]'
                      : 'bg-panel border border-border-soft text-fg-subtle hover:text-fg-strong'
                  }`}
                >
                  <button
                    onClick={() => onSelectProcess(p.projectId)}
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
