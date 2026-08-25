import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderSearch, RefreshCw, CheckCircle2 } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { projectApi } from '../utils/projectApi';
import { cn } from '../lib/utils';
import type { Project } from '../types';
import { SearchView, TidyView, DuplicatesView, PreviewOverlay } from './fileTools/views';
import type { FileEntry, SearchResult, DuplicateGroup } from './fileTools/utils';

interface FileToolsPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
  tabId?: string | null;
}

const POLL_MS = 15000;

export function FileToolsPanel({ project, onSendMessage, tabId = null }: FileToolsPanelProps) {
  const [view, setView] = useState('search');
  const [currentPath, setCurrentPath] = useState('.');
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [dupeGroups, setDupeGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState('');

  // Clear the transient-state timers on unmount so their delayed setState can't fire on a
  // dead panel (and hold their closures alive after it unmounted).
  useEffect(() => () => {
    if (lastSentTimer.current) clearTimeout(lastSentTimer.current);
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const fetchFiles = useCallback(async (p: string) => {
    if (!project?.id) return;
    setLoading(true);
    const data = await apiFetchJson<{ entries: FileEntry[]; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/files?path=${encodeURIComponent(p)}`, tabId)
    );
    setLoading(false);
    if (!data) { setError('Could not load files.'); return; }
    if (data.error) { setError(data.error); return; }
    setError(null);
    setFileEntries(data.entries || []);
    setCurrentPath(p);
  }, [project?.id, currentPath, tabId]);

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
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/search-files?q=${encodeURIComponent(q.trim())}`, tabId)
    );
    setLoading(false);
    if (!data) { setError('Search failed.'); return; }
    setError(null);
    setSearchResults(data.results || []);
  }, [project?.id, tabId]);

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
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/duplicates`, tabId)
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
  }, [project?.id, tabId]);
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
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/tidy-plan?by=${byDate ? 'date' : 'type'}`, tabId)
    );
    setLoading(false);
    if (!data) { setError('Could not build the tidy plan.'); return; }
    setError(null);
    setTidyPlan(data.moves || []);
    setTidyByDate(byDate);
    setTidySelected(new Set((data.moves || []).map((m) => m.from)));
  }, [project?.id, tabId]);
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

  const runBtn = 'flex items-center justify-center gap-1.5 text-xs font-bold rounded-lg px-3 py-2 bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed';
  const tabBtn = (v: string, label: string) => (
    <button onClick={() => setView(v as typeof view)} className={cn('w-full text-left px-3 py-2 text-xs rounded-lg transition-colors', view === v ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-muted hover:text-fg-strong hover:bg-panel-strong/60')}>{label}</button>
  );

  const previewFile = (path: string) => {
    if (!project?.id) return;
    setPreviewName(path.split('/').pop() || path);
    setPreviewUrl(projectApi(`/api/projects/${encodeURIComponent(project.id)}/static/${path.split('/').map(encodeURIComponent).join('/')}`, tabId));
  };

  const viewsProps = {
    searchQuery, setSearchQuery, runSearch, handleSearchKeyDown, loading, searchResults,
    previewFile, tidyByDate, tidyPlan, tidySelected, setTidySelected, runTidy, fetchTidyPlan,
    dupeGroups, dupSelected, setDupSelected, runDupDelete, fetchDuplicates, runBtn,
  };

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-fg-muted">Select a project to browse its files.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-faint shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-accent-teal/15 text-accent-teal">
            <FolderSearch size={16} />
          </div>
          <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">File Tools</h2>
          <span className="text-xs text-fg-dim font-normal normal-case">— {project.name}</span>
        </div>
        <button onClick={() => fetchFiles(currentPath)} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors" title="Refresh">
          <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {error && <p className="text-xs text-accent-red px-4 py-1.5">{error}</p>}

      <div className="flex-1 min-h-0 flex">
        {/* Left filter sidebar — Finder-style rail. Hidden below md (2026-08-24 responsive
        pass): at 375px the fixed 190px rail left the file browser ~185px wide. */}
        <div className="hidden md:flex w-[190px] shrink-0 bg-overlay border-r border-border-faint p-3 flex-col gap-1 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-fg-dim font-bold mb-1">Views</p>
          {tabBtn('search', 'Search & Browse')}
          {tabBtn('tidy', 'Tidy')}
          {tabBtn('duplicates', 'Duplicates')}
        </div>

        {/* Right file browser */}
        <div className="flex-1 min-w-0 bg-panel overflow-y-auto p-4">
          <div className="max-w-4xl mx-auto">
            {lastSent && (
              <div className="mb-3 flex items-start gap-2 text-[11px] text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-2.5">
                <CheckCircle2 size={13} className="text-accent-blue mt-0.5 shrink-0" />
                <span>Sent <code className="font-mono text-accent-blue">{lastSent}</code> — confirm or follow the result in the chat below.</span>
              </div>
            )}

            {view === 'search' && (
              <SearchView
                {...viewsProps}
                previewFile={previewFile}
                fileEntries={fileEntries}
                currentPath={currentPath}
                onOpenFolder={(p) => { setCurrentPath(p); fetchFiles(p); }}
              />
            )}
            {view === 'tidy' && <TidyView {...viewsProps} />}
            {view === 'duplicates' && <DuplicatesView {...viewsProps} />}
          </div>
        </div>
      </div>

      {/* Phase T: in-console HTML preview overlay — iframe against the static mount. */}
      <PreviewOverlay
        previewUrl={previewUrl}
        previewName={previewName}
        onSendMessage={onSendMessage}
        onClose={() => setPreviewUrl(null)}
      />
    </div>
  );
}