// Folder Explorer menus (2026-08-24, split out of FolderExplorerPanel.tsx): the per-entry
// ⋯ action menu, the shared menu row, and the sortable column header. All actions go through
// chat commands (terminal stays the source of truth) except "Open (default app)" — the one
// direct endpoint, same trust level as reveal.

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, MoreHorizontal, ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { BrowseEntry, EditorDef } from './utils';

/** Per-entry action menu — opens via chat commands (terminal stays the source of truth);
 *  "Open (default app)" is the one direct endpoint (browse/open) — the double-click
 *  equivalent, same trust level as reveal. */
export function EntryMenu({ entry, editors, onSendMessage, onOpenWith, onOpenDefault, onRename, canRename }: {
  entry: BrowseEntry;
  editors: EditorDef[];
  onSendMessage: (text: string) => void;
  onOpenWith: () => void;
  onOpenDefault: () => void;
  onRename: () => void;
  canRename: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (entry.isDir) {
    return (
      <button
        onClick={() => onSendMessage(`open ${entry.path} in the folder`)}
        className="p-1 text-fg-dim hover:text-accent-blue rounded transition-colors"
        title="Reveal in OS file explorer"
      >
        <ExternalLink size={13} />
      </button>
    );
  }

  const name = entry.name;
  const isHtml = /\.html?$/i.test(name);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(v => !v)} className="p-1 text-fg-dim hover:text-fg-strong rounded transition-colors" title="Actions">
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-52 bg-panel border border-border-strong rounded-xl shadow-float py-1 text-xs">
          <MenuItem label="Open (default app)" onClick={() => { onOpenDefault(); setOpen(false); }} />
          <div className="border-t border-border-faint my-1" />
          <MenuItem label="Open in editor" onClick={() => { onSendMessage(`open ${name} in the editor`); setOpen(false); }} />
          <MenuItem label="Open with…" onClick={() => { setOpen(false); onOpenWith(); }} />
          {editors.length > 0 && (
            <div className="border-t border-border-faint my-1" />
          )}
          {editors.slice(0, 4).map((ed) => (
            <MenuItem key={ed.id} label={`Open with ${ed.name}`} onClick={() => { onSendMessage(`open ${name} with ${ed.name}`); setOpen(false); }} />
          ))}
          {isHtml && (
            <>
              <div className="border-t border-border-faint my-1" />
              <MenuItem label="Open in browser" onClick={() => { onSendMessage(`open ${name} in the browser`); setOpen(false); }} />
            </>
          )}
          <div className="border-t border-border-faint my-1" />
          <MenuItem label="Reveal in folder" onClick={() => { onSendMessage(`open ${name} in the folder`); setOpen(false); }} />
          {canRename && (
            <MenuItem label="Rename…" onClick={() => { setOpen(false); onRename(); }} />
          )}
          <MenuItem label="Copy path" onClick={() => {
            // Phase 8 pattern: copy_to_clipboard WS event is display-only; the panel uses
            // the chat command so the server-side OS clipboard write happens for real.
            onSendMessage(`copy path of ${entry.path}`);
            setOpen(false);
          }} />
        </div>
      )}
    </div>
  );
}

export function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 text-fg-subtle hover:bg-scrim-faint hover:text-fg-strong transition-colors"
    >
      {label}
    </button>
  );
}

/** Phase 5: clickable sortable column header with direction indicator. */
export function SortHeader({ label, active, dir, onClick }: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 font-semibold uppercase tracking-wider transition-colors',
        active ? 'text-accent-blue' : 'text-fg-dim hover:text-fg-strong',
      )}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      {active && (dir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
    </button>
  );
}