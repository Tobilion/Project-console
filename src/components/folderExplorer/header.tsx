// Folder Explorer header block (2026-08-24, split out of FolderExplorerPanel.tsx): path
// input + back/forward/up/home/refresh, the name-search bar, the multi-select bar and the
// breadcrumb trail. Pure props.

import { FolderOpen, RefreshCw, ChevronRight, ChevronLeft, CornerUpLeft, Home, Search as SearchIcon, Copy, ScanSearch } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface ExplorerHeaderProps {
  path: string;
  setPath: (v: string) => void;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBrowse: (path: string, pushHistory?: boolean) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onHome: () => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  filteredCount: number;
  entriesCount: number;
  selectedCount: number;
  onCopySelected: () => void;
  onClearSelection: () => void;
}

export function ExplorerHeader(props: ExplorerHeaderProps) {
  const {
    path, setPath, loading, canGoBack, canGoForward, onBrowse, onBack, onForward, onUp, onHome,
    searchQuery, setSearchQuery, filteredCount, entriesCount, selectedCount,
    onCopySelected, onClearSelection,
  } = props;

  const breadcrumbs = path.split(/[\\/]/).filter(Boolean);

  return (
    <>
      {/* Header: path input + quick actions */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-faint shrink-0 flex-wrap">
        <div className="p-1.5 rounded-lg bg-accent-teal/15 text-accent-teal shrink-0">
          <FolderOpen size={16} />
        </div>
        <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase shrink-0">Folder Explorer</h2>
        <form
          className="flex-1 flex items-center gap-1.5 min-w-[220px]"
          onSubmit={(e) => { e.preventDefault(); onBrowse(path); }}
        >
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\Users\you\Documents — paste any folder path"
            className="flex-1 text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-1.5 text-fg-strong font-mono focus:outline-none focus:border-accent-blue/50"
          />
          <button
            type="submit"
            disabled={!path.trim() || loading}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {loading ? <RefreshCw size={12} className="animate-spin" /> : <ScanSearch size={12} />}
            Browse
          </button>
        </form>
        <div className="flex items-center gap-1">
          <button onClick={onBack} disabled={!canGoBack} title="Back" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors disabled:opacity-30 disabled:hover:text-fg-dim" aria-label="Back">
            <ChevronLeft size={15} />
          </button>
          <button onClick={onForward} disabled={!canGoForward} title="Forward" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors disabled:opacity-30 disabled:hover:text-fg-dim" aria-label="Forward">
            <ChevronRight size={15} />
          </button>
          <button onClick={onUp} disabled={!path} title="Up one level" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors disabled:opacity-40">
            <CornerUpLeft size={15} />
          </button>
          <button onClick={onHome} title="Go to the drive root" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors">
            <Home size={15} />
          </button>
          <button onClick={() => onBrowse(path)} title="Refresh" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors">
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Search bar — filters the current listing by name (Windows Explorer style); the
          back/forward/up/breadcrumb navigation stays fully functional while searching. */}
      <div data-tour="folder-explorer-search" className="flex items-center gap-2 px-4 py-1.5 border-b border-border-faint shrink-0">
        <SearchIcon size={13} className="text-fg-dim shrink-0" />
        <input
          data-tour="folder-explorer-search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSearchQuery('');
          }}
          placeholder={`Search in ${path.split(/[\\/]/).filter(Boolean).pop() || 'this folder'}…`}
          className="flex-1 min-w-0 text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-1 text-fg-strong focus:outline-none focus:border-accent-blue/50"
        />
        {searchQuery && (
          <span className="text-[10px] text-fg-dim">
            {filteredCount} of {entriesCount}
          </span>
        )}
      </div>

      {/* Multi-select bar (2026-08-24) — read-only convenience: copy the selected paths. */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border-faint bg-accent-blue/5 shrink-0">
          <span className="text-[11px] text-fg-strong font-medium">{selectedCount} selected</span>
          <button
            onClick={onCopySelected}
            className="flex items-center gap-1 text-[11px] font-medium text-accent-blue hover:text-fg-strong transition-colors"
          >
            <Copy size={11} /> Copy paths
          </button>
          <button
            onClick={onClearSelection}
            className="text-[11px] text-fg-dim hover:text-fg-strong transition-colors"
          >
            Clear
          </button>
          <span className="ml-auto text-[10px] text-fg-faint">Ctrl+click toggles · Shift+click selects a range</span>
        </div>
      )}

      {/* Breadcrumb trail */}
      {breadcrumbs.length > 0 && (
        <div className="flex items-center gap-0.5 px-4 py-1 border-b border-border-faint shrink-0 overflow-x-auto text-[11px]">
          {breadcrumbs.map((part, i) => {
            const crumbPath = breadcrumbs.slice(0, i + 1).join(path.includes('\\') ? '\\' : '/') + (path.includes('\\') ? '\\' : '/');
            return (
              <button
                key={i}
                onClick={() => onBrowse(crumbPath)}
                className={cn(
                  'flex items-center gap-0.5 px-1 py-0.5 rounded transition-colors whitespace-nowrap',
                  i === breadcrumbs.length - 1 ? 'text-fg-strong font-semibold' : 'text-fg-dim hover:text-fg-strong',
                )}
              >
                {i > 0 && <ChevronRight size={11} className="text-fg-faint" />}
                {part || (path.includes('\\') ? 'C:' : '/')}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}