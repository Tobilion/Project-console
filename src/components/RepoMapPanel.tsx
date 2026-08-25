import { useCallback, useEffect, useMemo, useState } from 'react';
import { Map as MapIcon, RefreshCw, FileCode2, Route, Layers, Search } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { EmptyState } from './ui/EmptyState';
import { cn } from '../lib/utils';
import type { Project } from '../types';

// Round-6 audit (2026-08-24): Aider-style repo-map panel. Renders the SAME structure that
// feeds the AI system prompt (per-file top-level signatures + imports + reverse "used by"
// from codebaseIndexer.js buildRepoMap) plus the detected API routes — so what the model
// "sees" about a project is something the user can actually look at too. Read-only by
// design: the index is built server-side; this panel never scans or writes anything.

interface RepoMapEntry {
  path: string;
  signatures?: string[];
  imports?: string[];
  importedBy?: string[];
  symbols?: { name: string; line: number }[];
}

interface RepoMapData {
  repoMap: RepoMapEntry[];
  apiRoutes: { method: string; path: string; file: string }[];
  languages: string[];
  frameworks: string[];
  entryPoints: string[];
  subPackages: { path: string; manifests: string[] }[];
  isMonorepo: boolean;
  totalFiles: number;
  totalDirs: number;
  hasRealCode: boolean;
  indexed: boolean;
}

interface RepoMapPanelProps {
  project: Project | null;
  tabId?: string | null;
}

export function RepoMapPanel({ project, tabId = null }: RepoMapPanelProps) {
  const [data, setData] = useState<RepoMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [showRoutes, setShowRoutes] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const fetchMap = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetchJson<RepoMapData>(
        `/api/projects/${encodeURIComponent(project.id)}/repo-map${tabId ? `?tab=${encodeURIComponent(tabId)}` : ''}`,
      );
      if (!res) {
        setError('No repo map returned — is this project indexed?');
        return;
      }
      setData(res);
    } catch {
      setError('Could not load the repo map for this project.');
    } finally {
      setLoading(false);
    }
  }, [project, tabId]);

  useEffect(() => {
    setData(null);
    if (project) fetchMap();
  }, [project, tabId, fetchMap]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!data) return [];
    const rows = data.repoMap || [];
    if (!q) return rows;
    return rows.filter((e) =>
      e.path.toLowerCase().includes(q) ||
      (e.signatures || []).some((s) => s.toLowerCase().includes(q)),
    );
  }, [data, q]);

  const selectedEntry = useMemo(
    () => (selected ? (data?.repoMap || []).find((e) => e.path === selected) : null),
    [selected, data],
  );

  if (!project) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <EmptyState
          title="No project selected"
          hint="Pick a project from the sidebar first — the repo map is per project."
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-accent-blue/15 text-accent-blue">
            <MapIcon size={16} />
          </div>
          <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Repo Map</h2>
        </div>
        <button
          onClick={fetchMap}
          disabled={loading}
          className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors disabled:opacity-50"
          title="Re-fetch the repo map"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {data && (
        <div className="flex flex-wrap gap-1.5 mb-3 shrink-0">
          {data.languages.slice(0, 4).map((l) => (
            <span key={l} className="px-2 py-0.5 text-[10px] rounded-full bg-accent-teal/10 text-accent-teal border border-accent-teal/20">{l}</span>
          ))}
          {data.frameworks.map((f) => (
            <span key={f} className="px-2 py-0.5 text-[10px] rounded-full bg-accent-blue/10 text-accent-blue border border-accent-blue/20">{f}</span>
          ))}
          <span className="px-2 py-0.5 text-[10px] rounded-full bg-scrim-faint text-fg-dim border border-border-soft">
            {data.totalFiles} files · {data.totalDirs} dirs{data.isMonorepo ? ' · monorepo' : ''}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 mb-3 shrink-0">
        <div className="flex-1 flex items-center gap-2 bg-surface border border-border-soft rounded-lg px-2.5 py-1.5">
          <Search size={13} className="text-fg-dim shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files or symbols…"
            className="bg-transparent outline-none flex-1 text-xs text-fg placeholder:text-fg-dim"
          />
        </div>
        <button
          onClick={() => setShowRoutes(!showRoutes)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors',
            showRoutes ? 'border-accent-blue bg-accent-blue/10 text-accent-blue' : 'border-border-soft text-fg-dim hover:text-fg-strong',
          )}
          title="Toggle the detected API route list"
        >
          <Route size={12} /> Routes {(data?.apiRoutes || []).length || ''}
        </button>
      </div>

      {showRoutes && data && (
        <div className="mb-3 shrink-0 bg-panel rounded-xl border border-border-soft p-3 max-h-48 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-fg-dim font-bold mb-1.5 flex items-center gap-1">
            <Route size={10} /> Detected API routes
          </p>
          {(data.apiRoutes || []).length === 0 ? (
            <p className="text-[11px] text-fg-dim italic">No Express/Flask/FastAPI/Django routes detected.</p>
          ) : (
            <div className="space-y-0.5">
              {(data.apiRoutes || []).map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] font-mono">
                  <span className={cn('px-1.5 py-px rounded text-[9px] font-bold uppercase', r.method === 'GET' ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-orange/15 text-accent-orange')}>{r.method}</span>
                  <span className="text-fg-subtle truncate">{r.path}</span>
                  <span className="text-fg-faint ml-auto truncate">{r.file}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-3">
        <div className="flex-1 min-h-0 overflow-y-auto bg-panel rounded-xl border border-border-soft">
          {loading && !data ? (
            <p className="text-xs text-fg-dim p-4 italic">Building the repo map…</p>
          ) : error ? (
            <div className="p-4">
              <EmptyState title="Couldn't load the repo map" hint={error} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={q ? `No files match "${query}"` : 'This project has no indexed code files'}
                hint={q ? 'Try a shorter phrase, or clear the filter.' : 'The repo map covers JS/TS/Python/Go/Rust/Java/Ruby/PHP/C# files.'}
              />
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-panel z-10">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 font-bold">File</th>
                  <th className="px-3 py-2 font-bold hidden sm:table-cell">Signatures</th>
                  <th className="px-3 py-2 font-bold hidden md:table-cell">Imports</th>
                  <th className="px-3 py-2 font-bold hidden lg:table-cell">Used by</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((e) => (
                  <tr
                    key={e.path}
                    onClick={() => setSelected(selected === e.path ? null : e.path)}
                    className={cn(
                      'border-t border-border-faint cursor-pointer transition-colors',
                      selected === e.path ? 'bg-accent-blue/10' : 'hover:bg-scrim-faint',
                    )}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <FileCode2 size={12} className="text-accent shrink-0" />
                        <span className="text-[11px] font-mono text-fg-subtle break-all">{e.path}</span>
                      </div>
                      <span className="text-[10px] text-fg-faint sm:hidden">
                        {(e.signatures || []).slice(0, 3).join(', ')}
                      </span>
                    </td>
                    <td className="px-3 py-2 hidden sm:table-cell">
                      <span className="text-[11px] font-mono text-fg-muted leading-relaxed">
                        {(e.signatures || []).slice(0, 6).join(', ') || <i className="text-fg-faint">(none)</i>}
                      </span>
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell">
                      <span className="text-[11px] font-mono text-fg-dim leading-relaxed">
                        {(e.imports || []).slice(0, 4).join(', ') || <i className="text-fg-faint">—</i>}
                      </span>
                    </td>
                    <td className="px-3 py-2 hidden lg:table-cell">
                      <span className="text-[11px] font-mono text-fg-dim leading-relaxed">
                        {(e.importedBy || []).slice(0, 4).join(', ') || <i className="text-fg-faint">—</i>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {filtered.length > 200 && (
            <p className="px-3 py-2 text-[10px] text-fg-dim italic">+ {filtered.length - 200} more — keep typing to filter</p>
          )}
        </div>

        {selectedEntry && (
          <div className="w-72 shrink-0 hidden md:block overflow-y-auto bg-panel rounded-xl border border-border-soft p-3">
            <p className="text-[10px] uppercase tracking-wider text-fg-dim font-bold mb-1.5">File details</p>
            <p className="text-[11px] font-mono text-fg-subtle break-all mb-2">{selectedEntry.path}</p>
            <div className="space-y-2">
              <div>
                <p className="text-[10px] text-fg-dim font-semibold flex items-center gap-1"><Layers size={10} /> Exports</p>
                <p className="text-[11px] font-mono text-fg-muted leading-relaxed">
                  {(selectedEntry.signatures || []).join(', ') || <i className="text-fg-faint">none detected</i>}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-fg-dim font-semibold">Imports</p>
                <p className="text-[11px] font-mono text-fg-muted leading-relaxed">
                  {(selectedEntry.imports || []).join(', ') || <i className="text-fg-faint">none</i>}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-fg-dim font-semibold">Used by</p>
                <p className="text-[11px] font-mono text-fg-muted leading-relaxed">
                  {(selectedEntry.importedBy || []).join(', ') || <i className="text-fg-faint">nothing imports this file</i>}
                </p>
              </div>
              {(selectedEntry.symbols || []).length > 0 && (
                <div>
                  <p className="text-[10px] text-fg-dim font-semibold">Symbols</p>
                  <p className="text-[11px] font-mono text-fg-muted leading-relaxed">
                    {(selectedEntry.symbols || []).slice(0, 12).map((s) => `${s.name} (line ${s.line})`).join(', ')}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}