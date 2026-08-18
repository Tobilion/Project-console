import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, ChevronRight, ChevronLeft, ChevronUp, ChevronDown, CornerUpLeft, Home, List, LayoutGrid, MoreHorizontal, ExternalLink, Folder, File, FileCode, FileText, FileImage, FileArchive, Table, Music, Video, Code, ScanSearch, Search as SearchIcon, Lock } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';

// Phase T2 (2026-08-14): the Folder Explorer — a standalone panel that browses ANY absolute
// path on disk (not project-scoped; works in General mode with no project at all). Windows/
// macOS-style: list ("lines") vs grid ("objects") view with size tiers, folder-in-folder
// navigation via breadcrumbs, and per-file actions. Opening files goes through the normal
// chat commands (open X in the editor / open X with <editor> / open X in the browser) so the
// terminal stays the single source of truth; Reveal uses the browse reveal endpoint.
// Browsing is read-only (GET /api/browse) — nothing here mutates the filesystem.

interface BrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
}

interface EditorDef {
  id: string;
  name: string;
  command: string;
}

interface FolderExplorerPanelProps {
  onSendMessage: (text: string) => void;
  /** Phase T fix: the tab whose workspace this panel belongs to — the remembered folder path
   *  is scoped per tab so switching tabs restores each tab's own location. */
  tabId?: string | null;
}

const VIEW_KEY = 'console.explorerView';
const SIZE_KEY = 'console.explorerSize';
// Per-tab path: each tab remembers where its Folder Explorer was pointed (the view mode/size
// keys above stay global — they're personal preferences, not per-workspace state).
const PATH_KEY = (tabId: string | null | undefined) =>
  'console.explorerPath' + (tabId ? '.' + tabId : '');
type ViewMode = 'list' | 'grid';
type GridSize = 'sm' | 'md' | 'lg';

function formatSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fileIcon(name: string, size = 14) {
  const ext = name.toLowerCase().split('.').pop() || '';
  const cls = 'shrink-0 text-fg-dim';
  if (['py', 'js', 'jsx', 'ts', 'tsx', 'c', 'cpp', 'h', 'hpp', 'java', 'cs', 'kt', 'go', 'rs', 'rb', 'php', 'swift', 'sh', 'ps1'].includes(ext)) return <FileCode size={size} className={cn(cls, 'text-accent-blue/80')} />;
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return <FileImage size={size} className={cls} />;
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return <Music size={size} className={cls} />;
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return <Video size={size} className={cls} />;
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(ext)) return <FileArchive size={size} className={cls} />;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return <Table size={size} className={cls} />;
  if (['html', 'htm'].includes(ext)) return <Code size={size} className={cn(cls, 'text-accent-orange/80')} />;
  if (['txt', 'md', 'json', 'yml', 'yaml', 'xml', 'log'].includes(ext)) return <FileText size={size} className={cls} />;
  return <File size={size} className={cls} />;
}

export function FolderExplorerPanel({ onSendMessage, tabId = null }: FolderExplorerPanelProps) {
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
  const [searchQuery, setSearchQuery] = useState('');
  // Browser-style back/forward history over visited folders (Windows Explorer-like).
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const [historyTick, setHistoryTick] = useState(0);
  const pathInputRef = useRef<HTMLInputElement>(null);

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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sortedEntries, cursor, browse, openDefaultApp]);

  // Keep the highlighted row visible while navigating.
  useEffect(() => {
    const el = document.querySelector('[data-explorer-cursor]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, sortedEntries]);

  const breadcrumbs = path.split(/[\\/]/).filter(Boolean);

  const sendOpenWith = (editorName: string) => {
    if (!openWithFor) return;
    onSendMessage(`open ${openWithFor} with ${editorName}`);
    setOpenWithFor(null);
  };

  const extOf = (name: string) => (name.toLowerCase().split('.').pop() || '');

  const tileSize = gridSize === 'lg' ? 72 : gridSize === 'md' ? 56 : 44;
  const tileIcon = gridSize === 'lg' ? 28 : gridSize === 'md' ? 22 : 16;

  return (
    <div className="h-full flex flex-col">
      {/* Header: path input + quick actions */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-faint shrink-0 flex-wrap">
        <div className="p-1.5 rounded-lg bg-accent-teal/15 text-accent-teal shrink-0">
          <FolderOpen size={16} />
        </div>
        <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase shrink-0">Folder Explorer</h2>
        <form
          className="flex-1 flex items-center gap-1.5 min-w-[220px]"
          onSubmit={(e) => { e.preventDefault(); browse(path); }}
        >
          <input
            ref={pathInputRef}
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
          <button onClick={goBack} disabled={!canGoBack} title="Back" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors disabled:opacity-30 disabled:hover:text-fg-dim" aria-label="Back">
            <ChevronLeft size={15} />
          </button>
          <button onClick={goForward} disabled={!canGoForward} title="Forward" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors disabled:opacity-30 disabled:hover:text-fg-dim" aria-label="Forward">
            <ChevronRight size={15} />
          </button>
          <button onClick={up} disabled={!path} title="Up one level" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors disabled:opacity-40">
            <CornerUpLeft size={15} />
          </button>
          <button onClick={home} title="Go to the drive root" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors">
            <Home size={15} />
          </button>
          <button onClick={() => browse(path)} title="Refresh" className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors">
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Search bar — filters the current listing by name (Windows Explorer style); the
          back/forward/up/breadcrumb navigation stays fully functional while searching. */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border-faint shrink-0">
        <SearchIcon size={13} className="text-fg-dim shrink-0" />
        <input
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
            {filteredEntries.length} of {entries.length}
          </span>
        )}
      </div>

      {error && <p className="text-xs text-accent-red px-4 py-1.5">{error}</p>}

      {/* Breadcrumb trail */}
      {breadcrumbs.length > 0 && (
        <div className="flex items-center gap-0.5 px-4 py-1 border-b border-border-faint shrink-0 overflow-x-auto text-[11px]">
          {breadcrumbs.map((part, i) => {
            const crumbPath = breadcrumbs.slice(0, i + 1).join(path.includes('\\') ? '\\' : '/') + (path.includes('\\') ? '\\' : '/');
            return (
              <button
                key={i}
                onClick={() => browse(crumbPath)}
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
                <tr
                  key={e.path}
                  data-explorer-cursor={i === cursor ? '' : undefined}
                  className={cn(
                    'border-b border-border-faint last:border-b-0 hover:bg-scrim-faint transition-colors',
                    i === cursor && 'bg-accent-blue/10 hover:bg-accent-blue/15',
                  )}
                >
                  <td className="px-4 py-1.5">
                    <button
                      onClick={() => { if (e.isDir) browse(e.path); }}
                      onDoubleClick={() => { if (!e.isDir) openDefaultApp(e.path); }}
                      onKeyDown={(ev) => {
                        // Enter on a row opens it: folders navigate, files open in the default app.
                        if (ev.key === 'Enter') {
                          ev.preventDefault();
                          if (e.isDir) browse(e.path);
                          else openDefaultApp(e.path);
                        }
                      }}
                      title={e.isDir ? 'Enter to open folder' : 'Double-click or Enter to open in its default app'}
                      className="flex items-center gap-2 text-left w-full cursor-pointer"
                    >
                      {e.isDir ? <Folder size={14} className="shrink-0 text-accent" /> : fileIcon(e.name)}
                      <span className="text-fg-strong font-mono truncate">{e.name}</span>
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-right text-fg-dim font-mono hidden sm:table-cell">{e.isDir ? '—' : formatSize(e.size)}</td>
                  <td className="px-4 py-1.5 text-right text-fg-dim hidden md:table-cell">{formatDate(e.modifiedAt)}</td>
                  <td className="px-2 py-1.5">
                    <EntryMenu
                      entry={e}
                      editors={editors}
                      onSendMessage={onSendMessage}
                      onOpenWith={() => setOpenWithFor(e.path)}
                      onOpenDefault={() => { if (!e.isDir) openDefaultApp(e.path); }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-4 grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize + 24}px, 1fr))` }}>
            {sortedEntries.map((e, i) => (
              <button
                key={e.path}
                data-explorer-cursor={i === cursor ? '' : undefined}
                onClick={() => { if (e.isDir) browse(e.path); }}
                onDoubleClick={() => { if (!e.isDir) openDefaultApp(e.path); }}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    ev.preventDefault();
                    if (e.isDir) browse(e.path);
                    else openDefaultApp(e.path);
                  }
                }}
                title={e.isDir ? 'Enter to open folder' : 'Double-click or Enter to open in its default app'}
                className={cn(
                  'group flex flex-col items-center gap-1.5 rounded-xl border p-2 transition-colors cursor-pointer',
                  i === cursor
                    ? 'border-accent-blue/50 bg-accent-blue/10'
                    : 'border-transparent',
                  e.isDir ? 'hover:bg-scrim-faint hover:border-border-soft' : 'hover:bg-scrim-faint',
                )}
              >
                <div className="flex flex-col items-center gap-1">
                  {e.isDir ? <Folder size={tileIcon} className="text-accent" /> : fileIcon(e.name, tileIcon)}
                  {!e.isDir && (
                    <span className="text-[9px] text-fg-faint font-mono uppercase">{extOf(e.name) || 'file'}</span>
                  )}
                </div>
                <span className="text-[10px] text-fg-strong text-center break-all leading-tight max-h-8 overflow-hidden">
                  {e.name}
                </span>
              </button>
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
          {loading && ' — loading…'}
        </span>
      </div>

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

/** Per-entry action menu — opens via chat commands (terminal stays the source of truth);
 *  "Open (default app)" is the one direct endpoint (browse/open) — the double-click
 *  equivalent, same trust level as reveal. */
function EntryMenu({ entry, editors, onSendMessage, onOpenWith, onOpenDefault }: {
  entry: BrowseEntry;
  editors: EditorDef[];
  onSendMessage: (text: string) => void;
  onOpenWith: () => void;
  onOpenDefault: () => void;
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
  const ext = name.toLowerCase().split('.').pop() || '';

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

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
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
function SortHeader({ label, active, dir, onClick }: {
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
