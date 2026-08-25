import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder, List, LayoutGrid, Lock, Code } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';
import { formatSize, formatDate, fileIcon, extOf } from './folderExplorer/utils';
import type { BrowseEntry, EditorDef, ViewMode, GridSize } from './folderExplorer/utils';
import { EntryRow, EntryTile } from './folderExplorer/views';
import { EntryMenu, MenuItem, SortHeader } from './folderExplorer/menus';
import { ExplorerHeader } from './folderExplorer/header';

// Phase T2 (2026-08-14): the Folder Explorer — a standalone panel that browses ANY absolute
// path on disk (not project-scoped; works in General mode with no project at all). Windows/
// macOS-style: list ("lines") vs grid ("objects") view with size tiers, folder-in-folder
// navigation via breadcrumbs, and per-file actions. Opening files goes through the normal
// chat commands (open X in the editor / open X with <editor> / open X in the browser) so the
// terminal stays the single source of truth; Reveal uses the browse reveal endpoint.
// Browsing is read-only (GET /api/browse) — nothing here mutates the filesystem.
//
// 2026-08-24 split: helpers/menus/row-tile/header live in folderExplorer/*; this file owns
// the panel state, the navigation/history logic and the layout.

interface FolderExplorerPanelProps {
  onSendMessage: (text: string) => void;
  /** Phase T fix: the tab whose workspace this panel belongs to — the remembered folder path
   *  is scoped per tab so switching tabs restores each tab's own location. */
  tabId?: string | null;
  /** Active project (2026-08-24): rename/move are chat-command mutations scoped to the active
   *  project's sandbox, so the panel needs the project to compute project-relative paths and
   *  to disable the mutation affordances when browsing outside it. */
  project?: Project | null;
}

const VIEW_KEY = 'console.explorerView';
const SIZE_KEY = 'console.explorerSize';
// Per-tab path: each tab remembers where its Folder Explorer was pointed (the view mode/size
// keys above stay global — they're personal preferences, not per-workspace state).
const PATH_KEY = (tabId: string | null | undefined) =>
  'console.explorerPath' + (tabId ? '.' + tabId : '');

export function FolderExplorerPanel({ onSendMessage, tabId = null, project = null }: FolderExplorerPanelProps) {
  const [path, setPath] = useState<string>(() => {
    try { return localStorage.getItem(PATH_KEY(tabId)) || ''; } catch { return ''; }
  });
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => {
    try { return (localStorage.getItem(VIEW_KEY) as ViewMode) || 'list'; } catch { return 'list'; }
  });
  const [gridSize, setGridSize] = useState<GridSize>(() => {
    try { return (localStorage.getItem(SIZE_KEY) as GridSize) || 'md'; } catch { return 'md'; }
  });
  const [editors, setEditors] = useState<EditorDef[]>([]);
  const [openWithFor, setOpenWithFor] = useState<string | null>(null);
  // Multi-select (2026-08-24): Ctrl/Cmd+click toggles, Shift+click range-selects from the last
  // clicked entry, Esc clears. The selection is read-only convenience (copy paths) — no
  // mutation of the filesystem here, ever.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectPivotRef = useRef<string | null>(null);
  // Right-click context menu: { x, y, path } positioned at the pointer, closed on outside
  // click / Esc. Same action set as the per-entry ⋯ menu (chat commands, source of truth).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // Rename-in-place (2026-08-24): F2 or the menus start an inline rename; Enter commits via
  // the chat command (`rename <rel> to <newname>`) so confirm + journal + revert stay in the
  // terminal. Only offered when the browsed folder is inside the active project (the sandbox
  // boundary the chat commands enforce).
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Guards the Enter-then-blur double-commit: Enter sends the command and unmounts the input,
  // whose onBlur would otherwise fire with the stale closure and send it again.
  const renameCommittedRef = useRef(false);
  // Drag-and-drop move (2026-08-24): file rows/tiles are draggable, folder rows/tiles are
  // drop targets; the drop sends the `move <rel> into <relDir>` chat command (confirm-gated
  // and journaled server-side like tidy).
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Project-relative path for an absolute browse path, or null when it sits outside the
  // active project — rename/move are sandbox-scoped to the project by the chat commands.
  const relOf = useCallback((absPath: string): string | null => {
    if (!project) return null;
    const root = project.path.replace(/[\\/]+$/, '').toLowerCase();
    const abs = absPath.replace(/[\\/]+$/, '');
    const lower = abs.toLowerCase();
    if (!(lower.startsWith(root + '\\') || lower.startsWith(root + '/'))) return null;
    return abs.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || null;
  }, [project]);

  const startRename = (entry: BrowseEntry) => {
    if (!relOf(entry.path)) return;
    renameCommittedRef.current = false;
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const commitRename = (entry: BrowseEntry) => {
    const rel = relOf(entry.path);
    setRenamingPath(null);
    if (!rel) return;
    const name = renameValue.trim();
    if (!name || name === entry.name) return;
    const slash = rel.lastIndexOf('/');
    const toRel = slash === -1 ? name : `${rel.slice(0, slash)}/${name}`;
    renameCommittedRef.current = true;
    onSendMessage(`rename ${rel} to ${toRel}`);
  };

  const commitRenameFromBlur = (entry: BrowseEntry) => {
    // Enter already sent the command and unmounted the input — this blur is the echo.
    if (renameCommittedRef.current) { renameCommittedRef.current = false; return; }
    commitRename(entry);
  };

  const onDragStart = (e: React.DragEvent, entry: BrowseEntry) => {
    if (entry.isDir) return;
    setDragPath(entry.path);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', entry.name);
  };

  const onDrop = (e: React.DragEvent, target: BrowseEntry) => {
    e.preventDefault();
    setDropTarget(null);
    const filePath = dragPath;
    setDragPath(null);
    if (!filePath || filePath === target.path) return;
    const relFile = relOf(filePath);
    const relDir = relOf(target.path);
    if (!relFile || !relDir) return;
    onSendMessage(`move ${relFile} into ${relDir}`);
  };
  // Browser-style back/forward history over visited folders (Windows Explorer-like).
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const [historyTick, setHistoryTick] = useState(0);

  const canGoBack = historyIndexRef.current > 0;
  const canGoForward = historyIndexRef.current < historyRef.current.length - 1;

  useEffect(() => {
    // Phase T2: seed the view from the profile's default when the user has never toggled
    // the in-panel switch (localStorage empty) — the Settings → Explorer preference.
    if (!localStorage.getItem(VIEW_KEY)) {
      apiFetchJson<{ userProfile?: { explorerViewMode?: string } }>('/api/profile').then((d) => {
        if (d?.userProfile?.explorerViewMode === 'grid') setView('grid');
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
  }, [view]);
  useEffect(() => {
    try { localStorage.setItem(SIZE_KEY, gridSize); } catch {}
  }, [gridSize]);
  useEffect(() => {
    try { localStorage.setItem(PATH_KEY(tabId), path); } catch {}
  }, [path]);

  useEffect(() => {
    apiFetchJson<{ editors: EditorDef[] }>('/api/editors').then((d) => {
      if (d?.editors) setEditors(d.editors);
    }).catch(() => {});
  }, []);

  // Navigate to a folder, recording history (browse() is the only navigation entry point —
  // back/forward/up/breadcrumbs/row-clicks all funnel through it with pushHistory=false for
  // non-new visits).
  const browse = useCallback(async (target: string, pushHistory = true) => {
    if (!target.trim()) return;
    setLoading(true);
    setError(null);
    const data = await apiFetchJson<{ path: string; entries: BrowseEntry[]; error?: string }>(
      `/api/browse?path=${encodeURIComponent(target)}`
    );
    setLoading(false);
    if (!data) { setError('Could not reach the server.'); return; }
    if (data.error) { setError(data.error); return; }
    const resolved = data.path;
    setPath(resolved);
    setEntries(data.entries || []);
    setSearchQuery('');
    // Selection is per-folder — navigating away drops it (Windows Explorer behavior).
    setSelectedPaths(new Set());
    selectPivotRef.current = null;
    if (pushHistory) {
      const prev = historyRef.current;
      const idx = historyIndexRef.current;
      const next = [...prev.slice(0, idx + 1), resolved];
      historyRef.current = next;
      historyIndexRef.current = next.length - 1;
      setHistoryTick((t) => t + 1);
    }
  }, []);

  const goBack = useCallback(() => {
    const idx = historyIndexRef.current - 1;
    const target = historyRef.current[idx];
    if (target) {
      historyIndexRef.current = idx;
      setHistoryTick((t) => t + 1);
      browse(target, false);
    }
  }, [browse]);

  const goForward = useCallback(() => {
    const idx = historyIndexRef.current + 1;
    const target = historyRef.current[idx];
    if (target) {
      historyIndexRef.current = idx;
      setHistoryTick((t) => t + 1);
      browse(target, false);
    }
  }, [browse]);

  // Initial load: restore the persisted path (or stay on the empty state — the server has
  // no home-directory endpoint, and the empty state explains what to do).
  useEffect(() => {
    if (path) browse(path, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const up = () => {
    const parent = path.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join(path.includes('\\') ? '\\' : '/') || '';
    if (parent) browse(parent);
  };

  const home = () => {
    // Windows: %USERPROFILE%; POSIX: $HOME. The server doesn't expose it, so derive from
    // the current path's drive root as a reasonable fallback.
    const m = path.match(/^[a-zA-Z]:[\\/]/);
    if (m) browse(m[0]);
  };

  // Double-click / Enter on a file opens it in its OS default app (file association) via
  // POST /api/browse/open — the Windows Explorer "open" behavior.
  const openDefaultApp = useCallback(async (target: string) => {
    await fetch('/api/browse/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    }).catch(() => {});
  }, []);

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, searchQuery]);

  // Phase 5: sortable columns (Lines view) — folders always stay on top regardless of the
  // chosen column/direction; the default is name ascending like the server's listing.
  const [sortKey, setSortKey] = useState<'name' | 'size' | 'modified'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const sortedEntries = useMemo(() => {
    const arr = [...filteredEntries];
    arr.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const va = sortKey === 'size' ? a.size : sortKey === 'modified' ? a.modifiedAt : a.name.toLowerCase();
      const vb = sortKey === 'size' ? b.size : sortKey === 'modified' ? b.modifiedAt : b.name.toLowerCase();
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filteredEntries, sortKey, sortDir]);
  const toggleSort = (key: 'name' | 'size' | 'modified') => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  // Phase 5: arrow-key navigation over the listing + Enter to activate. Skipped while the
  // user types in the search/path inputs; a focused row button keeps its own Enter behavior
  // (the arrow keys blur buttons so the cursor row — not the stale focused row — activates).
  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCursor(0); }, [entries, searchQuery, sortKey, sortDir]);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (ev.key === 'Escape') {
        setCtxMenu(null);
        setSelectedPaths(new Set());
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (t && t.tagName === 'BUTTON') t.blur();
        setCursor((c) => {
          const max = Math.max(sortedEntries.length - 1, 0);
          return ev.key === 'ArrowDown' ? Math.min(c + 1, max) : Math.max(c - 1, 0);
        });
      } else if (ev.key === 'Enter' && sortedEntries.length > 0) {
        if (t && t.closest('button')) return; // a focused row/menu button owns Enter already
        const e = sortedEntries[Math.min(cursor, sortedEntries.length - 1)];
        if (!e) return;
        ev.preventDefault();
        if (e.isDir) browse(e.path);
        else openDefaultApp(e.path);
      } else if (ev.key === 'F2' && sortedEntries.length > 0) {
        const e = sortedEntries[Math.min(cursor, sortedEntries.length - 1)];
        if (e) { ev.preventDefault(); startRename(e); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sortedEntries, cursor, browse, openDefaultApp, startRename]);

  // Right-click menu closes on any outside click.
  useEffect(() => {
    if (!ctxMenu) return;
    const onDoc = (e: MouseEvent) => {
      const el = document.getElementById('explorer-ctx-menu');
      if (el && !el.contains(e.target as Node)) setCtxMenu(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [ctxMenu]);

  // Keep the highlighted row visible while navigating.
  useEffect(() => {
    const el = document.querySelector('[data-explorer-cursor]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, sortedEntries]);

  // --- Multi-select helpers (2026-08-24) ---
  const toggleSelect = (entry: BrowseEntry, ev: React.MouseEvent) => {
    if (ev.shiftKey && selectPivotRef.current) {
      const idxA = sortedEntries.findIndex((x) => x.path === selectPivotRef.current);
      const idxB = sortedEntries.findIndex((x) => x.path === entry.path);
      if (idxA !== -1 && idxB !== -1) {
        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        setSelectedPaths(new Set(sortedEntries.slice(lo, hi + 1).map((x) => x.path)));
        selectPivotRef.current = entry.path;
        return;
      }
    }
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    selectPivotRef.current = entry.path;
  };

  const copySelectedPaths = async () => {
    // Multi-copy is a client-side browser clipboard write (the single-item menu keeps its
    // chat-command server copy) — a convenience for the selection, no terminal spam.
    try {
      await navigator.clipboard.writeText([...selectedPaths].join('\n'));
    } catch {}
    setSelectedPaths(new Set());
  };

  const sendOpenWith = (editorName: string) => {
    if (!openWithFor) return;
    onSendMessage(`open ${openWithFor} with ${editorName}`);
    setOpenWithFor(null);
  };

  const tileSize = gridSize === 'lg' ? 72 : gridSize === 'md' ? 56 : 44;
  const tileIcon = gridSize === 'lg' ? 28 : gridSize === 'md' ? 22 : 16;

  // Shared props for the row/tile renderers (2026-08-24 split).
  const entryViewProps = {
    cursor,
    selectedPaths,
    dropTarget,
    renamingPath,
    renameValue,
    renameInputRef,
    editors,
    onBrowse: browse,
    onOpenDefault: openDefaultApp,
    onToggleSelect: toggleSelect,
    onDragStart,
    onDrop,
    onSetDropTarget: setDropTarget,
    onContextMenu: (ev: React.MouseEvent, entry: BrowseEntry) => {
      ev.preventDefault();
      setCtxMenu({ x: ev.clientX, y: ev.clientY, path: entry.path });
    },
    onStartRename: startRename,
    onCommitRename: commitRename,
    onCancelRename: () => setRenamingPath(null),
    onBlurRename: commitRenameFromBlur,
    onRenameValue: setRenameValue,
    onSendMessage,
    onOpenWith: setOpenWithFor,
  };

  return (
    <div className="h-full flex flex-col">
      <ExplorerHeader
        path={path}
        setPath={setPath}
        loading={loading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBrowse={browse}
        onBack={goBack}
        onForward={goForward}
        onUp={up}
        onHome={home}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        filteredCount={filteredEntries.length}
        entriesCount={entries.length}
        selectedCount={selectedPaths.size}
        onCopySelected={() => void copySelectedPaths()}
        onClearSelection={() => setSelectedPaths(new Set())}
      />

      {error && <p className="text-xs text-accent-red px-4 py-1.5">{error}</p>}

      {/* Main area: list or grid */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-panel">
        {entries.length === 0 && !loading ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-fg-muted">Paste a folder path above to browse it.</p>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-fg-dim italic">No matches for "{searchQuery}" in this folder.</p>
          </div>
        ) : view === 'list' ? (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel z-10">
              <tr className="text-left text-fg-dim text-[10px] uppercase tracking-wider border-b border-border-faint">
                <th className="px-4 py-1.5 font-semibold w-1/2">
                  <SortHeader label="Name" active={sortKey === 'name'} dir={sortDir} onClick={() => toggleSort('name')} />
                </th>
                <th className="px-2 py-1.5 font-semibold text-right hidden sm:table-cell">
                  <SortHeader label="Size" active={sortKey === 'size'} dir={sortDir} onClick={() => toggleSort('size')} />
                </th>
                <th className="px-4 py-1.5 font-semibold text-right hidden md:table-cell">
                  <SortHeader label="Modified" active={sortKey === 'modified'} dir={sortDir} onClick={() => toggleSort('modified')} />
                </th>
                <th className="px-2 py-1.5 w-24" />
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((e, i) => (
                <EntryRow
                  key={e.path}
                  entry={e}
                  index={i}
                  cursor={cursor}
                  selected={selectedPaths.has(e.path)}
                  dropTargetPath={dropTarget}
                  renaming={renamingPath === e.path}
                  canRename={!!relOf(e.path)}
                  {...entryViewProps}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-4 grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize + 24}px, 1fr))` }}>
            {sortedEntries.map((e, i) => (
              <EntryTile
                key={e.path}
                entry={e}
                index={i}
                cursor={cursor}
                selected={selectedPaths.has(e.path)}
                dropTargetPath={dropTarget}
                renaming={renamingPath === e.path}
                tileIconSize={tileIcon}
                {...entryViewProps}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom bar: view toggle (lines vs objects) + grid size — Windows/macOS style */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-t border-border-faint shrink-0 bg-overlay">
        <div className="flex items-center gap-0.5 bg-panel-strong rounded-lg p-0.5 border border-border-soft">
          <button
            onClick={() => setView('list')}
            className={cn('flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] transition-colors', view === 'list' ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-dim hover:text-fg-strong')}
            title="List view — lines"
          >
            <List size={12} /> Lines
          </button>
          <button
            onClick={() => setView('grid')}
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
                onClick={() => setGridSize(s)}
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
          {entries.length} item{entries.length === 1 ? '' : 's'}
          {/* Round-6 audit (2026-08-24): VS Code status-bar pattern — a multi-select shows
              its own count instead of only the folder total, so the selection state is
              visible while you work. */}
          {selectedPaths.size > 0 && <span className="text-accent-blue"> · {selectedPaths.size} selected</span>}
          {loading && ' — loading…'}
        </span>
      </div>

      {/* Right-click context menu (2026-08-24) — same chat-command actions as the ⋯ menu;
          with a multi-selection active it offers copying the whole selection. */}
      {ctxMenu && (() => {
        const ctxEntry = sortedEntries.find((x) => x.path === ctxMenu.path);
        if (!ctxEntry) return null;
        const multi = selectedPaths.size > 1 && selectedPaths.has(ctxEntry.path);
        const name = ctxEntry.name;
        const isHtml = !ctxEntry.isDir && /\.html?$/i.test(name);
        const canMutate = !!relOf(ctxEntry.path);
        const close = () => setCtxMenu(null);
        return (
          <div
            id="explorer-ctx-menu"
            className="fixed z-50 w-52 bg-panel border border-border-strong rounded-xl shadow-float py-1 text-xs"
            style={{ left: Math.min(ctxMenu.x, window.innerWidth - 230), top: Math.min(ctxMenu.y, window.innerHeight - 260) }}
          >
            {!ctxEntry.isDir && (
              <MenuItem label="Open (default app)" onClick={() => { openDefaultApp(ctxEntry.path); close(); }} />
            )}
            {!ctxEntry.isDir && (
              <MenuItem label="Open in editor" onClick={() => { onSendMessage(`open ${name} in the editor`); close(); }} />
            )}
            {!ctxEntry.isDir && (
              <MenuItem label="Open with…" onClick={() => { setOpenWithFor(ctxEntry.path); close(); }} />
            )}
            {isHtml && (
              <MenuItem label="Open in browser" onClick={() => { onSendMessage(`open ${name} in the browser`); close(); }} />
            )}
            {!ctxEntry.isDir && <div className="border-t border-border-faint my-1" />}
            <MenuItem label="Reveal in folder" onClick={() => { onSendMessage(`open ${name} in the folder`); close(); }} />
            {canMutate && (
              <MenuItem label="Rename…" onClick={() => { close(); startRename(ctxEntry); }} />
            )}
            <MenuItem label={multi ? `Copy ${selectedPaths.size} paths` : 'Copy path'} onClick={() => {
              if (multi) { void copySelectedPaths(); } else { onSendMessage(`copy path of ${ctxEntry.path}`); }
              close();
            }} />
            {!canMutate && (
              <div className="px-3 py-1.5 text-[10px] text-fg-faint">
                Rename/move only work inside the active project.
              </div>
            )}
          </div>
        );
      })()}

      {/* Open-with chooser overlay */}
      {openWithFor && (
        <div className="absolute inset-0 z-20 bg-scrim/90 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-panel border border-border-strong rounded-2xl shadow-modal p-5 w-full max-w-sm mx-4">
            <h3 className="text-sm font-semibold text-fg-strong mb-1">Open in editor</h3>
            <p className="text-[11px] text-fg-muted font-mono truncate mb-3">{openWithFor.split(/[\\/]/).pop()}</p>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {editors.length === 0 && (
                <p className="text-xs text-fg-dim italic">No editors configured yet — add them in Settings → Editors &amp; IDEs.</p>
              )}
              {editors.map((ed) => (
                <button
                  key={ed.id}
                  onClick={() => sendOpenWith(ed.name)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-fg-strong hover:bg-scrim-faint border border-transparent hover:border-border-soft transition-colors text-left"
                >
                  <Code size={13} className="text-accent-blue shrink-0" />
                  <span className="flex-1">{ed.name}</span>
                  <span className="text-[10px] text-fg-dim font-mono">{ed.command}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setOpenWithFor(null)}
              className="mt-3 w-full px-3 py-2 text-xs text-fg-dim hover:text-fg-strong border border-border-soft rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}