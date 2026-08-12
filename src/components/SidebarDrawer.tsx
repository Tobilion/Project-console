import React from 'react';
import { Project, ChatSession } from '../types';
import { FolderSearch, Plus, MessageSquare, Trash2, Pencil, ChevronLeft, ChevronRight, Brain, FolderGit2, Star } from 'lucide-react';
import { WorkspaceToggleButton } from './ui/WorkspaceToggleButton';

interface SidebarDrawerProps {
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
  workspaceProjects: Project[];
  addToWorkspace: (p: Project) => void;
  removeFromWorkspace: (projectId: string) => void;
  aiEnabled: boolean;
  aiModel: string | null;
  activeServersCount: number;
  collapsed: boolean;
  onSetCollapsed: (v: boolean) => void;
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
  workspaceProjects, addToWorkspace, removeFromWorkspace,
  aiEnabled, aiModel, activeServersCount, collapsed, onSetCollapsed,
}: SidebarDrawerProps) => {
  const [showAllChats, setShowAllChats] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draftTitle, setDraftTitle] = React.useState('');
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
        <button onClick={() => onSetCollapsed(false)} className="p-2 text-fg-dim hover:text-fg-strong transition-colors" title="Expand sidebar">
          <ChevronRight size={16} />
        </button>
        <button onClick={() => onSetCollapsed(false)} className="p-2 text-fg-subtle hover:text-fg-strong transition-colors" title="Scan a folder">
          <FolderSearch size={16} />
        </button>
        <button onClick={() => { onSetCollapsed(false); createSession(activeProject?.id, activeProject?.name); }} className="p-2 text-fg-subtle hover:text-teal-400 transition-colors" title="New chat">
          <Plus size={16} />
        </button>
        <button onClick={() => onSetCollapsed(false)} className="p-2 text-fg-subtle hover:text-fg-strong transition-colors" title="Discovered projects">
          <FolderGit2 size={16} />
        </button>
        <div className="mt-auto flex flex-col items-center gap-2" title={aiEnabled ? `AI: ${aiModel ?? 'enabled'}` : 'AI off'}>
          <Brain size={16} className={`transition-colors ${aiEnabled ? 'text-accent' : 'text-fg-dim'}`} />
        </div>
      </aside>
    );
  }

  const visibleSessions = (showAllChats || !activeProject)
    ? sessions
    : sessions.filter(s => s.projectId === activeProject.id);

  return (
    <aside className="hidden lg:flex flex-col w-[240px] flex-shrink-0 h-full bg-overlay border-r border-border-faint overflow-hidden">
      <div className="flex items-center gap-1.5 p-2.5 border-b border-border-faint flex-shrink-0">
        <button onClick={() => onSetCollapsed(true)} className="p-1 text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0" title="Collapse sidebar">
          <ChevronLeft size={16} />
        </button>
        <form onSubmit={handleScan} className="flex items-center gap-1 bg-surface/50 p-1 rounded-lg border border-border-soft flex-1 min-w-0">
          <button type="button" onClick={handleBrowseFolder} className="flex items-center gap-1 px-1 text-fg-subtle hover:text-fg-strong transition-colors flex-shrink-0" title="Browse for a folder near your current scan directory (for any other location, paste the full path instead)">
            <FolderSearch size={13} />
          </button>
          <input
            type="text"
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            placeholder="C:\Users\...\Projects"
            className="bg-transparent border-none outline-none text-[11px] font-mono w-full min-w-0 text-fg"
          />
          <button
            type="submit"
            className="px-2 py-0.5 bg-accent-teal/20 text-accent-teal rounded-md text-[9px] font-bold tracking-wider uppercase hover:bg-accent-teal/30 transition-colors flex-shrink-0"
          >
            Scan
          </button>
        </form>
      </div>

      <div className="p-2.5 flex-shrink-0">
        <button
          onClick={() => createSession(activeProject?.id, activeProject?.name)}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-accent-teal/20 text-accent-teal rounded-lg text-[10px] font-bold tracking-wider uppercase hover:bg-accent-teal/30 transition-colors"
        >
          <Plus size={12} /> New Chat
        </button>
      </div>

      <div className="px-2.5 mb-1 flex-shrink-0">
        <span className="text-[10px] tracking-[0.2em] uppercase text-fg-dim font-bold">Chats</span>
      </div>
      {activeProject && (
        <button
          onClick={() => setShowAllChats(v => !v)}
          className="text-[10px] text-fg-dim hover:text-fg-muted text-left px-2.5 mb-1 transition-colors flex-shrink-0"
        >
          {showAllChats ? `Showing all projects — show only "${activeProject.name}"` : 'Show chats from all projects'}
        </button>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-1">
        {visibleSessions.length === 0 && (
          <button onClick={() => createSession(activeProject?.id, activeProject?.name)} className="w-full text-xs text-fg-dim italic text-left py-2 px-2 rounded-lg hover:bg-panel transition-colors">
            {activeProject && !showAllChats ? `No chats yet for "${activeProject.name}" — create one` : 'No chats yet — create one'}
          </button>
        )}
        {visibleSessions.map(s => (
          <div
            key={s.id}
            onClick={() => switchSession(s.id)}
            className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-xs transition-colors group ${
              activeSessionId === s.id ? 'bg-teal-500/15 text-teal-300' : 'text-fg-subtle hover:bg-panel'
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
              {s.projectName && (
                <span className="truncate text-[10px] text-fg-dim normal-case tracking-normal">{s.projectName}</span>
              )}
            </span>
            {editingId !== s.id && (
              <button onClick={(e) => { e.stopPropagation(); setEditingId(s.id); setDraftTitle(s.title); }} className="opacity-0 group-hover:opacity-100 text-fg-dim hover:text-teal-400 transition-all flex-shrink-0" title="Rename chat">
                <Pencil size={12} />
              </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }} className="opacity-0 group-hover:opacity-100 text-fg-dim hover:text-red-400 transition-all flex-shrink-0">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="px-2.5 mt-1 mb-1 flex-shrink-0">
        <span className="text-[10px] tracking-[0.2em] uppercase text-fg-dim font-bold">Projects</span>
      </div>
      <div className="max-h-44 overflow-y-auto px-2 pb-2 flex-shrink-0">
        {projects.length === 0 ? (
          <div className="text-[11px] text-fg-dim italic px-2 py-2">No projects found. Try scanning a different path.</div>
        ) : (
          [...projects.filter((p) => pinned.includes(p.id)), ...projects.filter((p) => !pinned.includes(p.id))].map(p => (
            <div
              key={p.id}
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
        <Brain size={14} className={`flex-shrink-0 ${aiEnabled ? 'text-accent' : 'text-fg-dim'}`} />
        <span className="text-[10px] text-fg-dim truncate flex-1 min-w-0 font-mono" title={aiEnabled ? (aiModel ?? 'AI enabled') : 'AI off'}>
          {aiEnabled ? (aiModel ?? 'AI on') : 'AI off'}
        </span>
        {activeServersCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-green-400 whitespace-nowrap flex-shrink-0" title={`${activeServersCount} running`}>
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block animate-pulse" />
            {activeServersCount}
          </span>
        )}
      </div>
    </aside>
  );
};
