import React from 'react';
import { TextScramble } from './TextScramble';
import { BentoGrid } from './BentoGrid';
import { Project, AIStatus } from '../types';
import { Brain, Cpu, HardDrive, FolderSearch, Code, Zap, MessageSquare, BookOpen, Sparkles, LayoutGrid } from 'lucide-react';

export interface WelcomeScreenProps {
  projects: Project[];
  activeProject: Project | null;
  ollamaStatus: AIStatus | null;
  aiEnabled: boolean;
  greeting: string;
  onAIToggle: () => void;
  onSelectProject: (p: Project) => void;
  onNewChat: () => void;
  onQuickStart: () => void;
  workspaceProjects: Project[];
  addToWorkspace: (p: Project) => void;
  removeFromWorkspace: (projectId: string) => void;
  /** Phase T2: opens the tour section picker (see App.tsx's TourPicker). */
  onOpenTourPicker?: () => void;
}

export function WelcomeScreen({ projects, activeProject, ollamaStatus, aiEnabled, greeting, onAIToggle, onSelectProject, onNewChat, onQuickStart, workspaceProjects, addToWorkspace, removeFromWorkspace, onOpenTourPicker }: WelcomeScreenProps) {

  // Per-project stats when a project is selected, else global totals across all discovered
  // projects — so the strip is never empty and swaps context as the active project changes.
  const idx = activeProject?.codebaseIndex;
  const totalFiles = idx ? idx.totalFiles : projects.reduce((sum, p) => sum + (p.codebaseIndex?.totalFiles || 0), 0);
  const totalDirs = idx ? idx.totalDirs : projects.reduce((sum, p) => sum + (p.codebaseIndex?.totalDirs || 0), 0);
  const langs = idx ? idx.languages : (() => {
    const s = new Set<string>();
    projects.forEach(p => p.codebaseIndex?.languages?.forEach(l => s.add(l.split(' ')[0])));
    return [...s];
  })();
  const entryPoints = idx?.entryPoints ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full px-6 py-8">
        <div className="text-left mb-6">
          <h1 className="text-display text-fg-strong mb-3">
            <TextScramble text={greeting} />
          </h1>
          <p className="text-xs tracking-[0.2em] uppercase text-fg-dim font-bold">
            Project Console · Local Project Engine — {projects.length} Projects Loaded
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel border border-border-soft text-xs" title="Source files">
            <span className="text-accent-blue"><HardDrive size={14} /></span>
            <span className="text-fg-strong font-bold">{totalFiles.toLocaleString()}</span>
            <span className="text-fg-dim">Files</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel border border-border-soft text-xs" title="Directories">
            <span className="text-accent-blue"><FolderSearch size={14} /></span>
            <span className="text-fg-strong font-bold">{totalDirs.toLocaleString()}</span>
            <span className="text-fg-dim">Dirs</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel border border-border-soft text-xs" title="Languages">
            <span className="text-accent-blue"><Code size={14} /></span>
            <span className="text-fg-strong font-bold">{langs.slice(0, 3).join(', ') || '—'}</span>
            <span className="text-fg-dim">Lang</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel border border-border-soft text-xs max-w-[220px]" title="Entry points">
            <span className="text-accent-blue flex-shrink-0"><Zap size={14} /></span>
            <span className="text-fg-strong font-bold font-mono truncate">{entryPoints.slice(0, 2).join(', ') || '—'}</span>
            <span className="text-fg-dim flex-shrink-0">Entry</span>
          </div>
          {ollamaStatus && (
            <button onClick={onAIToggle} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all border ${aiEnabled ? 'bg-accent-teal/20 border-accent-teal/40 text-accent-teal' : 'bg-panel border-border-soft text-fg-subtle hover:text-fg-strong'}`}>
              <Brain size={14} />
              AI {aiEnabled ? 'ON' : 'OFF'}
            </button>
          )}
          {ollamaStatus?.models?.length > 0 && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel border border-border-soft text-[11px] text-fg-dim font-mono">
              <Cpu size={13} /> {ollamaStatus.models[0].name}
            </span>
          )}
        </div>

        <div className="flex flex-wrap justify-center gap-3 mb-8">
          <button onClick={onNewChat} className="flex items-center gap-2 px-5 py-2.5 bg-accent-blue text-white rounded-xl font-bold text-sm hover:opacity-90 transition-opacity shadow-card">
            <MessageSquare size={16} /> New Chat
          </button>
          <button onClick={onQuickStart} className="flex items-center gap-2 px-5 py-2.5 bg-panel border border-border-faint text-fg-muted rounded-xl font-bold text-sm hover:bg-panel-strong transition-colors">
            <BookOpen size={16} /> Quick Start Guide
          </button>
          <button onClick={onOpenTourPicker} className="flex items-center gap-2 px-5 py-2.5 bg-panel border border-border-faint text-accent-teal rounded-xl font-bold text-sm hover:bg-panel-strong transition-colors group">
            <Sparkles size={16} className="group-hover:rotate-12 transition-transform" /> Take the Tour
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="text-sm text-fg-dim italic text-center py-8">No projects found. Try scanning a different path.</div>
        ) : (
          <BentoGrid
            projects={projects}
            activeProject={activeProject}
            onSelect={onSelectProject}
            workspaceProjects={workspaceProjects}
            addToWorkspace={addToWorkspace}
            removeFromWorkspace={removeFromWorkspace}
          />
        )}
      </div>
    </div>
  );
}
