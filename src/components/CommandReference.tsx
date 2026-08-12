import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Search, X, TerminalSquare } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';

// Phase 10 (UPGRADE-ROADMAP.md, 2026-08-12): the Command Reference tab — Stripe/GitHub-CLI
// docs style: left category sidebar, searchable command list on the right, each entry showing
// the trigger phrase + its underlying shell command in a code block with a copy button. Pure
// read of GET /api/command-docs (the catalog stays server-side; nothing duplicated here).

interface CommandDoc {
  keywords: string[];
  command: string;
  shell?: string;
  phrases?: string[];
  explain: string;
}

// Lightweight category assignment from the entry's keywords — mirrors the README's reference
// table groupings without duplicating the catalog content.
const CATEGORY_RULES: [string, RegExp][] = [
  ['Run & dev servers', /run the (site|project|tests|build|dev server)|serve the|stop the server|port|link|url|auto-start/i],
  ['Git', /git|push|commit|deploy|branch|checkpoint|stale/i],
  ['Files & editor', /file|open in|find|tidy|duplicate|undo|revert|backup|zip|vs code|github page/i],
  ['Schedules & automation', /schedule|notify|reminder|watch/i],
  ['Calculator & utilities', /calculate|convert|tip|tax|percent|time|date/i],
  ['Clipboard & snippets', /clipboard|snippet/i],
  ['Notes & memory', /note|remember|memory/i],
  ['CSV & spreadsheets', /csv|spreadsheet|sum column|average/i],
  ['AI & settings', /ai|model|ollama|theme|profile/i],
  ['Diagnostics & learning', /learning|telemetry|collision|distillation|health|coverage|bundle|history/i],
];

function categorize(entry: CommandDoc): string {
  const hay = [...entry.keywords, entry.command, entry.explain].join(' ').toLowerCase();
  for (const [label, re] of CATEGORY_RULES) {
    if (re.test(hay)) return label;
  }
  return 'Other';
}

interface CommandReferenceProps {
  onClose: () => void;
}

export function CommandReference({ onClose }: CommandReferenceProps) {
  const [commands, setCommands] = useState<CommandDoc[]>([]);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetchJson<{ commands: CommandDoc[] }>('/api/command-docs').then((data) => {
      if (data?.commands) setCommands(data.commands);
      else setError('Could not load the command reference.');
    });
  }, []);

  const categories = useMemo(() => {
    const map = new Map<string, CommandDoc[]>();
    for (const c of commands) {
      const cat = categorize(c);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(c);
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }));
  }, [commands]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return categories
      .filter((c) => !activeCategory || c.label === activeCategory)
      .map((c) => ({
        ...c,
        items: q
          ? c.items.filter((i) => `${i.command} ${i.keywords.join(' ')} ${i.explain}`.toLowerCase().includes(q))
          : c.items,
      }))
      .filter((c) => c.items.length > 0);
  }, [categories, query, activeCategory]);

  const copy = (shell: string) => {
    try {
      navigator.clipboard?.writeText(shell);
    } catch { /* best-effort copy */ }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto h-full flex flex-col">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-scrim-faint rounded-lg text-accent">
              <BookOpen size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Command Reference</h2>
            <span className="text-xs text-fg-dim font-normal normal-case">— {commands.length} documented commands</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-md transition-colors" title="Close">
            <X size={16} />
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        <div className="flex gap-4 flex-1 min-h-0">
          {/* Left category sidebar */}
          <aside className="w-44 shrink-0 border border-border-soft rounded-xl bg-panel p-2 overflow-y-auto">
            <button
              onClick={() => setActiveCategory(null)}
              className={cn('w-full text-left px-2.5 py-1.5 text-xs rounded-lg transition-colors mb-0.5', !activeCategory ? 'bg-accent/15 text-accent font-semibold' : 'text-fg-muted hover:text-fg-strong')}
            >
              All commands
            </button>
            {categories.map((c) => (
              <button
                key={c.label}
                onClick={() => setActiveCategory(c.label)}
                className={cn('w-full text-left px-2.5 py-1.5 text-xs rounded-lg transition-colors mb-0.5', activeCategory === c.label ? 'bg-accent/15 text-accent font-semibold' : 'text-fg-muted hover:text-fg-strong')}
              >
                {c.label}
                <span className="text-fg-faint ml-1">({c.items.length})</span>
              </button>
            ))}
          </aside>

          {/* Right searchable list */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-2 mb-3 shrink-0">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search commands…"
                  className="w-full pl-8 pr-3 py-2 text-xs bg-panel-strong border border-border-soft rounded-lg text-fg-strong focus:outline-none focus:border-accent/50"
                />
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
              {filtered.length === 0 && (
                <p className="text-xs text-fg-dim italic py-8 text-center">No commands match "{query}".</p>
              )}
              {filtered.map((cat) => (
                <div key={cat.label}>
                  <h3 className="text-[11px] uppercase tracking-wider text-fg-dim font-bold mb-1.5">{cat.label}</h3>
                  <div className="space-y-2">
                    {cat.items.map((entry) => (
                      <div key={entry.command} className="bg-panel border border-border-soft rounded-lg p-3">
                        <div className="text-xs font-semibold text-fg-strong mb-1">“{entry.command}”</div>
                        {entry.shell && (
                          <div className="relative group">
                            <pre className="bg-scrim rounded-md px-3 py-2 text-[11px] font-mono text-fg-subtle overflow-x-auto">{entry.shell}</pre>
                            <button
                              onClick={() => copy(entry.shell)}
                              className="absolute top-1.5 right-1.5 p-1 text-fg-dim hover:text-fg-strong rounded bg-scrim opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Copy command"
                            >
                              <TerminalSquare size={12} />
                            </button>
                          </div>
                        )}
                        <p className="text-[11px] text-fg-muted mt-1.5 leading-relaxed">{entry.explain}</p>
                        {entry.phrases?.length ? (
                          <p className="text-[10px] text-fg-faint mt-1">Try saying: {entry.phrases.map((p) => `“${p}”`).join(' ')}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
