import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, Keyboard } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

const GROUPS: Array<{ label: string; rows: Array<[string, string]> }> = [
  {
    label: 'Global',
    rows: [
      ['Ctrl+K', 'Open the command palette'],
      ['?', 'Show this keyboard-shortcuts overlay'],
      ['Esc', 'Close overlays / panels / the palette / clear search'],
    ],
  },
  {
    label: 'Chat',
    rows: [
      ['↑ / ↓', 'Scroll message history in the input'],
      ['Ctrl+R', 'History search'],
      ['Tab', 'Command completion'],
    ],
  },
  {
    label: 'Command palette',
    rows: [
      ['↑ / ↓', 'Move the selection'],
      ['Enter', 'Run the selected item'],
      ['Esc', 'Close'],
    ],
  },
  {
    label: 'Folder Explorer',
    rows: [
      ['↑ / ↓', 'Move the cursor row'],
      ['Enter', 'Open the focused folder / file'],
      ['Ctrl+Click', 'Toggle multi-select'],
      ['Shift+Click', 'Select a range'],
      ['Right-click', 'Context menu'],
      ['Esc', 'Clear selection / close the menu'],
    ],
  },
];

/** Keyboard-shortcuts overlay (2026-08-24) — the "?" affordance so shortcuts are discoverable
 *  instead of living only in memory. Esc or the backdrop closes; same z-layer as CommandDeck;
 *  focus-trapped like every other modal. */
export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] bg-scrim/70 backdrop-blur-sm flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
        >
          <motion.div
            ref={panelRef}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="w-full max-w-md max-h-[80vh] overflow-y-auto bg-panel border border-border-strong rounded-2xl shadow-modal"
          >
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border-faint sticky top-0 bg-panel">
          <div className="p-1.5 rounded-lg bg-accent-blue/10 text-accent-blue">
            <Keyboard size={16} />
          </div>
          <h2 className="text-sm font-semibold text-fg-strong">Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            aria-label="Close shortcuts"
            className="ml-auto p-1 text-fg-dim hover:text-fg-strong transition-colors"
          >
            <X size={15} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <h3 className="text-[10px] uppercase tracking-wider text-fg-dim font-bold mb-1.5">{g.label}</h3>
              <div className="space-y-1">
                {g.rows.map(([keys, desc]) => (
                  <div key={keys} className="flex items-center gap-3 text-[12px]">
                    <kbd className={cn('shrink-0 min-w-[70px] text-center font-mono text-[10px] px-1.5 py-0.5 rounded-md border border-border-soft bg-scrim-faint text-fg-strong')}>
                      {keys}
                    </kbd>
                    <span className="text-fg-subtle">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}