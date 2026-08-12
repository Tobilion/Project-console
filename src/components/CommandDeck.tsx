import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Project } from '../types';
import { Search, Home, LayoutDashboard, Plus, PanelLeft, FolderGit2, Terminal as TerminalIcon, Clock, Flame } from 'lucide-react';

interface DeckItem {
  id: string;
  group: 'Navigation' | 'Commands' | 'Projects';
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

interface CommandDeckProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  activeProject: Project | null;
  onSelectProject: (p: Project) => void;
  onDirectCommand: (cmd: string) => void;
  onSendMessage: (text: string) => void;
  onHome: () => void;
  onToggleDashboard: () => void;
  onNewChat: () => void;
  sidebarCollapsed: boolean;
  onSetSidebarCollapsed: (v: boolean) => void;
}

// Phase 11 (UPGRADE-ROADMAP.md, 2026-08-12): recency/frequency ranking for the palette —
// Raycast/Spotlight behavior (Recent / Frequent groups above the flat list). Usage is tracked
// in a minimal per-browser localStorage map (item key -> { lastUsedAt, count }), the same
// inline-localStorage style as pinned projects / workspace tabs — this is UI-level ranking
// data for a UI surface, deliberately NOT a second server telemetry store (the server's
// intentTelemetry stays the confidence-model's data source; see the roadmap's step 1-2 note).
const DECK_USAGE_KEY = 'console.deckUsage';

interface UsageEntry { lastUsedAt: number; count: number; }

function readUsage(): Record<string, UsageEntry> {
  try {
    const raw = localStorage.getItem(DECK_USAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}

function writeUsage(usage: Record<string, UsageEntry>) {
  try {
    localStorage.setItem(DECK_USAGE_KEY, JSON.stringify(usage));
  } catch {}
}

export const CommandDeck = ({
  open, onClose, projects, activeProject, onSelectProject,
  onDirectCommand, onSendMessage, onHome, onToggleDashboard, onNewChat,
  sidebarCollapsed, onSetSidebarCollapsed,
}: CommandDeckProps) => {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [usage, setUsage] = useState<Record<string, UsageEntry>>(() => readUsage());
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<DeckItem[]>(() => {
    const list: DeckItem[] = [
      { id: 'nav-home', group: 'Navigation', label: 'Home', icon: <Home size={14} />, run: onHome },
      { id: 'nav-dashboard', group: 'Navigation', label: 'Dashboard', icon: <LayoutDashboard size={14} />, run: onToggleDashboard },
      { id: 'nav-newchat', group: 'Navigation', label: 'New Chat', icon: <Plus size={14} />, run: onNewChat },
      { id: 'nav-sidebar', group: 'Navigation', label: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar', icon: <PanelLeft size={14} />, run: () => onSetSidebarCollapsed(!sidebarCollapsed) },
    ];
    if (activeProject) {
      const seen = new Set<string>();
      (activeProject.config?.entries || []).forEach((entry, i) => {
        if (entry.type !== 'command' || !entry.action || seen.has(entry.action)) return;
        seen.add(entry.action);
        const hasParams = entry.action.includes('{');
        list.push({
          id: `cmd-${activeProject.id}-${i}`,
          group: 'Commands',
          label: entry.triggers?.[0] || entry.action,
          hint: hasParams ? `${entry.action} (asks for params)` : entry.action,
          icon: <TerminalIcon size={14} />,
          run: () => { if (hasParams) onSendMessage(entry.triggers?.[0] || entry.action); else onDirectCommand(entry.action); },
        });
      });
    }
    projects.forEach(p => {
      list.push({ id: `proj-${p.id}`, group: 'Projects', label: p.name, hint: p.path, icon: <FolderGit2 size={14} />, run: () => onSelectProject(p) });
    });
    return list;
  }, [projects, activeProject, onDirectCommand, onSendMessage, onSelectProject, onHome, onToggleDashboard, onNewChat, sidebarCollapsed, onSetSidebarCollapsed]);

  useEffect(() => { setQuery(''); setSel(0); }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(it => `${it.label} ${it.hint ?? ''} ${it.group}`.toLowerCase().includes(q))
    : items;

  // Phase 11: when there's no query, split into Recent (used within the last 7 days, newest
  // first) / Frequent (top by count, excluding the recent list) / everything else — Raycast-
  // style. With a query, relevance filtering wins and usage only breaks ties.
  const ranked = useMemo(() => {
    if (q) {
      const used = filtered.filter(it => usage[it.id]);
      const unused = filtered.filter(it => !usage[it.id]);
      return {
        recent: used.sort((a, b) => (usage[b.id]?.lastUsedAt || 0) - (usage[a.id]?.lastUsedAt || 0)),
        frequent: [],
        rest: unused,
      };
    }
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = filtered.filter(it => usage[it.id] && usage[it.id].lastUsedAt >= weekAgo)
      .sort((a, b) => (usage[b.id]?.lastUsedAt || 0) - (usage[a.id]?.lastUsedAt || 0));
    const recentIds = new Set(recent.map(r => r.id));
    const frequent = filtered.filter(it => usage[it.id] && !recentIds.has(it.id) && usage[it.id].count >= 2)
      .sort((a, b) => (usage[b.id]?.count || 0) - (usage[a.id]?.count || 0));
    const freqIds = new Set([...recentIds, ...frequent.map(f => f.id)]);
    const rest = filtered.filter(it => !freqIds.has(it.id));
    return { recent, frequent, rest };
  }, [filtered, usage, q]);

  const runSelected = () => {
    const it = filtered[sel];
    if (!it) return;
    onClose();
    // Record usage (recency + frequency) before running.
    setUsage(prev => {
      const next = { ...prev };
      const cur = next[it.id] || { lastUsedAt: 0, count: 0 };
      next[it.id] = { lastUsedAt: Date.now(), count: cur.count + 1 };
      writeUsage(next);
      return next;
    });
    it.run();
  };

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel, filtered.length]);

  if (!open) return null;

  const sections: { key: string; label: string; icon?: React.ReactNode; items: DeckItem[] }[] = [];
  if (!q && ranked.recent.length > 0) sections.push({ key: 'recent', label: 'Recent', icon: <Clock size={10} />, items: ranked.recent });
  if (!q && ranked.frequent.length > 0) sections.push({ key: 'frequent', label: 'Frequent', icon: <Flame size={10} />, items: ranked.frequent });
  if (ranked.rest.length > 0) sections.push({ key: 'all', label: q ? 'Results' : 'All', items: ranked.rest });

  let rendered: React.ReactNode[] = [];
  let flatIndex = -1;
  for (const section of sections) {
    rendered.push(
      <div key={`g-${section.key}`} className="px-2 pt-2 pb-1 text-[10px] tracking-[0.2em] uppercase text-fg-dim font-bold flex items-center gap-1">
        {section.icon}{section.label}
      </div>
    );
    for (const it of section.items) {
      flatIndex++;
      const i = flatIndex;
      rendered.push(
        <button
          key={it.id}
          data-sel={sel === i ? 'true' : undefined}
          onMouseEnter={() => setSel(i)}
          onClick={runSelected}
          className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left text-xs transition-colors ${sel === i ? 'bg-panel-strong text-fg-strong' : 'text-fg-subtle hover:bg-panel'}`}
        >
          <span className="text-[#00d4a3] flex-shrink-0">{it.icon}</span>
          <span className="flex-1 truncate min-w-0">{it.label}</span>
          {it.hint && <span className="text-[10px] text-fg-dim font-mono truncate max-w-[45%] flex-shrink-0">{it.hint}</span>}
        </button>
      );
    }
  }

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg mx-auto mt-24 bg-overlay border border-border-soft rounded-2xl shadow-2xl overflow-hidden" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-faint">
          <Search size={16} className="text-fg-dim flex-shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={e => { setQuery(e.target.value); setSel(0); }}
            onKeyDown={e => {
              if (e.key === 'Escape') { onClose(); return; }
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); return; }
              if (e.key === 'Enter') { e.preventDefault(); runSelected(); }
            }}
            placeholder="Search commands, projects, actions…"
            className="bg-transparent outline-none flex-1 text-sm text-fg placeholder:text-fg-faint"
          />
          <kbd className="text-[10px] text-fg-dim border border-border-soft rounded px-1.5 py-0.5 font-mono flex-shrink-0">Esc</kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-xs text-fg-dim italic text-center">No matches for "{query}"</div>
          ) : rendered}
        </div>
      </div>
    </div>
  );
};
