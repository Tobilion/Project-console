import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ToolCallEntry } from '../types';
import { Terminal as TerminalIcon, Copy, RotateCcw, X, ChevronDown, ChevronUp } from 'lucide-react';

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
          className="border-t border-white/10 bg-[#12151c]/60 overflow-hidden"
        >
          <div className="max-h-64 overflow-y-auto p-3 space-y-2">
            {toolHistory.length === 0 ? (
              <div className="text-center py-6 text-gray-600 text-xs font-mono">No tool calls yet</div>
            ) : (
              toolHistory.map((entry) => {
                const isExpanded = expandedId === entry.id;
                const hasError = entry.result?.error || entry.result?.success === false;
                return (
                  <div key={entry.id} className="bg-black/30 border border-white/10 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors text-left"
                    >
                      <TerminalIcon size={12} className={hasError ? 'text-red-400' : 'text-[#3d6bff]'} />
                      <span className="text-xs font-mono text-gray-300 flex-1">{entry.tool}</span>
                      {entry.gated && <span className="text-[10px] text-orange-400/60 font-mono">gated</span>}
                      <span className="text-[10px] text-gray-600 font-mono">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      {isExpanded ? <ChevronUp size={12} className="text-gray-500" /> : <ChevronDown size={12} className="text-gray-500" />}
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-2">
                        <div>
                          <p className="text-[10px] text-gray-600 font-mono mb-1 uppercase">Args</p>
                          <pre className="text-[11px] text-gray-400 font-mono bg-black/30 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(entry.args, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <p className="text-[10px] text-gray-600 font-mono mb-1 uppercase">Result</p>
                          <pre className={`text-[11px] font-mono bg-black/30 rounded p-2 overflow-x-auto whitespace-pre-wrap ${hasError ? 'text-red-400' : 'text-gray-400'}`}>
                            {typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result, null, 2)}
                          </pre>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              const text = JSON.stringify({ tool: entry.tool, args: entry.args }, null, 2);
                              navigator.clipboard.writeText(text);
                            }}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-gray-500 hover:text-gray-200 transition-colors text-[10px] font-mono"
                          >
                            <Copy size={10} /> Copy
                          </button>
                          <button
                            onClick={() => onRerun(entry)}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-gray-500 hover:text-teal-400 transition-colors text-[10px] font-mono"
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
