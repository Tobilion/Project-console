import { Calculator, FileText, ListChecks, FolderSearch, StickyNote, Table as TableIcon, ClipboardCopy, Archive, Bell, LayoutGrid, ArrowLeft } from 'lucide-react';
import type { ToolPanelDef, Project } from '../types';
import { PdfToolsPanel } from './PdfToolsPanel';
import { RemindersPanel } from './RemindersPanel';
import { FileToolsPanel } from './FileToolsPanel';
import { NotesPanel } from './NotesPanel';
import { CalculatorPanel } from './CalculatorPanel';
import { SpreadsheetPanel } from './SpreadsheetPanel';
import { ClipboardPanel } from './ClipboardPanel';
import { BackupPanel } from './BackupPanel';
import { NotificationsPanel } from './NotificationsPanel';

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
  'sticky-note': StickyNote,
  table: TableIcon,
  'clipboard-copy': ClipboardCopy,
  archive: Archive,
  bell: Bell,
};

interface ToolsPanelProps {
  panels: ToolPanelDef[];
  activePanel: string | null;
  onOpenPanel: (id: string) => void;
  onClose: () => void;
  /** Active project for the tool panels that work on project files (PDF Tools). */
  project: Project | null;
  onSendMessage: (text: string) => void;
}

export function ToolsPanel({ panels, activePanel, onOpenPanel, onClose, project, onSendMessage }: ToolsPanelProps) {
  const active = activePanel ? panels.find(p => p.id === activePanel) : null;

  if (active) {
    if (active.id === 'calculator') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <CalculatorPanel onSendMessage={onSendMessage} />
          </div>
        </div>
      );
    }
    if (active.id === 'pdf-tools') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <PdfToolsPanel project={project} onSendMessage={onSendMessage} />
          </div>
        </div>
      );
    }
    if (active.id === 'reminders') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <RemindersPanel project={project} onSendMessage={onSendMessage} />
          </div>
        </div>
      );
    }
    if (active.id === 'file-tools') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <FileToolsPanel project={project} onSendMessage={onSendMessage} />
          </div>
        </div>
      );
    }
    if (active.id === 'notes') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <NotesPanel project={project} onSendMessage={onSendMessage} />
          </div>
        </div>
      );
    }
    if (active.id === 'csv-tools') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <SpreadsheetPanel project={project} onSendMessage={onSendMessage} />
          </div>
        </div>
      );
    }
    if (active.id === 'clipboard') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <ClipboardPanel onSendMessage={onSendMessage} />
          </div>
        </div>
      );
    }
    if (active.id === 'backup') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <BackupPanel project={project} onSendMessage={onSendMessage} />
          </div>
        </div>
      );
    }
    if (active.id === 'notifications') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              onClick={() => onOpenPanel('')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint rounded-lg border border-border-soft transition-colors"
              title="Back to the tool grid"
            >
              <ArrowLeft size={14} /> Tools
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <NotificationsPanel project={project} onSendMessage={onSendMessage} />
          </div>
        </div>
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
                  <code className="font-mono text-accent text-xs bg-panel-strong px-1.5 py-0.5 rounded">{
                    active.chatHint === 'none yet — the PDF trigger commands land in a later update'
                      ? 'waiting for its chat triggers to ship'
                      : active.chatHint
                  }</code>
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
        <div className="grid gap-3 sm:grid-cols-2">
          {panels.map(p => {
            const Icon = ICONS[p.icon] || LayoutGrid;
            return (
              <button
                key={p.id}
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
      </div>
    </div>
  );
}