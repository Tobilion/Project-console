import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ToolCallEntry } from '../types';
import { Terminal as TerminalIcon, RotateCcw, X, ChevronDown, ChevronUp } from 'lucide-react';
import { CopyButton } from './ui/CopyButton';

interface ToolHistoryPanelProps {
  toolHistory: ToolCallEntry[];
  show: boolean;
  onToggle: () => void;
  onRerun: (entry: ToolCallEntry) => void;
}

export function ToolHistoryPanel({ toolHistory, show, onToggle, onRerun }: ToolHistoryPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
className="border-t border-border-soft bg-surface/60 overflow-hidden"
          >
            <div className="max-h-64 overflow-y-auto p-3 space-y-2">
              {toolHistory.length === 0 ? (
              <div className="text-center py-6 text-fg-dim text-xs">No tool calls yet</div>
            ) : (
              toolHistory.map((entry) => {
                const isExpanded = expandedId === entry.id;
                const hasError = entry.result?.error || entry.result?.success === false;
                return (
                  <div key={entry.id} className="bg-scrim-faint border border-border-soft rounded-lg overflow-hidden">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-panel transition-colors text-left"
                    >
                      <TerminalIcon size={12} className={hasError ? 'text-accent-red' : 'text-accent-blue'} />
                      <span className="text-xs font-mono text-fg-muted flex-1">{entry.tool}</span>
                      {entry.gated && <span className="text-[10px] text-accent-orange/60">gated</span>}
                      <span className="text-[10px] text-fg-dim">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      {isExpanded ? <ChevronUp size={12} className="text-fg-dim" /> : <ChevronDown size={12} className="text-fg-dim" />}
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-2">
                        <div>
                          <p className="text-[10px] text-fg-dim mb-1 uppercase">Args</p>
                          <pre className="text-[11px] text-fg-subtle font-mono bg-scrim-faint rounded p-2 overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(entry.args, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <p className="text-[10px] text-fg-dim mb-1 uppercase">Result</p>
                          <pre className={`text-[11px] font-mono bg-scrim-faint rounded p-2 overflow-x-auto whitespace-pre-wrap ${hasError ? 'text-accent-red' : 'text-fg-subtle'}`}>
                            {typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result, null, 2)}
                          </pre>
                        </div>
                        <div className="flex gap-2">
                          <CopyButton
                            text={JSON.stringify({ tool: entry.tool, args: entry.args }, null, 2)}
                            title="Copy"
                            size={10}
                            label="Copy"
                            feedback={false}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-panel hover:bg-panel-strong text-fg-dim hover:text-fg-strong transition-colors text-[10px]"
                          />
                          <button
                            onClick={() => onRerun(entry)}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-panel hover:bg-panel-strong text-fg-dim hover:text-accent-teal transition-colors text-[10px]"
                          >
                            <RotateCcw size={10} /> {entry.gated ? 'Switch to AI' : 'Re-run'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
