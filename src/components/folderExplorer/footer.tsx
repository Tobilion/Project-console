// Folder Explorer footer bar (2026-09-10, split out of FolderExplorerPanel.tsx): the
// bottom bar with the lines/objects view toggle, the grid-size tiers, the read-only
// marker and the item/selection count. Purely presentational — all state lives in the
// panel root, this leaf only renders what it is given.

import { List, LayoutGrid, Lock } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ViewMode, GridSize } from './utils';

export function ExplorerFooter({ view, gridSize, onViewChange, onGridSizeChange, itemCount, selectedCount, loading }: {
  view: ViewMode;
  gridSize: GridSize;
  onViewChange: (view: ViewMode) => void;
  onGridSizeChange: (size: GridSize) => void;
  itemCount: number;
  selectedCount: number;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-t border-border-faint shrink-0 bg-overlay">
      <div className="flex items-center gap-0.5 bg-panel-strong rounded-lg p-0.5 border border-border-soft">
        <button
          onClick={() => onViewChange('list')}
          className={cn('flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] transition-colors', view === 'list' ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-dim hover:text-fg-strong')}
          title="List view — lines"
        >
          <List size={12} /> Lines
        </button>
        <button
          onClick={() => onViewChange('grid')}
          className={cn('flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] transition-colors', view === 'grid' ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-dim hover:text-fg-strong')}
          title="Grid view — objects"
        >
          <LayoutGrid size={12} /> Objects
        </button>
      </div>
      {view === 'grid' && (
        <div className="flex items-center gap-0.5 bg-panel-strong rounded-lg p-0.5 border border-border-soft">
          {(['sm', 'md', 'lg'] as GridSize[]).map((s) => (
            <button
              key={s}
              onClick={() => onGridSizeChange(s)}
              className={cn('px-2 py-1 rounded-md text-[10px] font-bold uppercase transition-colors', gridSize === s ? 'bg-accent-blue/15 text-accent-blue' : 'text-fg-dim hover:text-fg-strong')}
              title={`${s} tiles`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <span className="ml-auto flex items-center gap-1 text-[10px] text-fg-faint" title="Browsing is read-only — files are opened via the OS, never modified here">
        <Lock size={10} /> read-only
      </span>
      <span className="text-[10px] text-fg-dim">
        {itemCount} item{itemCount === 1 ? '' : 's'}
        {/* Round-6 audit (2026-08-24): VS Code status-bar pattern — a multi-select shows
            its own count instead of only the folder total, so the selection state is
            visible while you work. */}
        {selectedCount > 0 && <span className="text-accent-blue"> · {selectedCount} selected</span>}
        {loading && ' — loading…'}
      </span>
    </div>
  );
}
