import React from 'react';
import { TextScramble } from './TextScramble';
import { BentoGrid } from './BentoGrid';
import { Project, AIStatus } from '../types';
import { Brain, Cpu, HardDrive, FolderSearch, Code, Zap, MessageSquare, BookOpen, Check, ChevronLeft, ChevronRight, X, Sparkles, LayoutGrid } from 'lucide-react';

interface WelcomeScreenProps {
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
}

const TOUR_STEPS = [
  {
    icon: <Sparkles size={28} />,
    title: 'Welcome to Project Console',
    body: 'This is your local, offline command center for every project on your machine. Browse any folder, run commands, check git status, and ask questions — all without leaving this window. AI mode is off by default; you control when it activates.',
  },
  {
    icon: <FolderSearch size={28} />,
    title: 'Projects & Navigation',
    body: 'Every discovered project appears in the grid below. Click any card to open a chat scoped to that project — sessions, commands, and file access all stay inside its folder. Use the scan bar in the sidebar to point at any directory on your machine.',
  },
  {
    icon: <Brain size={28} />,
    title: 'AI Assistant',
    body: 'Toggle AI mode on for natural-language conversations: ask questions about a project\'s code, read files, write new ones, and run commands. Every write or risky action asks for your approval first — the AI never acts without your say-so.',
  },
  {
    icon: <LayoutGrid size={28} />,
    title: 'Tools Panel',
    body: 'Click the Tools button in the header (or type "open reminders"/"open pdf tools" in chat) for interactive panels. PDF Tools, Reminders, and others as they ship live behind the same card grid — one surface for every utility the console offers.',
  },
  {
    icon: <Check size={28} />,
    title: 'You\'re All Set',
    body: 'Quick Start Guide (below) lists the most common trigger-mode commands. The Dashboard button in the header shows live status for every project at a glance. Dive in — everything works offline, nothing leaves your machine.',
  },
];

export function WelcomeScreen({ projects, activeProject, ollamaStatus, aiEnabled, greeting, onAIToggle, onSelectProject, onNewChat, onQuickStart, workspaceProjects, addToWorkspace, removeFromWorkspace }: WelcomeScreenProps) {
  const [tourStep, setTourStep] = React.useState(0);

  // Escape closes the tour overlay — the same keyboard path every modal in the app offers.
  React.useEffect(() => {
    if (tourStep === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTourStep(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tourStep]);

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
          <button onClick={() => setTourStep(1)} className="flex items-center gap-2 px-5 py-2.5 bg-panel border border-border-faint text-accent-teal rounded-xl font-bold text-sm hover:bg-panel-strong transition-colors group">
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

      {tourStep > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" onClick={() => setTourStep(0)} />
          <div className="relative z-10 w-full max-w-lg mx-4 bg-panel/90 backdrop-blur-xl border border-border-strong rounded-2xl shadow-modal overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-6 pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-accent-teal/10 rounded-lg text-accent-teal">
                  {TOUR_STEPS[tourStep - 1].icon}
                </div>
                <div className="text-xs text-fg-dim">
                  Step {tourStep} of {TOUR_STEPS.length}
                </div>
              </div>
              <button onClick={() => setTourStep(0)} className="p-1 text-fg-dim hover:text-fg-muted transition-colors">
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-4">
              <h2 className="text-xl font-bold text-fg-strong mb-3">{TOUR_STEPS[tourStep - 1].title}</h2>
              <p className="text-sm text-fg-subtle leading-relaxed">{TOUR_STEPS[tourStep - 1].body}</p>
            </div>

            <div className="flex items-center justify-between px-6 pb-6 pt-2">
              <div className="flex gap-1.5">
                {TOUR_STEPS.map((_, i) => (
                  <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i + 1 === tourStep ? 'bg-accent-teal' : 'bg-panel-strong'}`} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                {tourStep > 1 && (
                  <button onClick={() => setTourStep(s => s - 1)} className="flex items-center gap-1 px-3 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">
                    <ChevronLeft size={14} /> Back
                  </button>
                )}
                {tourStep < TOUR_STEPS.length ? (
                  <button onClick={() => setTourStep(s => s + 1)} className="flex items-center gap-1.5 px-4 py-2 bg-accent-teal/20 text-accent-teal rounded-lg text-xs font-bold tracking-wider uppercase hover:bg-accent-teal/30 transition-colors">
                    Next <ChevronRight size={14} />
                  </button>
                ) : (
                  <button onClick={() => setTourStep(0)} className="flex items-center gap-1.5 px-4 py-2 bg-accent-blue text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity">
                    Done <Check size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
