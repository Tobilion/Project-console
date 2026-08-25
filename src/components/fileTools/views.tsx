// File Tools views (2026-08-24, split out of FileToolsPanel.tsx): the shared file row, the
// Search / Tidy / Duplicates view blocks and the in-console HTML preview overlay. Pure
// props — the panel owns all fetch/selection state.

import { FolderOpen, Eye, ExternalLink, X, Send, RefreshCw, Check, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fileIcon, formatSize, formatDate } from './utils';
import type { FileEntry, SearchResult, DuplicateGroup } from './utils';

export interface FileToolsViewsProps {
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  runSearch: (q: string) => void;
  handleSearchKeyDown: (e: React.KeyboardEvent) => void;
  loading: boolean;
  searchResults: SearchResult[];
  previewFile: (path: string) => void;
  tidyByDate: boolean;
  tidyPlan: { from: string; to: string }[];
  tidySelected: Set<string>;
  setTidySelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  runTidy: () => void;
  fetchTidyPlan: (byDate: boolean) => void;
  dupeGroups: DuplicateGroup[];
  dupSelected: Set<string>;
  setDupSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  runDupDelete: () => void;
  fetchDuplicates: () => void;
  runBtn: string;
}

/** One file-browser row — also reused for search hits via the standalone FileRow below. */
export function FileRow({ entry, onClick }: { entry: FileEntry; onClick?: () => void }) {
  const { name, path, size, modifiedAt, isDir } = entry;
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      } : undefined}
      className={cn('flex items-center gap-2 px-2 py-1.5 hover:bg-scrim-faint rounded transition-colors text-xs min-h-[30px]', onClick && 'cursor-pointer')} onClick={onClick}>
      {isDir ? <FolderOpen size={14} className="text-accent shrink-0" /> : fileIcon(name)}
      <span className="text-fg-strong truncate flex-1 font-mono">{name}</span>
      <span className="text-fg-dim text-[11px] hidden sm:block truncate max-w-[180px]" title={path}>{path}</span>
      {!isDir && <span className="text-fg-dim text-[11px] text-right w-[60px] shrink-0">{formatSize(size)}</span>}
      {!isDir && <span className="text-fg-dim text-[11px] text-right w-[100px] shrink-0 hidden sm:block">{formatDate(modifiedAt)}</span>}
    </div>
  );
}

/** The in-console HTML preview overlay — iframe against the static mount. */
export function PreviewOverlay({ previewUrl, previewName, onSendMessage, onClose }: {
  previewUrl: string | null;
  previewName: string;
  onSendMessage: (t: string) => void;
  onClose: () => void;
}) {
  if (!previewUrl) return null;
  return (
    <div className="absolute inset-0 z-20 bg-scrim/90 backdrop-blur-sm flex flex-col p-4">
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <div className="p-1 rounded-lg bg-accent-blue/15 text-accent-blue">
          <Eye size={14} />
        </div>
        <h3 className="text-xs font-semibold text-fg-strong tracking-wide uppercase">Preview — {previewName}</h3>
        <div className="flex-1" />
        <button
          onClick={() => onSendMessage(`open ${previewName} in the browser`)}
          title="Open in your default browser"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-accent-blue text-white hover:opacity-90 transition-opacity"
        >
          <ExternalLink size={12} /> Open in browser
        </button>
        <button onClick={onClose} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors" title="Close preview">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 rounded-xl border border-border-strong bg-white overflow-hidden">
        <iframe
          src={previewUrl}
          title={`Preview: ${previewName}`}
          // sandbox WITHOUT allow-same-origin: the previewed HTML runs in an opaque origin,
          // so a project file's scripts can still execute (relative assets work) but can
          // never read this console's same-origin /api data. The file being previewed may be
          // third-party/downloaded HTML, not just the user's own pages.
          sandbox="allow-scripts allow-modals"
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
}

/** Search & Browse view block. */
export function SearchView(props: FileToolsViewsProps & { previewFile: (path: string) => void; fileEntries: FileEntry[]; currentPath: string; onOpenFolder: (path: string) => void }) {
  const { searchQuery, setSearchQuery, runSearch, handleSearchKeyDown, loading, searchResults, previewFile, fileEntries, currentPath, onOpenFolder } = props;
  return (
    <>
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search by name or content (press Enter)"
            className="flex-1 text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent-blue/50"
          />
          <button onClick={() => runSearch(searchQuery)} disabled={!searchQuery.trim()} className={props.runBtn}>
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
                {/\.html?$/i.test(r.path) && (
                  <button
                    onClick={() => previewFile(r.path)}
                    title="Preview in the console"
                    className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold text-accent-blue hover:bg-accent-blue/15 transition-colors"
                  >
                    <Eye size={11} /> Preview
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {searchQuery.trim() && !loading && searchResults.length === 0 && (
          <p className="text-xs text-fg-dim italic">No matches. Try a different term, or browse below.</p>
        )}
      </div>
      <div className="mt-4 rounded-xl border border-border-soft overflow-hidden">
        <div className="text-[11px] text-fg-dim px-3 py-1 bg-scrim-faint flex items-center gap-1">
          <FolderOpen size={12} /> {currentPath}
        </div>
        {fileEntries.length === 0 && !loading ? (
          <div className="px-3 py-6 text-xs text-fg-dim italic text-center">This folder is empty.</div>
        ) : (
          fileEntries.map((f) => (
            <FileRow key={f.path} entry={f} onClick={f.isDir ? () => onOpenFolder(f.path) : undefined} />
          ))
        )}
      </div>
    </>
  );
}

/** Tidy move-preview view block. */
export function TidyView(props: FileToolsViewsProps) {
  const { tidyByDate, fetchTidyPlan, runTidy, tidySelected, setTidySelected, tidyPlan } = props;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-panel-strong rounded-lg p-0.5 border border-border-soft">
          <button
            onClick={() => fetchTidyPlan(false)}
            className={cn('px-3 py-1.5 text-xs rounded-lg transition-colors', !tidyByDate ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-muted hover:text-fg-strong')}
          >
            By type
          </button>
          <button
            onClick={() => fetchTidyPlan(true)}
            className={cn('px-3 py-1.5 text-xs rounded-lg transition-colors', tidyByDate ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-muted hover:text-fg-strong')}
          >
            By date
          </button>
        </div>
        <button
          onClick={runTidy}
          disabled={tidySelected.size === 0}
          className={cn(props.runBtn, 'w-auto')}
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
                  className={cn('shrink-0 w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-colors', on ? 'border-accent-blue bg-accent-blue/15' : 'border-border-soft')}
                  title={on ? 'Exclude this move' : 'Include this move'}
                >
                  {on && <CheckCircle2 size={12} className="text-accent-blue" />}
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
}

/** Duplicates view block. */
export function DuplicatesView(props: FileToolsViewsProps) {
  const { fetchDuplicates, loading, dupeGroups, dupSelected, setDupSelected, runDupDelete } = props;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={fetchDuplicates} disabled={loading} className={cn(props.runBtn, 'w-auto')}>
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} /> Scan for duplicates
        </button>
        {dupeGroups.length > 0 && (
          <button onClick={runDupDelete} disabled={dupSelected.size === 0} className={cn(props.runBtn, 'w-auto !bg-accent-red/15 !text-accent-red !border !border-accent-red/30 hover:!bg-accent-red/20')}>
            Delete {dupSelected.size} selected older cop{dupSelected.size === 1 ? 'y' : 'ies'}
          </button>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        Per-row checkboxes select which older copies to delete — the newest copy of each group is
        always kept and cannot be selected.
      </p>
      {dupeGroups.length > 0 && (
        <div className="space-y-4">
          {dupeGroups.map((g, gi) => (
            <div key={g.hash}>
              <div className="flex items-center gap-2 px-1 py-1 text-xs font-semibold text-fg-muted">
                <span>{g.files.length} copies — {formatSize(g.waste)} wasted</span>
              </div>
              <div className="flex gap-2 flex-wrap">
                {g.files.map((f) => {
                  const isKeep = f.path === g.keepPath;
                  const on = !isKeep && dupSelected.has(f.path);
                  return (
                    <div key={f.path} className={cn('w-[230px] rounded-xl border p-3 flex flex-col gap-1.5', isKeep ? 'border-accent-blue/40 bg-accent-blue/5' : 'bg-panel-strong border-border-faint')}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        {fileIcon(f.path)}
                        <span className="text-fg-strong truncate font-mono text-[11px]" title={f.path}>{f.path.split('/').pop()}</span>
                      </div>
                      <div className="text-[10px] text-fg-dim font-mono truncate" title={f.path}>{f.path}</div>
                      <div className="flex items-center justify-between text-[10px] text-fg-dim">
                        <span>{formatSize(f.size)}</span>
                        <span>{formatDate(f.modifiedAt)}</span>
                      </div>
                      <div className="mt-1.5">
                        {isKeep ? (
                          <span className="flex items-center justify-center gap-1 text-[11px] font-semibold text-accent-blue">
                            <Check size={12} /> keep newest
                          </span>
                        ) : (
                          <button
                            onClick={() => setDupSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(f.path)) next.delete(f.path); else next.add(f.path);
                              return next;
                            })}
                            className={cn('w-full flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors',
                              on ? 'border-accent-blue bg-accent-blue text-white' : 'border-border-strong text-fg-muted hover:border-accent-blue/60 hover:text-fg-strong')}
                          >
                            {on && <Check size={12} />} {on ? 'will delete' : 'select for delete'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && dupeGroups.length === 0 && (
        <p className="text-xs text-fg-dim italic">No duplicate files found. Click "Scan" to check.</p>
      )}
    </div>
  );
}