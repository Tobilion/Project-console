import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderSearch, RefreshCw, CheckCircle2 } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { projectApi } from '../utils/projectApi';
import { useFlashMessage } from '../hooks/usePanelPolling';
import { cn } from '../lib/utils';
import type { Project } from '../types';
import { SearchView, TidyView, DuplicatesView, PreviewOverlay } from './fileTools/views';
import type { FileEntry, SearchResult, DuplicateGroup } from './fileTools/utils';

interface FileToolsPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
  tabId?: string | null;
}

export function FileToolsPanel({ project, onSendMessage, tabId = null }: FileToolsPanelProps) {
  const [view, setView] = useState('search');
  const [currentPath, setCurrentPath] = useState('.');
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [dupeGroups, setDupeGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, flashSent] = useFlashMessage();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState('');

  // Clear the search-debounce timer on unmount so its delayed setState can't fire on a dead
  // panel (and hold its closure alive after it unmounted).
  useEffect(() => () => {
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

  // D-7 (2026-09-08): tidy/duplicates-delete now hit direct REST endpoints (fileToolsRoutes.js)
  // instead of composing a chat trigger phrase. The panel already renders its own preview
  // (tidy-plan / duplicates) and its own confirm step (the Run button itself), so the old WS
  // round-trip only added chat noise. The REST endpoints replicate the exact checkpoint +
  // perform + appendAction journal sequence from connectionConfirm.js's generalFileOp branch,
  // so 'revert action <id>' and the undo toast keep working identically.
  const runTidy = async () => {
    if (!project?.id) return;
    const files = [...tidySelected];
    if (files.length === 0) return;
    const moves = tidyPlan.filter((m) => files.includes(m.from));
    setLoading(true);
    const result = await apiFetchJson<{ ok: boolean; moved?: number; error?: string; actionIds?: string[] }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/tidy`, tabId),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moves }) }
    );
    setLoading(false);
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.ok) { setError(result.error || 'Could not tidy the folder.'); return; }
    setError(null);
    flashSent(`Moved ${result.moved ?? moves.length} file(s). Undo with "revert action <id>" or "show history".`);
    fetchTidyPlan(tidyByDate);
  };

  const runDupDelete = async () => {
    if (!project?.id) return;
    const files = [...dupSelected];
    if (files.length === 0) return;
    setLoading(true);
    const result = await apiFetchJson<{ ok: boolean; deleted?: number; error?: string; actionIds?: string[] }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/duplicates`, tabId),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) }
    );
    setLoading(false);
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.ok) { setError(result.error || 'Could not delete the duplicates.'); return; }
    setError(null);
    flashSent(`Deleted ${result.deleted ?? files.length} file(s). Undo with "revert action <id>" or "show history".`);
    fetchDuplicates();
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
              <div className="mb-3 flex items-start gap-2 text-[11px] text-accent-green bg-scrim-faint border border-border-soft rounded-lg p-2.5">
                <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
                <span>{lastSent}</span>
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