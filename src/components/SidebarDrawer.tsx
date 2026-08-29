import React from 'react';
import { Project, ChatSession } from '../types';
import { GENERAL_PROJECT_ID } from '../types';
import { FolderSearch, Plus, MessageSquare, Trash2, Pencil, ChevronLeft, ChevronRight, Brain, FolderGit2, Star, Maximize2 } from 'lucide-react';
import { WorkspaceToggleButton } from './ui/WorkspaceToggleButton';

export interface SidebarDrawerProps {
  projects: Project[];
  activeProject: Project | null;
  sessions: ChatSession[];
  activeSessionId: string | null;
  scanPath: string;
  setScanPath: (v: string) => void;
  handleScan: (e: React.FormEvent<HTMLFormElement>) => void;
  handleBrowseFolder: () => void;
  createSession: (projectId?: string, projectName?: string) => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  handleSelectProject: (p: Project) => void;
  /** Feature B (2026-08-14): opens the full Chat History overlay. */
  onOpenChatHistory: () => void;
  workspaceProjects: Project[];
  addToWorkspace: (p: Project) => void;
  removeFromWorkspace: (projectId: string) => void;
  aiEnabled: boolean;
  aiModel: string | null;
  activeServersCount: number;
  collapsed: boolean;
  onSetCollapsed: (v: boolean) => void;
}

// Feature B (2026-08-14): the sidebar's chat list is scoped by a General | Projects switch
// instead of a per-project "show all" toggle — the user asked to always be able to see all
// chats of a kind at once. General chats are those with no project (or the reserved General
// pseudo-workspace); Projects covers everything else.
function isGeneralChat(s: ChatSession): boolean {
  return !s.projectId || s.projectId === GENERAL_PROJECT_ID;
}

function folderLabel(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

// Claude/ChatGPT-style scoping: when a project is active, the sidebar shows only that
// project's chats by default (matches "each project has its own chat history"). The toggle
// is a deliberate escape hatch, not a redesign away from per-project scoping — sometimes you
// do want to see everything at once (e.g. hunting for a chat you can't remember the project
// for).
export const SidebarDrawer = ({
  projects, activeProject, sessions, activeSessionId,
  scanPath, setScanPath, handleScan, handleBrowseFolder,
  createSession, switchSession, deleteSession, renameSession, handleSelectProject,
  onOpenChatHistory,
  workspaceProjects, addToWorkspace, removeFromWorkspace,
  aiEnabled, aiModel, activeServersCount, collapsed, onSetCollapsed,
}: SidebarDrawerProps) => {
  const [chatTab, setChatTab] = React.useState<'general' | 'projects'>('general');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draftTitle, setDraftTitle] = React.useState('');
  // Phase 5: chat-list search filter (title + project name, client-side like the Dashboard
  // filter — no server round-trip for a local list).
  const [chatSearch, setChatSearch] = React.useState('');
  // Phase 5: default the chat tab to the active project's chats when a project is active
  // (per-project scoping is the intended default; the General | Projects switch stays the
  // deliberate escape hatch — it only re-syncs when the active project changes, so a user
  // who deliberately flipped to General isn't yanked back mid-session).
  React.useEffect(() => {
    if (activeProject?.id) setChatTab('projects');
  }, [activeProject?.id]);
  // Phase 8 (2026-08-11): pinned/favorite projects — a browser-local preference (localStorage),
  // deliberately not server state: pinning is pure UI ordering, same class as the sidebar's
  // collapsed flag. Pinned projects render above the rest of the list.
  const [pinned, setPinned] = React.useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('console.pinnedProjects') || '[]');
    } catch {
      return [];
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem('console.pinnedProjects', JSON.stringify(pinned));
    } catch {
      // Storage unavailable (private mode etc.) — pinning just won't persist, nothing breaks.
    }
  }, [pinned]);

  const togglePin = (projectId: string) => {
    setPinned((prev) => (prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]));
  };

  // Commits the inline rename for the row currently being edited (only one at a time, so the
  // shared draftTitle always belongs to editingId's row).
  const commitRename = () => {
    if (draftTitle.trim()) {
      renameSession(editingId as string, draftTitle);
    }
    setEditingId(null);
  };

  if (collapsed) {
    return (
      <aside className="hidden lg:flex flex-col items-center gap-2 w-14 flex-shrink-0 h-full bg-panel rounded-2xl border border-border-soft p-2">
        <button onClick={() => onSetCollapsed(false)} className="p-3 text-fg-dim hover:text-fg-strong transition-colors" title="Expand sidebar">
          <ChevronRight size={16} />
        </button>
        <button onClick={() => onSetCollapsed(false)} className="p-3 text-fg-subtle hover:text-fg-strong transition-colors" title="Expand to scan a folder">
          <FolderSearch size={16} />
        </button>
        <button onClick={() => { onSetCollapsed(false); createSession(activeProject?.id, activeProject?.name); }} className="p-3 text-fg-subtle hover:text-accent-blue transition-colors" title="New chat">
          <Plus size={16} />
        </button>
        <button onClick={() => onSetCollapsed(false)} className="p-3 text-fg-subtle hover:text-fg-strong transition-colors" title="Expand to see discovered projects">
          <FolderGit2 size={16} />
        </button>
        <div className="mt-auto flex flex-col items-center gap-2" title={aiEnabled ? `AI: ${aiModel ?? 'enabled'}` : 'AI off'}>
          <Brain size={16} className={`transition-colors ${aiEnabled ? 'text-accent-blue' : 'text-fg-dim'}`} />
        </div>
      </aside>
    );
  }

  const visibleSessions = chatTab === 'general'
    ? sessions.filter(isGeneralChat)
    : sessions.filter((s) => !isGeneralChat(s));
  const searchNeedle = chatSearch.trim().toLowerCase();
  const filteredSessions = searchNeedle
    ? visibleSessions.filter((s) => s.title.toLowerCase().includes(searchNeedle) || (s.projectName || '').toLowerCase().includes(searchNeedle))
    : visibleSessions;

  return (
    <aside data-tour="sidebar" className="hidden lg:flex flex-col w-[240px] flex-shrink-0 h-full bg-overlay border-r border-border-faint overflow-hidden">
      <div className="flex items-center gap-1.5 p-2.5 border-b border-border-faint flex-shrink-0">
        <button onClick={() => onSetCollapsed(true)} className="p-1 text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0" title="Collapse sidebar">
          <ChevronLeft size={16} />
        </button>
        <form onSubmit={handleScan} className="flex items-center gap-1 bg-surface/50 p-1 rounded-lg border border-border-soft flex-1 min-w-0">
          <button type="button" onClick={handleBrowseFolder} className="flex items-center gap-1 px-1 text-fg-subtle hover:text-fg-strong transition-colors flex-shrink-0" title="Browse for a folder near your current scan directory (for any other location, paste the full path instead)">
            <FolderSearch size={13} />
          </button>
          <input
            data-tour="scan-input"
            type="text"
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            placeholder="C:\Users\...\Projects"
            className="bg-transparent border-none outline-none text-[11px] font-mono w-full min-w-0 text-fg"
          />
          <button
            type="submit"
            className="px-2 py-0.5 bg-accent-blue/20 text-accent-blue rounded-lg text-[9px] font-bold tracking-wider uppercase hover:bg-accent-blue/30 transition-colors flex-shrink-0"
          >
            Scan
          </button>
        </form>
      </div>

      <div className="p-2.5 flex-shrink-0">
        <button
          onClick={() => chatTab === 'general' ? createSession(undefined, undefined) : createSession(activeProject?.id, activeProject?.name)}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-accent-blue/20 text-accent-blue rounded-lg text-[10px] font-bold tracking-wider uppercase hover:bg-accent-blue/30 transition-colors"
        >
          <Plus size={12} /> New Chat
        </button>
      </div>

      <div className="px-2.5 mb-1 flex items-center justify-between flex-shrink-0">
        <span className="text-[10px] tracking-[0.2em] uppercase text-fg-dim font-bold">Chats</span>
        <button data-tour="chat-history-button" onClick={onOpenChatHistory} className="p-1 text-fg-dim hover:text-fg-strong rounded transition-colors" title="Open full chat history">
          <Maximize2 size={12} />
        </button>
      </div>
      <div className="px-2.5 mb-1 flex items-center gap-0.5 flex-shrink-0">
        {(['general', 'projects'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setChatTab(t)}
            className={`flex-1 px-2 py-1 rounded-md text-[10px] font-semibold capitalize transition-colors ${chatTab === t ? 'bg-accent-blue/15 text-accent-blue' : 'text-fg-dim hover:text-fg-strong'}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="px-2.5 mb-1 flex-shrink-0">
        <input
          value={chatSearch}
          onChange={(e) => setChatSearch(e.target.value)}
          placeholder={`Filter ${chatTab} chats...`}
          className="w-full bg-surface/50 border border-border-soft rounded-md px-2 py-1 text-[11px] text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent-blue/50"
        />
      </div>
      <div data-tour="chats-list" className="flex-1 min-h-0 overflow-y-auto px-2 pb-1">
        {filteredSessions.length === 0 && (
          <button onClick={() => chatTab === 'general' ? createSession(undefined, undefined) : createSession(activeProject?.id, activeProject?.name)} className="w-full text-xs text-fg-dim italic text-left py-2 px-2 rounded-lg hover:bg-panel transition-colors">
            {visibleSessions.length === 0
              ? (chatTab === 'general' ? 'No general chats yet — create one' : 'No project chats yet — create one')
              : `No chats match "${chatSearch}".`}
          </button>
        )}
        {filteredSessions.map(s => (
          <div
            key={s.id}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchSession(s.id); }
            }}
            onClick={() => switchSession(s.id)}
            className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-xs transition-colors group ${
              activeSessionId === s.id ? 'bg-accent-blue/15 text-accent-blue' : 'text-fg-subtle hover:bg-panel'
            }`}
          >
            <MessageSquare size={14} className="flex-shrink-0" />
            <span className="truncate flex-1 flex flex-col min-w-0">
              {editingId === s.id ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={commitRename}
                  maxLength={80}
                  className="bg-scrim-faint rounded px-1 py-0.5 text-xs font-mono w-full min-w-0 outline-none border border-border-strong text-fg"
                />
              ) : (
                <span className="truncate">{s.title}</span>
              )}
              {s.projectName ? (
                <span className="truncate text-[10px] text-fg-dim normal-case tracking-normal">{s.projectName}</span>
              ) : s.workspacePath ? (
                // General chats have no project — show which workspace folder they belong to.
                <span className="truncate text-[10px] text-fg-dim normal-case tracking-normal">{folderLabel(s.workspacePath)}</span>
              ) : null}
            </span>
            {editingId !== s.id && (
              <button onClick={(e) => { e.stopPropagation(); setEditingId(s.id); setDraftTitle(s.title); }} className="opacity-0 group-hover:opacity-100 text-fg-dim hover:text-accent-blue transition-all flex-shrink-0" title="Rename chat">
                <Pencil size={12} />
              </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }} className="opacity-0 group-hover:opacity-100 text-fg-dim hover:text-accent-red transition-all flex-shrink-0">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="px-2.5 mt-1 mb-1 flex-shrink-0">
        <span className="text-[10px] tracking-[0.2em] uppercase text-fg-dim font-bold">Projects</span>
      </div>
      <div data-tour="project-list" className="max-h-44 overflow-y-auto px-2 pb-2 flex-shrink-0 [scrollbar-width:thin]">
        {projects.length === 0 ? (
          <div className="text-[11px] text-fg-dim italic px-2 py-2">No projects found. Try scanning a different path.</div>
        ) : (
          [...projects.filter((p) => pinned.includes(p.id)), ...projects.filter((p) => !pinned.includes(p.id))].map(p => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectProject(p); }
              }}
              onClick={() => handleSelectProject(p)}
              className={`relative flex items-center gap-2 pl-2.5 pr-2 h-9 rounded-lg cursor-pointer text-xs transition-colors group ${
                activeProject?.id === p.id ? 'bg-panel-strong text-fg-strong' : 'text-fg-subtle hover:bg-panel-strong'
              }`}
            >
              {activeProject?.id === p.id && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full bg-accent-blue" />
              )}
              <FolderGit2 size={13} className="flex-shrink-0" />
                 <span className="truncate flex-1 min-w-0">{p.name}</span>
                 <button
                   onClick={(e) => { e.stopPropagation(); togglePin(p.id); }}
                   // Icon-convention exception (Stage G, documented): the pinned-star stays
                   // yellow — a yellow star is the universal "pinned/bookmarked" convention
                   // (browser bookmarks, iOS favorites) and is not a warning, so accent-orange
                   // would misread. This is the deliberate exception, not a missed sweep.
                   className="opacity-0 group-hover:opacity-100 p-0.5 flex-shrink-0 text-fg-dim hover:text-yellow-400 transition-all"
                   title={pinned.includes(p.id) ? 'Unpin project' : 'Pin project to the top'}
                 >
                   <Star size={11} className={pinned.includes(p.id) ? 'fill-yellow-400 text-yellow-400 opacity-100' : ''} />
                 </button>
                 <WorkspaceToggleButton
                   inWorkspace={workspaceProjects.some(w => w.id === p.id)}
                   onAdd={() => addToWorkspace(p)}
                   onRemove={() => removeFromWorkspace(p.id)}
                   size={11}
                   className="opacity-0 group-hover:opacity-100 p-0.5 flex-shrink-0"
                 />
            </div>
          ))
        )}
      </div>

      <div className="mt-auto flex-shrink-0 border-t border-border-faint px-2.5 py-2 flex items-center gap-2">
        <Brain size={14} className={`flex-shrink-0 ${aiEnabled ? 'text-accent-blue' : 'text-fg-dim'}`} />
        <span className="text-[10px] text-fg-dim truncate flex-1 min-w-0 font-mono" title={aiEnabled ? (aiModel ?? 'AI enabled') : 'AI off'}>
          {aiEnabled ? (aiModel ?? 'AI on') : 'AI off'}
        </span>
        {activeServersCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-accent-green whitespace-nowrap flex-shrink-0" title={`${activeServersCount} running`}>
            <span className="w-1.5 h-1.5 rounded-full bg-accent-green inline-block animate-pulse" />
            {activeServersCount}
          </span>
        )}
      </div>
    </aside>
  );
};
