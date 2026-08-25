import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Project, ChatSession, ToolPanelDef } from '../types';
import { apiFetchJson } from '../utils/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  Search, Home, LayoutDashboard, Plus, PanelLeft, FolderGit2, Terminal as TerminalIcon,
  Clock, Flame, BookOpen, LayoutGrid, Settings, Moon, Sun, Maximize2, Bot, FileDown,
  MessagesSquare, PanelBottom, ArrowLeftRight, History, Sparkles,
} from 'lucide-react';
import { EmptyState } from './ui/EmptyState';

interface DeckItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string[];
  icon: React.ReactNode;
  run: () => void;
  /** Round-6 audit (2026-08-24): file-ish metadata for the preview pane's metadata panel —
   *  name/location/type/size/dates. Only items with real file-ish facts carry it; a made-up
   *  size would be worse than an empty line. */
  meta?: { type: string; location?: string; size?: string; modified?: string };
}

interface CatalogCommand {
  command: string;
  shell?: string;
  keywords: string[];
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

interface CommandDeckProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  activeProject: Project | null;
  sessions: ChatSession[];
  onSelectProject: (p: Project) => void;
  onSwitchSession: (sessionId: string) => void;
  onDirectCommand: (cmd: string) => void;
  onSendMessage: (text: string) => void;
  onHome: () => void;
  onToggleDashboard: () => void;
  onOpenCommandRef: () => void;
  onNewChat: () => void;
  sidebarCollapsed: boolean;
  onSetSidebarCollapsed: (v: boolean) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenProfile: () => void;
  chatFullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenTools: () => void;
  onOpenPanel: (panelId: string) => void;
  toolPanels: ToolPanelDef[];
  workspaceTab: 'dev' | 'general';
  onSetWorkspaceTab: (mode: 'dev' | 'general') => void;
  aiEnabled: boolean;
  onToggleAI: () => void;
  onExportMarkdown: () => void;
  onExportJson: () => void;
  onExportPdf: () => void;
  onExportProjectChatLog: () => void;
  dockExpanded: boolean;
  onToggleDock: () => void;
  dockTab: 'logs' | 'projects' | 'history';
  onSetDockTab: (tab: 'logs' | 'projects' | 'history') => void;
  showToolHistory: boolean;
  onToggleToolHistory: () => void;
  /** Audit 2026-08-17: Ctrl+K path to the tour picker (the help/walkthrough surface). */
  onOpenTourPicker: () => void;
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

// Classic Levenshtein for the palette's typo tolerance — small (labels are short) and only
// ever compared against whole words, so the O(n*m) cost is trivial at this scale.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Tokenized relevance scoring (2026-08-13): every whitespace-separated query token must be
// found somewhere in the item (label/hint/keywords/group); the score rewards label hits over
// hint over keywords, so "git push" ranks the actual push commands above unrelated hits.
// 2026-08-24: typo tolerance — a token that matches NO field by substring still matches if it
// is within edit distance 1 (short tokens) / 2 (long tokens) of a field WORD, at a reduced
// score, so "explrer" finds "folder explorer" instead of returning zero results. Plus
// multi-word concatenation ("gitstatus" == "git status", Raycast-style) for tokens >= 6 chars.
function matchScore(it: DeckItem, q: string): number {
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const label = it.label.toLowerCase();
  const hint = (it.hint ?? '').toLowerCase();
  const keys = (it.keywords ?? []).join(' ').toLowerCase();
  const group = it.group.toLowerCase();
  const fuzzyFields: Array<[string, number]> = [
    [label, 6], [hint, 4], [keys, 3], [group, 2],
  ];
  // Space-stripped concatenations for the "gitstatus" -> "git status" class.
  const concatFields: Array<[string, number]> = [
    [label.replace(/\s+/g, ''), 7], [hint.replace(/\s+/g, ''), 4], [keys.replace(/\s+/g, ''), 3],
  ];
  let score = 0;
  for (const token of tokens) {
    let found = false;
    if (label.includes(token)) { score += 30; found = true; }
    if (hint.includes(token)) { score += 20; found = true; }
    if (keys.includes(token)) { score += 15; found = true; }
    if (group.includes(token)) { score += 10; found = true; }
    if (!found && token.length >= 3) {
      const maxDist = token.length >= 5 ? 2 : 1;
      for (const [field, fuzzyScore] of fuzzyFields) {
        if (field.split(/\s+/).some((word) => editDistance(word, token) <= maxDist)) {
          score += fuzzyScore;
          found = true;
          break;
        }
      }
    }
    if (!found && token.length >= 6) {
      for (const [field, concatScore] of concatFields) {
        if (field.includes(token) || editDistance(field, token) <= 1) {
          score += concatScore;
          found = true;
          break;
        }
      }
    }
    if (!found) return -1;
  }
  return score;
}

// Cap on the un-query "All" section — browsing 200+ items is noise; the footer says to type.
const BROWSE_CAP = 80;
const RESULT_CAP = 100;

export const CommandDeck = ({
  open, onClose, projects, activeProject, sessions, onSelectProject, onSwitchSession,
  onDirectCommand, onSendMessage, onHome, onToggleDashboard, onOpenCommandRef, onNewChat,
  sidebarCollapsed, onSetSidebarCollapsed, theme, onToggleTheme, onOpenProfile,
  chatFullscreen, onToggleFullscreen, onOpenTools, onOpenPanel, toolPanels, workspaceTab,
  onSetWorkspaceTab, aiEnabled, onToggleAI, onExportMarkdown, onExportJson, onExportPdf,
  onExportProjectChatLog, dockExpanded, onToggleDock, dockTab, onSetDockTab,
  showToolHistory, onToggleToolHistory, onOpenTourPicker,
}: CommandDeckProps) => {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [usage, setUsage] = useState<Record<string, UsageEntry>>(() => readUsage());
  // The command catalog (curated docs + every chat intent) is fetched once and cached — the
  // payload is small and the palette is the main consumer, alongside the Command Reference tab.
  const [catalog, setCatalog] = useState<{ commands: CatalogCommand[]; intents: CatalogIntent[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open || catalog) return;
    apiFetchJson<{ commands: CatalogCommand[]; intents: CatalogIntent[] }>('/api/command-docs')
      .then((data) => { if (data) setCatalog(data); })
      .catch(() => {});
  }, [open, catalog]);

  const items = useMemo<DeckItem[]>(() => {
    const list: DeckItem[] = [];

    list.push({ id: 'nav-home', group: 'Navigation', label: 'Home', icon: <Home size={14} />, run: onHome });
    list.push({ id: 'nav-dashboard', group: 'Navigation', label: 'Dashboard', icon: <LayoutDashboard size={14} />, run: onToggleDashboard });
    list.push({ id: 'nav-commandref', group: 'Navigation', label: 'Command Reference', hint: 'book icon in the header', icon: <BookOpen size={14} />, run: onOpenCommandRef });
    list.push({ id: 'nav-tour', group: 'Navigation', label: 'Take a tour / Help', keywords: ['help', 'tour', 'walkthrough', 'guide', 'tutorial'], icon: <Sparkles size={14} />, run: onOpenTourPicker });
    list.push({ id: 'nav-newchat', group: 'Navigation', label: 'New Chat', icon: <Plus size={14} />, run: onNewChat });
    list.push({ id: 'nav-fullscreen', group: 'Navigation', label: chatFullscreen ? 'Exit fullscreen chat' : 'Fullscreen chat', icon: <Maximize2 size={14} />, run: onToggleFullscreen });
    list.push({ id: 'nav-sidebar', group: 'Navigation', label: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar', icon: <PanelLeft size={14} />, run: () => onSetSidebarCollapsed(!sidebarCollapsed) });

    list.push({ id: 'act-theme', group: 'Actions', label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', keywords: ['dark', 'light', 'theme'], icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />, run: onToggleTheme });
    list.push({ id: 'act-profile', group: 'Actions', label: 'Open profile & settings', keywords: ['settings', 'gear', 'profile'], icon: <Settings size={14} />, run: onOpenProfile });
    list.push({ id: 'act-ai', group: 'Actions', label: aiEnabled ? 'Turn AI mode off' : 'Turn AI mode on', keywords: ['ollama', 'model', 'assistant'], icon: <Bot size={14} />, run: onToggleAI });
    list.push({ id: 'act-workspace', group: 'Actions', label: workspaceTab === 'dev' ? 'Switch to General workspace' : 'Switch to Developer workspace', keywords: ['workspace', 'mode', 'developer', 'general'], icon: <ArrowLeftRight size={14} />, run: () => onSetWorkspaceTab(workspaceTab === 'dev' ? 'general' : 'dev') });
    list.push({ id: 'act-dock', group: 'Actions', label: dockExpanded ? 'Collapse process dock' : 'Expand process dock', keywords: ['processes', 'dock', 'logs'], icon: <PanelBottom size={14} />, run: onToggleDock });
    list.push({ id: 'act-dock-logs', group: 'Actions', label: 'Process dock: show logs', icon: <TerminalIcon size={14} />, run: () => { if (!dockExpanded) onToggleDock(); onSetDockTab('logs'); } });
    list.push({ id: 'act-dock-projects', group: 'Actions', label: 'Process dock: show projects', keywords: ['servers', 'running'], icon: <FolderGit2 size={14} />, run: () => { if (!dockExpanded) onToggleDock(); onSetDockTab('projects'); } });
    list.push({ id: 'act-dock-history', group: 'Actions', label: 'Process dock: show action history', keywords: ['revert', 'actions'], icon: <History size={14} />, run: () => { if (!dockExpanded) onToggleDock(); onSetDockTab('history'); } });
    list.push({ id: 'act-toolhistory', group: 'Actions', label: showToolHistory ? 'Hide tool history panel' : 'Show tool history panel', keywords: ['ai', 'tools', 'calls'], icon: <History size={14} />, run: onToggleToolHistory });

    // Session exports need a project+session context — hidden otherwise (the handlers
    // themselves also degrade gracefully, but a dead item in the palette is worse).
    if (activeProject) {
      list.push({ id: 'act-export-md', group: 'Actions', label: 'Export chat as Markdown', keywords: ['download', 'export'], icon: <FileDown size={14} />, run: onExportMarkdown });
      list.push({ id: 'act-export-json', group: 'Actions', label: 'Export chat as JSON', keywords: ['download', 'export'], icon: <FileDown size={14} />, run: onExportJson });
      list.push({ id: 'act-export-pdf', group: 'Actions', label: 'Export chat as PDF', keywords: ['download', 'export'], icon: <FileDown size={14} />, run: onExportPdf });
      list.push({ id: 'act-export-log', group: 'Actions', label: 'Download project chat log', keywords: ['download', 'export', 'history'], icon: <FileDown size={14} />, run: onExportProjectChatLog });
    }

    list.push({ id: 'tools-grid', group: 'Tools', label: 'Open Tools grid', keywords: ['panels', 'utilities'], icon: <LayoutGrid size={14} />, run: onOpenTools });
    toolPanels.forEach((p) => {
      // Phase T2 fix: merge the panel's own search terms (e.g. "file explorer" for the
      // Folder Explorer) with the id-derived ones — the palette must match how users
      // actually name the panel, not just its registry id.
      list.push({ id: `tools-${p.id}`, group: 'Tools', label: `Open ${p.name}`, hint: p.chatHint, keywords: ['panel', 'tool', p.id.replace(/-/g, ' '), ...(p.keywords || [])], icon: <LayoutGrid size={14} />, run: () => onOpenPanel(p.id) });
    });

    if (catalog) {
      // Defensive against a stale server still serving the pre-Phase-21 shape (`commands`
      // only, no `intents` layer) — the palette must render whatever the endpoint returns.
      (catalog.commands || []).forEach((c, i) => {
        list.push({
          id: `cmd-cat-${i}`, group: 'Commands', label: c.command, hint: c.shell || c.keywords?.[0],
          keywords: [...(c.keywords || []), ...(c.phrases || [])], icon: <TerminalIcon size={14} />,
          // The shell command IS this entry's file-ish "location" in the metadata panel.
          meta: { type: 'Command', location: c.shell || c.command },
          run: () => onSendMessage(c.command),
        });
      });
      (catalog.intents || []).forEach((c) => {
        list.push({
          id: `cmd-int-${c.intentId}`, group: 'Commands', label: c.command, hint: c.intentId,
          keywords: [...c.phrases, c.group], icon: <TerminalIcon size={14} />,
          // Panel-tagged intents jump straight to their panel (what the chat handler would do
          // anyway); everything else runs through the normal chat flow with its confirms.
          meta: { type: 'Intent', location: c.intentId },
          run: () => (c.opensPanel ? onOpenPanel(c.opensPanel) : onSendMessage(c.command)),
        });
      });
    }

    sessions.forEach((s) => {
      list.push({ id: `sess-${s.id}`, group: 'Sessions', label: s.title || 'Untitled chat', hint: s.projectName || 'chat session', icon: <MessagesSquare size={14} />, meta: { type: 'Chat session', location: s.projectName || s.workspacePath || 'General chat', modified: new Date(s.updatedAt).toLocaleString() }, run: () => onSwitchSession(s.id) });
    });

    projects.forEach((p) => {
      list.push({ id: `proj-${p.id}`, group: 'Projects', label: p.name, hint: p.path, icon: <FolderGit2 size={14} />, meta: { type: 'Project', location: p.path }, run: () => onSelectProject(p) });
    });

    return list;
  }, [projects, activeProject, sessions, catalog, toolPanels, onDirectCommand, onSendMessage, onSelectProject, onSwitchSession, onHome, onToggleDashboard, onOpenCommandRef, onNewChat, sidebarCollapsed, onSetSidebarCollapsed, theme, onToggleTheme, onOpenProfile, chatFullscreen, onToggleFullscreen, onOpenTools, onOpenPanel, workspaceTab, onSetWorkspaceTab, aiEnabled, onToggleAI, onExportMarkdown, onExportJson, onExportPdf, onExportProjectChatLog, dockExpanded, onToggleDock, dockTab, onSetDockTab, showToolHistory, onToggleToolHistory, onOpenTourPicker]);

  useEffect(() => { setQuery(''); setSel(0); }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return items;
    return items
      .map((it) => ({ it, score: matchScore(it, q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || (b.it.group === a.it.group ? 0 : a.it.group.localeCompare(b.it.group)))
      .map((x) => x.it);
  }, [items, q]);

  // Phase 11: when there's no query, split into Recent (used within the last 7 days, newest
  // first) / Frequent (top by count, excluding the recent list) / everything else — Raycast-
  // style. With a query, relevance scoring wins and usage only breaks ties.
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
    // Frequency WITH time decay (2026-08-24): raw count alone kept a heavily-used old command
    // at the top of Frequent forever. The sort key is now count / (1 + days since last use) —
    // a command used 20x a month ago ranks below one used 5x yesterday.
    const decayFreq = (id: string) => {
      const u = usage[id];
      if (!u) return 0;
      const days = (Date.now() - u.lastUsedAt) / (24 * 60 * 60 * 1000);
      return u.count / (1 + days);
    };
    const frequent = filtered.filter(it => usage[it.id] && !recentIds.has(it.id) && usage[it.id].count >= 2)
      .sort((a, b) => decayFreq(b.id) - decayFreq(a.id));
    const freqIds = new Set([...recentIds, ...frequent.map(f => f.id)]);
    const rest = filtered.filter(it => !freqIds.has(it.id));
    return { recent, frequent, rest };
  }, [filtered, usage, q]);

  const runSelected = () => {
    // The rendered list is capped (BROWSE_CAP/RESULT_CAP) while `filtered` is not — a
    // keyboard selection can never land past the visible items.
    if (sel >= visibleItems) return;
    const it = flatItems[sel];
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

  const sections: { key: string; label: string; icon?: React.ReactNode; items: DeckItem[] }[] = [];
  if (!q && ranked.recent.length > 0) sections.push({ key: 'recent', label: 'Recent', icon: <Clock size={10} />, items: ranked.recent });
  if (!q && ranked.frequent.length > 0) sections.push({ key: 'frequent', label: 'Frequent', icon: <Flame size={10} />, items: ranked.frequent });
  const cap = q ? RESULT_CAP : BROWSE_CAP;
  // Round-6 audit (2026-08-24): with a query the grouped header names it ("Results for 'x'",
  // Raycast-style) so it's obvious the section is scoped, not everything.
  sections.push({ key: 'all', label: q ? `Results for "${query.trim()}"` : 'All', items: ranked.rest.slice(0, cap) });
  const truncated = ranked.rest.length > cap;
  // The exact items rendered on screen, in render order (Recent -> Frequent -> Results, each
  // capped). runSelected must index THIS list — `filtered`/`ranked` order differs whenever
  // usage reorders items (a lower-relevance item used recently sorts first in Recent), so
  // indexing them ran a different action than the highlighted row (audit 2026-08-17).
  const flatItems: DeckItem[] = sections.flatMap((s) => s.items);
  const visibleItems = flatItems.length;

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
          className={`w-full flex items-center gap-2.5 px-2.5 h-11 rounded-lg text-left text-xs transition-colors ${sel === i ? 'bg-accent-blue text-white' : 'text-fg-subtle hover:bg-panel'}`}
        >
          <span className={sel === i ? 'text-white flex-shrink-0' : 'text-accent flex-shrink-0'}>{it.icon}</span>
          <span className="flex-1 truncate min-w-0">{it.label}</span>
          {/* Round-6 audit (2026-08-24): the row's right edge shows its CATEGORY (Raycast
              style), not the hint — the hint moved into the preview pane's metadata panel. */}
          <span className={`text-[10px] uppercase tracking-wider truncate max-w-[40%] flex-shrink-0 ${sel === i ? 'text-white/70' : 'text-fg-dim'}`}>{it.group}</span>
        </button>
      );
    }
  }
  if (truncated) {
    rendered.push(
      <div key="truncated-note" className="px-3 py-2 text-[10px] text-fg-dim italic text-center">
        + {ranked.rest.length - cap} more — keep typing to filter
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          onMouseDown={onClose}
        >
          <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="relative z-10 w-full max-w-[760px] mx-auto mt-24 bg-panel/90 backdrop-blur-xl border border-border-strong rounded-2xl shadow-modal overflow-hidden"
            onMouseDown={e => e.stopPropagation()}
          >
        <div className="flex items-center gap-3 px-4 h-12 border-b border-border-faint">
          <Search size={18} className="text-fg-dim flex-shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={e => { setQuery(e.target.value); setSel(0); }}
            onKeyDown={e => {
              if (e.key === 'Escape') { onClose(); return; }
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, visibleItems - 1)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); return; }
              if (e.key === 'Enter') { e.preventDefault(); runSelected(); }
            }}
            placeholder="Search commands, actions, panels, chats, projects…"
            className="bg-transparent outline-none flex-1 text-[15px] text-fg placeholder:text-fg-dim"
          />
          <kbd className="text-[10px] text-fg-dim border border-border-soft rounded px-1.5 py-0.5 font-mono flex-shrink-0">Esc</kbd>
        </div>
        <div className="flex max-h-80">
          <div ref={listRef} className="flex-1 overflow-y-auto p-2 border-r border-border-faint">
            {filtered.length === 0 ? (
              <EmptyState
                title={`No matches for "${query}"`}
                hint="Try a broader phrase, or press Esc and re-open with Ctrl+K."
                className="py-6"
              />
            ) : rendered}
          </div>
          {/* Instant preview pane (2026-08-24, Raycast-style): the highlighted item's full
              details render live as you arrow through — no Enter needed to inspect. The
              round-6 audit turned it into a proper metadata panel for file-ish results:
              name/location/type/size/dates when the item carries real facts. */}
          <div className="w-64 shrink-0 overflow-y-auto p-3 border-l border-border-faint hidden md:block">
            {flatItems[sel] ? (
              <>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-accent flex-shrink-0">{flatItems[sel].icon}</span>
                  <p className="text-[13px] font-semibold text-fg-strong leading-snug">{flatItems[sel].label}</p>
                </div>
                <p className="text-[10px] uppercase tracking-wider text-fg-dim font-bold mb-2">{flatItems[sel].group}</p>
                {flatItems[sel].meta && (
                  <dl className="space-y-1 mb-2">
                    {flatItems[sel].meta.type && (
                      <div className="flex items-start gap-2">
                        <dt className="text-[10px] uppercase tracking-wider text-fg-faint w-16 shrink-0 pt-px">Type</dt>
                        <dd className="text-[11px] text-fg-subtle min-w-0 break-words">{flatItems[sel].meta.type}</dd>
                      </div>
                    )}
                    {flatItems[sel].meta.location && (
                      <div className="flex items-start gap-2">
                        <dt className="text-[10px] uppercase tracking-wider text-fg-faint w-16 shrink-0 pt-px">Location</dt>
                        <dd className="text-[11px] font-mono text-fg-muted min-w-0 break-words">{flatItems[sel].meta.location}</dd>
                      </div>
                    )}
                    {flatItems[sel].meta.size && (
                      <div className="flex items-start gap-2">
                        <dt className="text-[10px] uppercase tracking-wider text-fg-faint w-16 shrink-0 pt-px">Size</dt>
                        <dd className="text-[11px] text-fg-muted min-w-0 break-words">{flatItems[sel].meta.size}</dd>
                      </div>
                    )}
                    {flatItems[sel].meta.modified && (
                      <div className="flex items-start gap-2">
                        <dt className="text-[10px] uppercase tracking-wider text-fg-faint w-16 shrink-0 pt-px">Modified</dt>
                        <dd className="text-[11px] text-fg-muted min-w-0 break-words">{flatItems[sel].meta.modified}</dd>
                      </div>
                    )}
                  </dl>
                )}
                {flatItems[sel].hint && (
                  <p className="text-[11px] font-mono text-fg-subtle bg-scrim-faint border border-border-faint rounded-lg px-2 py-1.5 mb-2 break-words">{flatItems[sel].hint}</p>
                )}
                {flatItems[sel].keywords && flatItems[sel].keywords.length > 0 && (
                  <p className="text-[10px] text-fg-dim leading-relaxed">
                    <span className="font-semibold text-fg-subtle">Keywords:</span>{' '}
                    {flatItems[sel].keywords.slice(0, 6).join(', ')}
                  </p>
                )}
                <p className="mt-3 text-[10px] text-fg-faint">Enter runs this · Esc closes</p>
              </>
            ) : (
              <p className="text-[11px] text-fg-dim italic">Select an item to preview it.</p>
            )}
          </div>
        </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
