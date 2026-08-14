import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Search, X, TerminalSquare, LayoutGrid } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';

// Phase 10 (UPGRADE-ROADMAP.md, 2026-08-12): the Command Reference tab — Stripe/GitHub-CLI
// docs style: left category sidebar, searchable command list on the right, each entry showing
// the trigger phrase + its underlying shell command in a code block with a copy button. Pure
// read of GET /api/command-docs (the catalog stays server-side; nothing duplicated here).
// 2026-08-13: the endpoint now also returns the auto-generated intent layer (every chat
// intent the matcher understands), so the reference covers ALL possible commands, not just
// the curated how-do-I entries.

interface CommandDoc {
  keywords: string[];
  command: string;
  shell?: string;
  phrases?: string[];
  explain: string;
}

interface CatalogIntent {
  intentId: string;
  command: string;
  phrases: string[];
  opensPanel: string | null;
  group: string;
  explain: string;
}

interface RefEntry {
  key: string;
  command: string;
  shell?: string;
  explain: string;
  phrases?: string[];
  opensPanel?: string | null;
  source: 'curated' | 'intent';
}

// Lightweight category assignment from the entry's keywords — mirrors the README's reference
// table groupings without duplicating the catalog content. Curated entries only; the intent
// layer carries its own server-side group label.
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
  const [intents, setIntents] = useState<CatalogIntent[]>([]);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetchJson<{ commands: CommandDoc[]; intents: CatalogIntent[] }>('/api/command-docs').then((data) => {
      setLoading(false);
      if (data?.commands) setCommands(data.commands);
      if (data?.intents) setIntents(data.intents);
      if (!data?.commands) setError('Could not load the command reference.');
    });
  }, []);

  const categories = useMemo(() => {
    const map = new Map<string, RefEntry[]>();
    for (const c of commands) {
      const cat = categorize(c);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push({ key: `cur-${c.command}`, command: c.command, shell: c.shell, explain: c.explain, phrases: c.phrases, source: 'curated' });
    }
    for (const i of intents) {
      if (!map.has(i.group)) map.set(i.group, []);
      map.get(i.group)!.push({ key: `int-${i.intentId}`, command: i.command, explain: i.explain, phrases: i.phrases, opensPanel: i.opensPanel, source: 'intent' });
    }
    return [...map.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [commands, intents]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return categories
      .filter((c) => !activeCategory || c.label === activeCategory)
      .map((c) => ({
        ...c,
        items: q
          ? c.items.filter((i) => `${i.command} ${i.phrases?.join(' ') ?? ''} ${i.explain}`.toLowerCase().includes(q))
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
            <div className="p-1.5 rounded-lg bg-accent-teal/15 text-accent-teal">
              <BookOpen size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Command Reference</h2>
            <span className="text-xs text-fg-dim font-normal normal-case">— {commands.length + intents.length} documented commands</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors" title="Close">
            <X size={16} />
          </button>
        </div>

        {error && <p className="text-xs text-accent-red mb-3">{error}</p>}

        <div className="flex gap-4 flex-1 min-h-0">
          {/* Left category rail — 220px, --overlay */}
          <aside className="w-[220px] shrink-0 bg-overlay border-r border-border-faint p-3 overflow-y-auto">
            <button
              onClick={() => setActiveCategory(null)}
              className={cn('w-full text-left px-2.5 py-1.5 text-xs rounded-lg transition-colors mb-0.5', !activeCategory ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-muted hover:text-fg-strong hover:bg-panel-strong/60')}
            >
              All commands
            </button>
            {categories.map((c) => (
              <button
                key={c.label}
                onClick={() => setActiveCategory(c.label)}
                className={cn('w-full text-left px-2.5 py-1.5 text-xs rounded-lg transition-colors mb-0.5', activeCategory === c.label ? 'bg-accent-blue/15 text-accent-blue font-semibold' : 'text-fg-muted hover:text-fg-strong hover:bg-panel-strong/60')}
              >
                {c.label}
                <span className="text-fg-dim ml-1">({c.items.length})</span>
              </button>
            ))}
          </aside>

          {/* Right searchable list on --background */}
          <div className="flex-1 min-w-0 bg-background flex flex-col">
            <div className="flex items-center gap-2 mb-3 shrink-0">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search commands…"
                  className="w-full pl-8 pr-3 py-2 text-xs bg-panel-strong border border-border-soft rounded-lg text-fg-strong focus:outline-none focus:border-accent-blue/50"
                />
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
              {loading ? (
                <p className="text-xs text-fg-dim italic py-8 text-center">Loading commands…</p>
              ) : filtered.length === 0 && (
                <p className="text-xs text-fg-dim italic py-8 text-center">No commands match "{query}".</p>
              )}
              {filtered.map((cat) => (
                <div key={cat.label}>
                  <h3 className="text-[11px] uppercase tracking-wider text-fg-dim font-bold mb-1.5">{cat.label}</h3>
                  <div className="space-y-2">
                    {cat.items.map((entry) => (
                      <div key={entry.key} className="bg-panel border border-border-soft rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <div className="text-xs font-semibold text-fg-strong">“{entry.command}”</div>
                          {entry.source === 'intent' && (
                            <span className="text-caption uppercase tracking-wider text-accent-teal bg-accent-teal/10 border border-accent-teal/20 rounded-full px-1.5 py-0.5 font-mono flex-shrink-0">
                              {entry.opensPanel ? 'opens panel' : 'chat intent'}
                            </span>
                          )}
                          {entry.opensPanel && (
                            <span className="flex items-center gap-1 text-caption uppercase tracking-wider text-accent-blue bg-accent-blue/10 border border-accent-blue/20 rounded-full px-1.5 py-0.5 font-mono flex-shrink-0">
                              <LayoutGrid size={9} /> {entry.opensPanel}
                            </span>
                          )}
                        </div>
                        {entry.shell && (
                          <div className="relative group">
                            <pre className="bg-background border border-border-faint rounded-lg px-3 py-2 text-[11px] font-mono text-fg-subtle overflow-x-auto">{entry.shell}</pre>
                            <button
                              onClick={() => copy(entry.shell!)}
                              className="absolute top-1.5 right-1.5 p-1 text-fg-dim hover:text-accent-blue rounded bg-background border border-border-faint transition-colors"
                              title="Copy command"
                            >
                              <TerminalSquare size={12} />
                            </button>
                          </div>
                        )}
                        <p className="text-[11px] text-fg-muted mt-1.5 leading-relaxed">{entry.explain}</p>
                        {entry.phrases?.length ? (
                          <p className="text-[10px] text-fg-dim mt-1">Try saying: {entry.phrases.map((p) => `“${p}”`).join(' ')}</p>
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
