import { lazy, Suspense } from 'react';
import { Calculator, FileText, ListChecks, FolderSearch, FolderOpen, StickyNote, Table as TableIcon, ClipboardCopy, Archive, Bell, BookOpen, Store, LayoutGrid, ArrowLeft } from 'lucide-react';
import type { ToolPanelDef, Project } from '../types';

// Phase 6 (2026-08-17): panels are one-at-a-time views — ideal code-split points. React.lazy
// defers each panel's chunk (and its heavy deps: pdf-lib/pdf-parse, jspdf, mammoth, ...)
// until the panel actually opens, keeping the main bundle lean. The static grid shell
// renders instantly; only the opened panel suspends, behind a small loading fallback.
const CalculatorPanel = lazy(() => import('./CalculatorPanel').then((m) => ({ default: m.CalculatorPanel })));
const PdfToolsPanel = lazy(() => import('./PdfToolsPanel').then((m) => ({ default: m.PdfToolsPanel })));
const RemindersPanel = lazy(() => import('./RemindersPanel').then((m) => ({ default: m.RemindersPanel })));
const FileToolsPanel = lazy(() => import('./FileToolsPanel').then((m) => ({ default: m.FileToolsPanel })));
const FolderExplorerPanel = lazy(() => import('./FolderExplorerPanel').then((m) => ({ default: m.FolderExplorerPanel })));
const NotesPanel = lazy(() => import('./NotesPanel').then((m) => ({ default: m.NotesPanel })));
const SpreadsheetPanel = lazy(() => import('./SpreadsheetPanel').then((m) => ({ default: m.SpreadsheetPanel })));
const ClipboardPanel = lazy(() => import('./ClipboardPanel').then((m) => ({ default: m.ClipboardPanel })));
const BackupPanel = lazy(() => import('./BackupPanel').then((m) => ({ default: m.BackupPanel })));
const NotificationsPanel = lazy(() => import('./NotificationsPanel').then((m) => ({ default: m.NotificationsPanel })));
const DocumentsPanel = lazy(() => import('./DocumentsPanel').then((m) => ({ default: m.DocumentsPanel })));
const MarketplacePanel = lazy(() => import('./MarketplacePanel').then((m) => ({ default: m.MarketplacePanel })));

// Phase 1.5 (UPGRADE-ROADMAP.md, 2026-08-11): the shared interactive "Tools" surface — a
// card-grid launcher (icon + name + one-line description per registered tool, served by
// GET /api/tool-panels) that opens each tool's dedicated panel in this same top-level view.
// Design conventions (see CLAUDE.md): card grid -> dedicated panel; the same panel opens
// from chat via the `openPanel` field on an `answer` payload; the CLI stays text-only by
// design. Later phases (3 = PDF, 6 = calculator) fill in real panel content; this phase
// renders placeholders wired to the chat equivalents that already exist.
const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  calculator: Calculator,
  'file-text': FileText,
  'list-checks': ListChecks,
  'folder-search': FolderSearch,
  'folder-open': FolderOpen,
  'sticky-note': StickyNote,
  table: TableIcon,
  'clipboard-copy': ClipboardCopy,
  archive: Archive,
  bell: Bell,
  'book-open': BookOpen,
  store: Store,
};

interface PanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
  aiEnabled?: boolean;
  tabId?: string | null;
}

// Per-panel element factories — each panel takes only the props it actually uses, so the
// lazy chunks stay decoupled from the full ToolsPanel prop surface.
const PANEL_VIEWS: Record<string, (p: PanelProps) => React.ReactElement> = {
  calculator: ({ onSendMessage }) => <CalculatorPanel onSendMessage={onSendMessage} />,
  'pdf-tools': ({ project, onSendMessage, tabId }) => <PdfToolsPanel project={project} onSendMessage={onSendMessage} tabId={tabId} />,
  reminders: ({ project, onSendMessage }) => <RemindersPanel project={project} onSendMessage={onSendMessage} />,
  'file-tools': ({ project, onSendMessage, tabId }) => <FileToolsPanel project={project} onSendMessage={onSendMessage} tabId={tabId} />,
  'folder-explorer': ({ onSendMessage, tabId }) => <FolderExplorerPanel onSendMessage={onSendMessage} tabId={tabId} />,
  notes: ({ project, onSendMessage, tabId }) => <NotesPanel project={project} onSendMessage={onSendMessage} tabId={tabId} />,
  'csv-tools': ({ project, onSendMessage, tabId }) => <SpreadsheetPanel project={project} onSendMessage={onSendMessage} tabId={tabId} />,
  clipboard: ({ onSendMessage }) => <ClipboardPanel onSendMessage={onSendMessage} />,
  backup: ({ project, onSendMessage, tabId }) => <BackupPanel project={project} onSendMessage={onSendMessage} tabId={tabId} />,
  notifications: ({ project, onSendMessage }) => <NotificationsPanel project={project} onSendMessage={onSendMessage} />,
  'knowledge-base': ({ project, onSendMessage, aiEnabled, tabId }) => <DocumentsPanel project={project} onSendMessage={onSendMessage} aiEnabled={aiEnabled} tabId={tabId} />,
  marketplace: ({ project, onSendMessage }) => <MarketplacePanel project={project} onSendMessage={onSendMessage} />,
};

// Shared shell every panel view used to duplicate: back button + the scroll region that
// owns the panel's vertical space (flex-1 min-h-0 — the panel scrolls, the shell never).
function PanelShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
          title="Back to the tool grid"
        >
          <ArrowLeft size={14} /> Tools
        </button>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

interface ToolsPanelProps {
  panels: ToolPanelDef[];
  /** Set when GET /api/tool-panels failed — lets the grid show a real error instead of an
   *  empty card list that looks like "no tools exist". */
  panelsError?: string | null;
  onRetryPanels?: () => void;
  activePanel: string | null;
  onOpenPanel: (id: string) => void;
  onClose: () => void;
  /** Active project for the tool panels that work on project files (PDF Tools). */
  project: Project | null;
  onSendMessage: (text: string) => void;
  /** Phase 16 audit: AI-mode state — the Documents panel's ask box only shows when AI is on. */
  aiEnabled?: boolean;
  /** Phase T (2026-08-14): the active tab whose workspace the panels' REST calls address. */
  tabId?: string | null;
}

export function ToolsPanel({ panels, panelsError, onRetryPanels, activePanel, onOpenPanel, onClose, project, onSendMessage, aiEnabled, tabId = null }: ToolsPanelProps) {
  const active = activePanel ? panels.find(p => p.id === activePanel) : null;

  if (active) {
    const view = PANEL_VIEWS[active.id];
    if (view) {
      return (
        <PanelShell onClose={() => onOpenPanel('')}>
          <Suspense fallback={<div className="text-sm text-fg-muted bg-panel rounded-xl border border-border-soft p-6">Loading panel…</div>}>
            {view({ project, onSendMessage, aiEnabled, tabId })}
          </Suspense>
        </PanelShell>
      );
    }
    const Icon = ICONS[active.icon] || LayoutGrid;
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="bg-panel rounded-xl border border-border-soft p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-scrim-faint rounded-lg text-accent">
                <Icon size={20} />
              </div>
              <h2 className="text-lg font-semibold text-fg-strong">{active.name}</h2>
              {!active.available && (
                <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-dim bg-scrim-faint rounded border border-border-soft">
                  not available
                </span>
              )}
            </div>
            <p className="text-sm text-fg-muted mb-4">{active.description}</p>
            <div className="text-sm text-fg-muted bg-scrim-faint rounded-lg p-4 border border-border-soft">
              {active.available ? (
                <>
                  This panel is wired up in a later update. The same feature already works
                  from chat — try{' '}
                  <code className="font-mono text-accent text-xs bg-panel-strong px-1.5 py-0.5 rounded">{active.chatHint}</code>
                  {' '}right here instead.
                </>
              ) : (
                <>This tool is not currently available on this machine.</>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <LayoutGrid size={16} className="text-accent" />
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Tools</h2>
          </div>
          <button onClick={onClose} className="p-1 text-fg-dim hover:text-fg-muted transition-colors" title="Close tools">
            ×
          </button>
        </div>
        <p className="text-sm text-fg-muted mb-4">
          Interactive utilities that open in their own panel. You can also open them from
          chat — type <code className="font-mono text-accent text-xs bg-scrim-faint px-1.5 py-0.5 rounded">open calculator</code> and the panel opens here.
        </p>
        {panels.length === 0 && panelsError ? (
          <div className="text-sm text-fg-muted bg-panel rounded-xl border border-border-soft p-6 text-center">
            <p>{panelsError}</p>
            <button
              onClick={onRetryPanels}
              className="mt-3 px-3 py-2 text-xs font-bold rounded-lg bg-accent-blue text-white hover:opacity-90 transition-opacity"
            >
              Retry
            </button>
          </div>
        ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {panels.map(p => {
            const Icon = ICONS[p.icon] || LayoutGrid;
            return (
              <button
                key={p.id}
                data-tour={p.id === 'folder-explorer' ? 'tool-folder-explorer' : p.id === 'pdf-tools' ? 'tool-pdf-tools' : undefined}
                onClick={() => onOpenPanel(p.id)}
                className={`text-left bg-panel rounded-xl border border-border-soft p-4 transition-colors ${
                  p.available
                    ? 'hover:border-accent/40 hover:bg-panel-strong cursor-pointer'
                    : 'opacity-60 cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-3 mb-1.5">
                  <div className="p-2 bg-scrim-faint rounded-lg text-accent">
                    <Icon size={18} />
                  </div>
                  <span className="text-sm font-semibold text-fg-strong">{p.name}</span>
                  {!p.available && (
                    <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-dim bg-scrim-faint rounded border border-border-soft">
                      unavailable
                    </span>
                  )}
                </div>
                <p className="text-xs text-fg-muted leading-relaxed">{p.description}</p>
              </button>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
}