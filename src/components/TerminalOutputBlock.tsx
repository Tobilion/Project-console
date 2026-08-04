import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Terminal as TerminalIcon, Copy, ChevronDown, ChevronUp } from 'lucide-react';

/** Phase 6 (PASS 6.3): a command's output rendered as a collapsible terminal-style block —
 *  dark mono, capped height + scroll, copy button, auto-collapsed. The header keeps the ▶
 *  start line visible at all times; the body expands on click. */
export function OutputBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const firstLine = content.split('\n').find(l => l.trim()) || content;
  const displayCommand = firstLine.replace(/^Executing:\s*/, '').trim();
  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="w-full rounded-lg border border-border bg-surface overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 flex-1 text-left min-w-0" title={expanded ? 'Collapse output' : 'Expand output'}>
          <TerminalIcon size={12} className="text-accent flex-shrink-0" />
          <span className="text-xs font-mono text-muted-foreground truncate">▶ {displayCommand || 'command output'}</span>
        </button>
        <button onClick={handleCopy} className="text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0" title="Copy output">
          {copied ? <span className="text-[10px] text-teal-400">Copied</span> : <Copy size={11} />}
        </button>
        <button onClick={() => setExpanded(!expanded)} className="text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0" title={expanded ? 'Collapse output' : 'Expand output'}>
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-border"
          >
            <pre className="max-h-64 overflow-y-auto p-3 text-xs text-foreground font-mono whitespace-pre-wrap bg-muted/40">{content}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
