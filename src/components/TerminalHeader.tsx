import React, { useState } from 'react';
import { Project, AIStatus, ToolCallEntry } from '../types';
import { Terminal as TerminalIcon, Download, FileDown, ListChecks, Settings, XCircle, Maximize2, Minimize2 } from 'lucide-react';

interface TerminalHeaderProps {
  activeProject: Project | null;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  ollamaStatus: AIStatus | null;
  workspaceProjects: Project[];
  removeFromWorkspace: (projectId: string) => void;
  clearWorkspace: () => void;
  onExportMarkdown: () => void;
  onExportJson: () => void;
  toolHistory: ToolCallEntry[];
  showToolHistory: boolean;
  onToggleToolHistory: () => void;
}

/** The terminal's top bar: connection badge, fullscreen toggle, workspace chips,
 *  export buttons, tool-call-history toggle, and the ⚙ session menu. */
export function TerminalHeader({
  activeProject,
  isFullscreen,
  onToggleFullscreen,
  ollamaStatus,
  workspaceProjects,
  removeFromWorkspace,
  clearWorkspace,
  onExportMarkdown,
  onExportJson,
  toolHistory,
  showToolHistory,
  onToggleToolHistory,
}: TerminalHeaderProps) {
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  return (
    <div className="flex items-center gap-3 px-6 py-4 border-b border-border-soft bg-panel flex-wrap">
      <TerminalIcon size={18} className="text-[#3d6bff]" />
      <span className="text-sm text-fg-muted flex-1">
        {activeProject ? `Connected: ${activeProject.name}` : 'No Project Selected'}
      </span>
      {onToggleFullscreen && (
        <button onClick={onToggleFullscreen} className="p-1.5 text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen chat'}>
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      )}
      {ollamaStatus && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {workspaceProjects.length > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-panel border border-border-soft">
              <span className="text-[10px] text-fg-dim">Workspace:</span>
              {workspaceProjects.map((p) => (
                <span key={p.id} className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#3d6bff]/10 border border-[#3d6bff]/30 text-xs text-[#3d6bff]">
                  {p.name}
                  <button onClick={() => removeFromWorkspace(p.id)} className="text-[#3d6bff]/60 hover:text-[#3d6bff] transition-colors">×</button>
                </span>
              ))}
              <button onClick={clearWorkspace} className="text-fg-faint hover:text-red-400 transition-colors text-xs" title="Clear workspace">×</button>
            </div>
          )}
          <div className="flex items-center gap-1">
            <button onClick={onExportMarkdown} className="p-1.5 text-fg-dim hover:text-fg-strong transition-colors" title="Export session as Markdown">
              <Download size={14} />
            </button>
            <button onClick={onExportJson} className="p-1.5 flex items-center gap-0.5 text-fg-dim hover:text-teal-400 transition-colors" title="Export session as JSON">
              <Download size={11} /><span className="text-[9px]">JSON</span>
            </button>
          </div>
          <button onClick={onToggleToolHistory} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors border ${showToolHistory ? 'bg-[#3d6bff]/20 border-[#3d6bff]/40 text-[#3d6bff]' : 'bg-panel border-border-soft text-fg-dim hover:text-fg-muted'}`} title="Tool Call History">
            <ListChecks size={14} />
            {toolHistory.length > 0 && <span className="text-[10px]">{toolHistory.length}</span>}
          </button>
          <div className="relative flex-shrink-0">
            <button onClick={() => setShowSessionMenu(!showSessionMenu)} className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${showSessionMenu ? 'text-fg-strong bg-panel-strong' : 'text-fg-dim hover:text-fg-strong'}`} title="Session menu">
              <Settings size={14} />
            </button>
            {showSessionMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowSessionMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border-soft rounded-lg shadow-2xl py-1 min-w-[200px]">
                  <button onClick={() => { setShowSessionMenu(false); onExportMarkdown(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                    <Download size={12} /> Export as Markdown
                  </button>
                  <button onClick={() => { setShowSessionMenu(false); onExportJson(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                    <FileDown size={12} /> Export as JSON
                  </button>
                  <button onClick={() => { setShowSessionMenu(false); onToggleToolHistory(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                    <ListChecks size={12} /> Tool Call History
                  </button>
                  {workspaceProjects.length > 0 && (
                    <button onClick={() => { setShowSessionMenu(false); clearWorkspace(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                      <XCircle size={12} /> Clear Workspace
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
