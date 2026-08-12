import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderSearch, RefreshCw, Send, Check, CheckCircle2, File, FileText, FolderOpen, Image, Music, Video, Archive, Table } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';

// Phase 2 catch-up (UPGRADE-ROADMAP.md, 2026-08-12): the File Tools panel — Finder-style
// file list + dedicated duplicate-finder layout per the Design Tokens Appendix. Mutations
// (tidy, duplicates_delete) go through the normal WS trigger-command path so confirm cards,
// journaling, and revert work identically from the panel and chat.

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
}

interface SearchResult {
  path: string;
  match: string;
  size: number;
  modifiedAt: number;
}

interface DuplicateGroup {
  hash: string;
  files: { path: string; size: number; modifiedAt: number }[];
  waste: number;
  keepPath: string;
}

interface FileToolsPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
}

const POLL_MS = 15000;

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fileIcon(name: string) {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (/^(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/.test(ext)) return <Image size={14} className="text-fg-dim shrink-0" />;
  if (/^(mp3|wav|flac|ogg|m4a|aac)$/.test(ext)) return <Music size={14} className="text-fg-dim shrink-0" />;
  if (/^(mp4|mkv|avi|mov|webm)$/.test(ext)) return <Video size={14} className="text-fg-dim shrink-0" />;
  if (/^(zip|rar|7z|tar|gz|tgz)$/.test(ext)) return <Archive size={14} className="text-fg-dim shrink-0" />;
  if (/^(xls|xlsx|csv|ods)$/.test(ext)) return <Table size={14} className="text-fg-dim shrink-0" />;
  if (/^(txt|md|json|js|ts|jsx|tsx|css|html|py|rb)$/.test(ext)) return <FileText size={14} className="text-fg-dim shrink-0" />;
  return <File size={14} className="text-fg-dim shrink-0" />;
}

export function FileToolsPanel({ project, onSendMessage }: FileToolsPanelProps) {
  const [view, setView] = useState<'search' | 'tidy' | 'duplicates'>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('.');
  const [dupeGroups, setDupeGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchFiles = useCallback(async (dirPath?: string) => {
    if (!project?.id) return;
    setLoading(true);
    const p = dirPath ?? currentPath;
    const data = await apiFetchJson<{ entries: FileEntry[]; error?: string }>(
      `/api/projects/${encodeURIComponent(project.id)}/files?path=${encodeURIComponent(p)}`
    );
    setLoading(false);
    if (!data) { setError('Could not load files.'); return; }
    if (data.error) { setError(data.error); return; }
    setError(null);
    setFileEntries(data.entries || []);
    setCurrentPath(p);
  }, [project?.id, currentPath]);

  useEffect(() => {
    if (project?.id) {
      setCurrentPath('.');
      fetchFiles('.');
    }
  }, [project?.id]);

  const runSearch = useCallback(async (q: string) => {
    if (!project?.id || !q.trim()) return;
    setLoading(true);
    const data = await apiFetchJson<{ results: SearchResult[] }>(
      `/api/projects/${encodeURIComponent(project.id)}/search-files?q=${encodeURIComponent(q.trim())}`
    );
    setLoading(false);
    if (!data) { setError('Search failed.'); return; }
    setError(null);
    setSearchResults(data.results || []);
  }, [project?.id]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      runSearch(searchQuery);
    }
  };

  const fetchDuplicates = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    const data = await apiFetchJson<{ groups: DuplicateGroup[] }>(
      `/api/projects/${encodeURIComponent(project.id)}/duplicates`
    );
    setLoading(false);
    if (!data) { setError('Could not scan for duplicates.'); return; }
    setError(null);
    setDupeGroups(data.groups || []);
    // Phase 2 audit: per-row delete checkboxes — older copies start checked (keep-newest
    // convention), the newest copy of each group is never selectable.
    setDupSelected((prev) => {
      const next = new Set(prev);
      next.clear();
      for (const g of data.groups || []) {
        for (const f of g.files) {
          if (f.path !== g.keepPath) next.add(f.path);
        }
      }
      return next;
    });
  }, [project?.id]);
  useEffect(() => {
    if (view === 'duplicates' && project?.id) fetchDuplicates();
  }, [view, project?.id]);

  // Phase 2 audit: tidy move-preview table — fetch the same plan the chat confirm flow uses,
  // let the user exclude individual moves with per-row checkboxes, then run the filtered set.
  const [tidyPlan, setTidyPlan] = useState<{ from: string; to: string }[]>([]);
  const [tidyByDate, setTidyByDate] = useState(false);
  const [tidySelected, setTidySelected] = useState<Set<string>>(new Set());
  const [dupSelected, setDupSelected] = useState<Set<string>>(new Set());
  const fetchTidyPlan = useCallback(async (byDate: boolean) => {
    if (!project?.id) return;
    setLoading(true);
    const data = await apiFetchJson<{ moves: { from: string; to: string }[] }>(
      `/api/projects/${encodeURIComponent(project.id)}/tidy-plan?by=${byDate ? 'date' : 'type'}`
    );
    setLoading(false);
    if (!data) { setError('Could not build the tidy plan.'); return; }
    setError(null);
    setTidyPlan(data.moves || []);
    setTidyByDate(byDate);
    setTidySelected(new Set((data.moves || []).map((m) => m.from)));
  }, [project?.id]);
  useEffect(() => {
    if (view === 'tidy' && project?.id) fetchTidyPlan(false);
  }, [view, project?.id]);

  const runTidy = () => {
    const files = [...tidySelected];
    if (files.length === 0) return;
    const verb = tidyByDate ? 'tidy this folder by date' : 'tidy this folder';
    send(files.length === tidyPlan.length ? verb : `${verb}: ${files.join(', ')}`);
  };

  const runDupDelete = () => {
    const files = [...dupSelected];
    if (files.length === 0) return;
    send(`delete duplicates, keep newest: ${files.join(', ')}`);
  };

  const send = (text: string) => {
    onSendMessage(text);
    setLastSent(text);
    if (lastSentTimer.current) clearTimeout(lastSentTimer.current);
    lastSentTimer.current = setTimeout(() => setLastSent(null), 8000);
  };

  const runBtn = 'flex items-center justify-center gap-1.5 text-xs font-medium rounded-lg px-3 py-2 bg-accent/90 text-white hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const tabBtn = (v: string, label: string) => (
    <button onClick={() => setView(v as typeof view)} className={cn('px-3 py-1.5 text-xs rounded-lg transition-colors', view === v ? 'bg-accent/15 text-accent font-semibold' : 'text-fg-muted hover:text-fg-strong')}>{label}</button>
  );

  const Row = ({ name, path, size, modifiedAt, isDir, onClick }: FileEntry & { onClick?: () => void }) => (
    <div className={cn('flex items-center gap-2 px-2 py-1.5 hover:bg-scrim-faint rounded transition-colors text-xs min-h-[30px]', onClick && 'cursor-pointer')} onClick={onClick}>
      {isDir ? <FolderOpen size={14} className="text-accent shrink-0" /> : fileIcon(name)}
      <span className="text-fg-strong truncate flex-1 font-mono">{name}</span>
      <span className="text-fg-dim text-[11px] hidden sm:block truncate max-w-[180px]" title={path}>{path}</span>
      {!isDir && <span className="text-fg-faint text-[11px] text-right w-[60px] shrink-0">{formatSize(size)}</span>}
      {!isDir && <span className="text-fg-faint text-[11px] text-right w-[100px] shrink-0 hidden sm:block">{formatDate(modifiedAt)}</span>}
    </div>
  );

  const SearchView = (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search by name or content (press Enter)"
          className="flex-1 text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent/50"
        />
        <button onClick={() => runSearch(searchQuery)} disabled={!searchQuery.trim()} className={runBtn}>
          Search
        </button>
      </div>
      {searchResults.length > 0 && (
        <div className="rounded-xl border border-border-soft overflow-hidden">
          <div className="text-[11px] text-fg-dim px-3 py-1 bg-scrim-faint">Search results ({searchResults.length} hits)</div>
          {searchResults.map((r) => (
            <div key={r.path} className="border-t border-border-faint flex items-center gap-2 px-3 py-1.5 text-xs min-h-[30px]">
              {fileIcon(r.path)}
              <span className="text-fg-strong truncate flex-1 font-mono" title={r.path}>{r.path}</span>
              <span className="text-fg-dim text-[11px]">{formatSize(r.size)}</span>
              <span className="text-fg-dim text-[11px] hidden sm:block">{formatDate(r.modifiedAt)}</span>
            </div>
          ))}
        </div>
      )}
      {searchQuery.trim() && !loading && searchResults.length === 0 && (
        <p className="text-xs text-fg-dim italic">No matches. Try a different term, or browse below.</p>
      )}
    </div>
  );

  const TidyView = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-panel-strong rounded-lg p-0.5 border border-border-soft">
          <button
            onClick={() => fetchTidyPlan(false)}
            className={cn('px-3 py-1.5 text-xs rounded-md transition-colors', !tidyByDate ? 'bg-accent/15 text-accent font-semibold' : 'text-fg-muted hover:text-fg-strong')}
          >
            By type
          </button>
          <button
            onClick={() => fetchTidyPlan(true)}
            className={cn('px-3 py-1.5 text-xs rounded-md transition-colors', tidyByDate ? 'bg-accent/15 text-accent font-semibold' : 'text-fg-muted hover:text-fg-strong')}
          >
            By date
          </button>
        </div>
        <button
          onClick={runTidy}
          disabled={tidySelected.size === 0}
          className={cn(runBtn, 'w-auto')}
        >
          <Send size={12} /> Move {tidySelected.size} file{tidySelected.size === 1 ? '' : 's'}
        </button>
      </div>
      <p className="text-xs text-fg-muted">
        Uncheck any row to exclude it. The selected moves run through the normal confirm flow —
        the card appears above, wherever you are.
      </p>
      {tidyPlan.length === 0 ? (
        <p className="text-xs text-fg-dim italic">No moves planned — the folder's root files are already organized (or none match the categories).</p>
      ) : (
        <div className="rounded-xl border border-border-soft overflow-hidden">
          <div className="text-[11px] text-fg-dim px-3 py-1.5 bg-scrim-faint border-b border-border-faint">Move preview — {tidyPlan.length} file(s)</div>
          {tidyPlan.map((m) => {
            const on = tidySelected.has(m.from);
            return (
              <div key={m.from} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border-faint last:border-b-0 min-h-[32px]">
                <button
                  onClick={() => setTidySelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(m.from)) next.delete(m.from); else next.add(m.from);
                    return next;
                  })}
                  className={cn('shrink-0 w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-colors', on ? 'border-accent bg-accent/15' : 'border-border-soft')}
                  title={on ? 'Exclude this move' : 'Include this move'}
                >
                  {on && <CheckCircle2 size={12} className="text-accent" />}
                </button>
                {fileIcon(m.from)}
                <span className="text-fg-strong truncate flex-1 font-mono" title={m.from}>{m.from}</span>
                <span className="text-fg-faint text-[11px]">→</span>
                <span className="text-fg-muted truncate font-mono flex-1" title={m.to}>{m.to}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const DuplicatesView = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={fetchDuplicates} disabled={loading} className={cn(runBtn, 'w-auto')}>
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} /> Scan for duplicates
        </button>
        {dupeGroups.length > 0 && (
          <button onClick={runDupDelete} disabled={dupSelected.size === 0} className={cn(runBtn, 'w-auto !bg-[#FF3B30]/15 !text-[#FF3B30] !border !border-[#FF3B30]/30 hover:!bg-[#FF3B30]/20')}>
            Delete {dupSelected.size} selected older cop{dupSelected.size === 1 ? 'y' : 'ies'}
          </button>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        Per-row checkboxes select which older copies to delete — the newest copy of each group is
        always kept and cannot be selected.
      </p>
      {dupeGroups.length > 0 && (
        <div className="rounded-xl border border-border-soft overflow-hidden">
          {dupeGroups.map((g, gi) => (
            <div key={g.hash} className={gi > 0 ? 'border-t border-border-soft' : ''}>
              <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold bg-scrim-faint text-fg-muted">
                <span>{g.files.length} copies — {formatSize(g.waste)} wasted</span>
              </div>
              {g.files.map((f) => {
                const isKeep = f.path === g.keepPath;
                const on = !isKeep && dupSelected.has(f.path);
                return (
                  <div key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs border-t border-border-faint min-h-[30px]">
                    <button
                      onClick={() => { if (isKeep) return; setDupSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(f.path)) next.delete(f.path); else next.add(f.path);
                        return next;
                      }); }}
                      disabled={isKeep}
                      className={cn('shrink-0 w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-colors', on ? 'border-accent bg-accent/15' : isKeep ? 'border-border-soft opacity-40' : 'border-border-soft')}
                      title={isKeep ? 'Newest copy — always kept' : on ? 'Exclude from delete' : 'Select for delete'}
                    >
                      {on && <CheckCircle2 size={12} className="text-accent" />}
                      {isKeep && <Check size={12} className="text-fg-faint" />}
                    </button>
                    {fileIcon(f.path)}
                    <span className="text-fg-strong truncate flex-1 font-mono" title={f.path}>{f.path}</span>
                    <span className="text-fg-dim text-[11px]">{formatSize(f.size)}</span>
                    <span className={cn('text-[11px]', isKeep ? 'text-accent font-semibold' : 'text-fg-faint')}>{isKeep ? 'keep newest' : 'older copy'}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {!loading && dupeGroups.length === 0 && (
        <p className="text-xs text-fg-dim italic">No duplicate files found. Click "Scan" to check.</p>
      )}
    </div>
  );

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-fg-muted">Select a project to browse its files.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-scrim-faint rounded-lg text-accent">
              <FolderSearch size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">File Tools</h2>
            <span className="text-xs text-fg-dim font-normal normal-case">— {project.name}</span>
          </div>
          <button onClick={() => fetchFiles(currentPath)} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-md transition-colors" title="Refresh">
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        <div className="flex items-center gap-1 mb-4">
          {tabBtn('search', 'Search & Browse')}
          {tabBtn('tidy', 'Tidy')}
          {tabBtn('duplicates', 'Duplicates')}
        </div>

        {lastSent && (
          <div className="mb-3 flex items-start gap-2 text-[11px] text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-2.5">
            <CheckCircle2 size={13} className="text-accent mt-0.5 shrink-0" />
            <span>Sent <code className="font-mono text-accent">{lastSent}</code> — confirm or follow the result in the chat below.</span>
          </div>
        )}

        {view === 'search' && SearchView}
        {view === 'tidy' && TidyView}
        {view === 'duplicates' && DuplicatesView}

        {view === 'search' && (
          <div className="mt-4 rounded-xl border border-border-soft overflow-hidden">
            <div className="text-[11px] text-fg-dim px-3 py-1 bg-scrim-faint flex items-center gap-1">
              <FolderOpen size={12} /> {currentPath}
            </div>
            {fileEntries.length === 0 && !loading ? (
              <div className="px-3 py-6 text-xs text-fg-dim italic text-center">This folder is empty.</div>
            ) : (
              fileEntries.map((f) => (
                <Row key={f.path} {...f} onClick={f.isDir ? () => { setCurrentPath(f.path); fetchFiles(f.path); } : undefined} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
