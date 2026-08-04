import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { History } from 'lucide-react';

interface TerminalSearchOverlayProps {
  show: boolean;
  isFullscreen?: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onSelect: (command: string) => void;
  history: string[];
  inputRef: React.RefObject<HTMLInputElement | null>;
}

/** Ctrl+R command-history search overlay. Local state is limited to autofocus —
 *  query/history/visibility all stay owned by Terminal. */
export function TerminalSearchOverlay({
  show,
  isFullscreen,
  query,
  onQueryChange,
  onClose,
  onSelect,
  history,
  inputRef,
}: TerminalSearchOverlayProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (show && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [show]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          className={`absolute bottom-20 z-50 ${isFullscreen ? 'inset-x-0 mx-auto max-w-3xl' : 'left-4 right-4'} bg-surface border border-border-soft rounded-xl shadow-2xl overflow-hidden`}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border-soft bg-panel">
            <History size={14} className="text-fg-dim" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && history.length > 0) {
                  onSelect(history[0]);
                } else if (e.key === 'Escape') {
                  onClose();
                }
              }}
              placeholder="Search command history..."
              className="flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-fg-faint"
              autoFocus
            />
            <button
              onClick={onClose}
              className="text-fg-faint hover:text-fg-muted transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {history.length === 0 ? (
              <div className="px-4 py-6 text-center text-fg-faint text-sm">
                {query.trim() ? 'No matching commands found' : 'No command history yet'}
              </div>
            ) : (
              history.map((cmd, i) => (
                <button
                  key={i}
                  onClick={() => onSelect(cmd)}
                  className="w-full text-left px-4 py-2 hover:bg-panel transition-colors font-mono text-sm text-fg-muted border-b border-border-faint last:border-b-0"
                >
                  {cmd}
                </button>
              ))
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
