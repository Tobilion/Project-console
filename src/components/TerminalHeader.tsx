import React, { useState } from 'react';
import { Project, AIStatus, ToolCallEntry } from '../types';
import { Terminal as TerminalIcon, Download, FileDown, ListChecks, Settings, XCircle, Maximize2, Minimize2, MessagesSquare } from 'lucide-react';

interface TerminalHeaderProps {
  activeProject: Project | null;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Feature B (2026-08-14): opens the full Chat History overlay. */
  onOpenChatHistory?: () => void;
  ollamaStatus: AIStatus | null;
  workspaceProjects: Project[];
  removeFromWorkspace: (projectId: string) => void;
  clearWorkspace: () => void;
   onExportMarkdown: () => void;
   onExportJson: () => void;
   onExportPdf: () => void;
   onExportProjectChatLog: () => void;
   toolHistory: ToolCallEntry[];
   showToolHistory: boolean;
   onToggleToolHistory: () => void;
   connected: boolean;
 }

/** The terminal's top bar: connection badge, fullscreen toggle, workspace chips,
 *  export buttons, tool-call-history toggle, and the ⚙ session menu. */
export function TerminalHeader({
  activeProject,
  isFullscreen,
  onToggleFullscreen,
  onOpenChatHistory,
  ollamaStatus,
  workspaceProjects,
  removeFromWorkspace,
  clearWorkspace,
  onExportMarkdown,
  onExportJson,
  onExportPdf,
  onExportProjectChatLog,
  toolHistory,
  showToolHistory,
   onToggleToolHistory,
   connected,
 }: TerminalHeaderProps) {
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  return (
    <div data-tour="terminal-header" className="flex items-center gap-3 px-6 py-4 border-b border-border-soft bg-panel flex-wrap">
      <TerminalIcon size={18} className="text-accent-blue" />
      <span className="text-sm text-fg-muted flex-1">
        {activeProject ? `Connected: ${activeProject.name}` : 'No Project Selected'}
      </span>
      {!connected && (
        <span className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-orange/10 border border-accent-orange/30 text-xs text-accent-orange">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-orange inline-block animate-pulse" />
          Reconnecting…
        </span>
      )}
      {onToggleFullscreen && (
        <button onClick={onToggleFullscreen} className="p-1.5 text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen chat'}>
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      )}
      {onOpenChatHistory && (
        <button onClick={onOpenChatHistory} className="p-1.5 text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0" title="Chat history (all chats)">
          <MessagesSquare size={16} />
        </button>
      )}
      {ollamaStatus && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {workspaceProjects.length > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-panel border border-border-soft">
              <span className="text-[10px] text-fg-dim">Workspace:</span>
              {workspaceProjects.map((p) => (
                <span key={p.id} className="flex items-center gap-1 px-2 py-0.5 rounded bg-accent-blue/10 border border-accent-blue/30 text-xs text-accent-blue">
                  {p.name}
                  <button onClick={() => removeFromWorkspace(p.id)} aria-label={`Remove ${p.name} from workspace`} className="text-accent-blue/60 hover:text-accent-blue transition-colors">×</button>
                </span>
              ))}
              <button onClick={clearWorkspace} className="text-fg-faint hover:text-accent-red transition-colors text-xs" title="Clear workspace">×</button>
            </div>
          )}
          <div className="flex items-center gap-1">
            <button onClick={onExportMarkdown} className="p-1.5 text-fg-dim hover:text-fg-strong transition-colors" title="Export session as Markdown">
              <Download size={14} />
            </button>
            <button onClick={onExportJson} className="p-1.5 flex items-center gap-0.5 text-fg-dim hover:text-accent-teal transition-colors" title="Export session as JSON">
              <Download size={11} /><span className="text-[9px]">JSON</span>
            </button>
            <button onClick={onExportPdf} className="p-1.5 text-fg-dim hover:text-accent-teal transition-colors" title="Export session as PDF">
              <FileDown size={14} />
            </button>
          </div>
          <button onClick={onToggleToolHistory} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors border ${showToolHistory ? 'bg-accent-blue/20 border-accent-blue/40 text-accent-blue' : 'bg-panel border-border-soft text-fg-dim hover:text-fg-muted'}`} title="Tool Call History">
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
                <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border-soft rounded-lg shadow-float py-1 min-w-[200px]">
                  <button onClick={() => { setShowSessionMenu(false); onExportMarkdown(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                    <Download size={12} /> Export as Markdown
                  </button>
                  <button onClick={() => { setShowSessionMenu(false); onExportJson(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                    <FileDown size={12} /> Export as JSON
                  </button>
                  <button onClick={() => { setShowSessionMenu(false); onExportPdf(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                    <FileDown size={12} /> Export as PDF
                  </button>
                  {activeProject && (
                    <button onClick={() => { setShowSessionMenu(false); onExportProjectChatLog(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors" title="Download this project's full .console/chat-log.md">
                      <Download size={12} /> Export project chat log
                    </button>
                  )}
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
