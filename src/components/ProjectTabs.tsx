import { useEffect } from 'react';
import { Plus, X, FolderOpen } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ConsoleTab } from '../hooks/useConsoleTabs';

// Phase T (2026-08-14): Chrome-style tab strip. Each tab = its own scan folder + project list
// + open chat (see useConsoleTabs.ts). "+" duplicates the current tab so the first tab keeps
// its folder while the new one can scan elsewhere; every tab (including the default) has an ×
// — closing the last remaining tab leaves a fresh default tab, so at least one always exists.
// Phase 5: Ctrl+Tab / Ctrl+Shift+Tab cycle tabs (Chrome parity), middle-click closes.
interface ProjectTabsProps {
  tabs: ConsoleTab[];
  activeTabId: string | null;
  activeProjectName: string | null;
  onActivate: (tabId: string | null) => void;
  onDuplicate: () => void;
  onClose: (tabId: string | null) => void;
}

function folderLabel(scanPath: string): string {
  if (!scanPath) return 'Scan a folder';
  const trimmed = scanPath.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function ProjectTabs({ tabs, activeTabId, activeProjectName, onActivate, onDuplicate, onClose }: ProjectTabsProps) {
  // Phase 5: Ctrl+Tab cycles forward, Ctrl+Shift+Tab backward (wrapping). Tabs always
  // exist (closing the last leaves a fresh default), so the index math is safe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== 'Tab') return;
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const next = e.shiftKey
        ? (idx <= 0 ? tabs.length - 1 : idx - 1)
        : (idx + 1) % tabs.length;
      if (tabs[next]) onActivate(tabs[next].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, activeTabId, onActivate]);

  return (
    <div data-tour="tab-strip" className="flex items-center gap-1 px-3 pt-2 overflow-x-auto shrink-0">
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        const label = t.activeProjectId === '__general__'
          ? 'General'
          : (t.activeProjectId && activeProjectName && active ? activeProjectName : folderLabel(t.scanPath));
        return (
          <div
            key={t.id ?? 'default'}
            role="button"
            tabIndex={0}
            onClick={() => onActivate(t.id)}
            onAuxClick={(e) => { if (e.button === 1) onClose(t.id); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(t.id); } }}
            className={cn(
              'group flex items-center gap-1.5 min-w-0 max-w-[220px] rounded-t-lg px-3 py-1.5 text-xs border border-b-0 transition-colors cursor-pointer select-none',
              active
                ? 'bg-overlay text-fg-strong border-border-soft'
                : 'bg-scrim-faint text-fg-dim hover:text-fg-muted border-transparent',
            )}
            title={t.scanPath || 'Default workspace'}
          >
            <FolderOpen size={12} className="shrink-0 text-accent-blue" />
            <span className="truncate">{label}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              className="shrink-0 p-0.5 rounded text-fg-faint hover:text-fg-strong hover:bg-panel transition-colors"
              title={t.id === null ? 'Close tab (a fresh default tab takes its place)' : 'Close tab'}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      <button
        data-tour="tab-new"
        onClick={onDuplicate}
        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-fg-dim hover:text-fg-strong hover:bg-panel-strong/60 transition-colors"
        title="Duplicate tab — scan another folder while this one keeps its own"
      >
        <Plus size={13} /> New tab
      </button>
      <div className="flex-1 border-b border-border-soft" />
    </div>
  );
}
