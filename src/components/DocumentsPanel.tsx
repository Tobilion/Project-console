import { useCallback, useState } from 'react';
import { BookOpen, Search, FileText, File as FileIcon, StickyNote, RefreshCw, Sparkles } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';

// Phase 16 (UPGRADE-ROADMAP.md, 2026-08-12): the Documents panel — Spotlight/Notion-style
// search: prominent search field, results as a list with a source-type icon (PDF/Word/text),
// snippet, and muted file path. Results come from the SAME persisted code-index store the
// chat answer uses (GET /api/projects/:id/documents → searchProjectCode/performSearch) —
// retrieval-only, with file citations. Index status (unavailable/indexing/ready) mirrors
// project.code.search's states.
//
// Phase 16 audit: an AI-mode "ask" box (visible only when AI mode is on) posts to
// /documents/ask — the server retrieves the top chunks and synthesizes an answer, which
// renders ABOVE the raw chunk list (the citations are always visible underneath).

interface DocResult {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

interface DocumentsPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
  /** Phase 16 audit: gates the AI ask box — only shown when AI mode is on. */
  aiEnabled?: boolean;
}

function fileIcon(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) return <FileText size={14} className="text-accent-red/80 shrink-0" />;
  if (lower.endsWith('.docx')) return <FileText size={14} className="text-accent-blue/80 shrink-0" />;
  if (lower.endsWith('.md')) return <StickyNote size={14} className="text-accent-teal/80 shrink-0" />;
  return <FileIcon size={14} className="text-fg-dim shrink-0" />;
}

export function DocumentsPanel({ project, onSendMessage, aiEnabled }: DocumentsPanelProps) {
  const [query, setQuery] = useState('');
  const [askQuery, setAskQuery] = useState('');
  const [results, setResults] = useState<DocResult[]>([]);
  const [synthesis, setSynthesis] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'indexing' | 'ready' | 'unavailable' | 'error'>('idle');
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [asking, setAsking] = useState(false);

  const search = useCallback(async (q: string) => {
    if (!project?.id || !q.trim()) return;
    setLoading(true);
    setSearched(true);
    const data = await apiFetchJson<{ status: string; results: DocResult[] }>(
      `/api/projects/${encodeURIComponent(project.id)}/documents?q=${encodeURIComponent(q.trim())}`
    );
    setLoading(false);
    if (!data) { setStatus('error'); return; }
    setStatus(data.status as typeof status);
    setResults(data.results || []);
  }, [project?.id]);

  const runSearch = () => { search(query); };

  // Phase 16 audit: AI ask — retrieval + synthesis from /documents/ask; the raw chunk list is
  // always returned alongside the synthesis so citations stay visible (and are the fallback
  // when the model is unreachable).
  const runAsk = async () => {
    if (!project?.id || !askQuery.trim()) return;
    setAsking(true);
    setSearched(true);
    const data = await apiFetchJson<{ status: string; results: DocResult[]; synthesis: string | null }>(
      `/api/projects/${encodeURIComponent(project.id)}/documents/ask?q=${encodeURIComponent(askQuery.trim())}`
    );
    setAsking(false);
    if (!data) { setStatus('error'); return; }
    setStatus(data.status as typeof status);
    setResults(data.results || []);
    setSynthesis(data.synthesis);
  };

  const inputCls = 'text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent/50';

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-scrim-faint rounded-lg text-accent">
              <BookOpen size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Documents</h2>
            {project && <span className="text-xs text-fg-dim font-normal normal-case">— {project.name}</span>}
          </div>
        </div>

        {!project ? (
          <div className="text-sm text-fg-muted bg-panel rounded-xl border border-border-soft p-6">
            Select a project to search its documents.
          </div>
        ) : (
          <>
            {/* Search field */}
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                  placeholder="Search PDFs, Word docs and notes… (e.g. pricing, the trip, quarterly goals)"
                  className={cn(inputCls, 'w-full pl-8')}
                />
              </div>
              <button onClick={runSearch} disabled={!query.trim()} className="text-xs font-medium rounded-lg px-3 py-2 bg-accent/90 text-white hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                Search
              </button>
            </div>

            {/* AI-mode ask box — only visible when AI mode is on */}
            {aiEnabled && (
              <div className="mb-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-accent mb-1.5 uppercase tracking-wider">
                  <Sparkles size={12} /> Ask (AI mode on)
                </div>
                <div className="flex gap-2">
                  <input
                    value={askQuery}
                    onChange={(e) => setAskQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') runAsk(); }}
                    placeholder="Ask a question about these documents…"
                    className={cn(inputCls, 'flex-1')}
                  />
                  <button onClick={runAsk} disabled={!askQuery.trim() || asking} className="text-xs font-medium rounded-lg px-3 py-2 bg-accent/90 text-white hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    {asking ? 'Asking…' : 'Ask'}
                  </button>
                </div>
                {synthesis && (
                  <div className="mt-2 text-xs leading-relaxed text-fg-strong whitespace-pre-wrap">{synthesis}</div>
                )}
              </div>
            )}

            {/* Index status */}
            {status === 'unavailable' && (
              <div className="text-xs text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-3 mb-3">
                The embedding model failed to load this session — try again after a restart.
              </div>
            )}
            {status === 'indexing' && searched && (
              <div className="flex items-center gap-2 text-xs text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-3 mb-3">
                <RefreshCw size={13} className="animate-spin" /> Indexing documents in the background (first search builds the index) — results appear when ready.
              </div>
            )}
            {status === 'error' && (
              <div className="text-xs text-accent-red bg-scrim-faint border border-border-soft rounded-lg p-3 mb-3">
                Search failed — is the server up?
              </div>
            )}

            {/* Results */}
            {searched && status === 'ready' && results.length === 0 && (
              <div className="text-xs text-fg-dim italic text-center py-8">No documents match "{query}".</div>
            )}
            {results.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] text-fg-dim">{results.length} match{results.length === 1 ? '' : 'es'} — retrieved from the index, not generated.</p>
                {results.map((r, i) => (
                  <div key={i} className="bg-panel border border-border-soft rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      {fileIcon(r.filePath)}
                      <span className="text-xs font-mono text-fg-strong truncate">{r.filePath}</span>
                      <span className="text-[10px] text-fg-faint shrink-0">{r.startLine}{r.endLine && r.endLine !== r.startLine ? `-${r.endLine}` : ''}</span>
                    </div>
                    <p className="text-[11px] text-fg-muted leading-relaxed whitespace-pre-wrap max-h-24 overflow-y-auto">{r.snippet}</p>
                  </div>
                ))}
                <button
                  onClick={() => onSendMessage(`search my documents for ${query.trim()}`)}
                  className="text-[11px] text-accent hover:underline"
                >
                  Run this search in chat instead
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
