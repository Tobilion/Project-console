import React from 'react';
import { TextScramble } from './TextScramble';
import { GlowOrbs } from './GlowOrbs';
import { Project, AIStatus } from '../types';
import { FolderSearch, MessageSquare, Brain, Cpu, HardDrive, Code, Zap, BookOpen, ArrowRight, Check, ChevronLeft, ChevronRight, X, Sparkles, Search, Terminal } from 'lucide-react';

interface WelcomeScreenProps {
  projects: Project[];
  ollamaStatus: AIStatus | null;
  aiEnabled: boolean;
  onAIToggle: () => void;
  onSelectProject: (p: Project) => void;
  onNewChat: () => void;
  onQuickStart: () => void;
}

const TOUR_STEPS = [
  {
    icon: <Sparkles size={28} />,
    title: 'Welcome to V4 Knowledge Engine',
    body: 'This is your local, offline command center for every project on your machine. Browse any folder, run commands, check git status, and ask questions — all without leaving this window. AI mode is off by default; you control when it activates.',
  },
  {
    icon: <FolderSearch size={28} />,
    title: 'Projects & Navigation',
    body: 'Every discovered project appears in the grid below. Click any card to open a chat scoped to that project — sessions, commands, and file access all stay inside its folder. Use the scan bar up top to point at any directory on your machine.',
  },
  {
    icon: <Brain size={28} />,
    title: 'AI Assistant',
    body: 'Toggle AI mode on for natural-language conversations: ask questions about a project\'s code, read files, write new ones, and run commands. Every write or risky action asks for your approval first — the AI never acts without your say-so.',
  },
  {
    icon: <Check size={28} />,
    title: 'You\'re All Set',
    body: 'Quick Start Guide (below) lists the most common trigger-mode commands. The Dashboard button in the header shows live status for every project at a glance. Dive in — everything works offline, nothing leaves your machine.',
  },
];

export function WelcomeScreen({ projects, ollamaStatus, aiEnabled, onAIToggle, onSelectProject, onNewChat, onQuickStart }: WelcomeScreenProps) {
  const [tourStep, setTourStep] = React.useState(0);

  const totalFiles = projects.reduce((sum, p) => sum + (p.codebaseIndex?.totalFiles || 0), 0);
  const totalDirs = projects.reduce((sum, p) => sum + (p.codebaseIndex?.totalDirs || 0), 0);
  const activeLangs = new Set<string>();
  projects.forEach(p => p.codebaseIndex?.languages?.forEach(l => activeLangs.add(l.split(' ')[0])));
  const latestProjects = projects.slice(0, 4);

  return (
    <div className="h-full flex flex-col items-center justify-center relative overflow-y-auto">
      <GlowOrbs />
      <div className="relative z-10 max-w-4xl w-full px-6">
        <div className="text-center mb-8">
          <h1 className="text-5xl md:text-7xl font-semibold italic text-fg-strong mb-4">
            <TextScramble text="Welcome Master Tobi" />
          </h1>
          <p className="text-sm tracking-[0.2em] uppercase text-fg-dim font-bold">
            V4 Knowledge Engine — {projects.length} Projects Loaded
          </p>
        </div>

        {ollamaStatus && (
          <div className="flex justify-center gap-4 mb-10">
            <button onClick={onAIToggle} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm transition-all border ${aiEnabled ? 'bg-teal-500/20 border-teal-500/40 text-teal-300 shadow-lg shadow-teal-500/10' : 'bg-panel border-border-soft text-fg-subtle hover:text-fg-strong'}`}>
              <Brain size={16} />
              AI Assistant — {aiEnabled ? 'ON' : 'OFF'}
            </button>
            {ollamaStatus.models?.length > 0 && (
              <span className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-panel border border-border-soft text-xs text-fg-dim font-mono">
                <Cpu size={14} /> {ollamaStatus.models[0].name}
              </span>
            )}
          </div>
        )}

        <div className="grid grid-cols-4 gap-3 mb-10">
          {[
            { icon: <HardDrive size={18} />, label: 'Files', value: totalFiles },
            { icon: <FolderSearch size={18} />, label: 'Directories', value: totalDirs },
            { icon: <Code size={18} />, label: 'Languages', value: activeLangs.size },
            { icon: <Zap size={18} />, label: 'Online', value: ollamaStatus?.running ? 'AI Ready' : 'Ollama Off' }
          ].map((stat, i) => (
            <div key={i} className="bg-panel border border-border-soft rounded-xl px-4 py-3 text-center hover:bg-panel-strong transition-colors">
              <div className="text-[#3d6bff] mb-1 flex justify-center">{stat.icon}</div>
              <div className="text-fg-strong text-lg font-bold">{stat.value}</div>
              <div className="text-fg-dim text-xs">{stat.label}</div>
            </div>
          ))}
        </div>

        <div className="flex justify-center gap-4 mb-10">
          <button onClick={onNewChat} className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-[#3d6bff] to-[#6366f1] text-white rounded-xl font-bold text-sm hover:opacity-90 transition-opacity shadow-lg">
            <MessageSquare size={16} /> New Chat
          </button>
          <button onClick={onQuickStart} className="flex items-center gap-2 px-6 py-3 bg-panel border border-border-soft text-fg-muted rounded-xl font-bold text-sm hover:bg-panel-strong transition-colors">
            <BookOpen size={16} /> Quick Start Guide
          </button>
          <button onClick={() => setTourStep(1)} className="flex items-center gap-2 px-6 py-3 bg-panel border border-border-soft text-[#00d4a3] rounded-xl font-bold text-sm hover:bg-panel-strong transition-colors group">
            <Sparkles size={16} className="group-hover:rotate-12 transition-transform" /> Take the Tour
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {latestProjects.map(p => (
            <button key={p.id} onClick={() => onSelectProject(p)} className="bg-panel border border-border-soft rounded-xl p-4 text-left hover:bg-panel-strong hover:border-[#3d6bff]/30 transition-all group">
              <div className="text-xs font-bold text-fg-subtle tracking-wider uppercase mb-1">Project</div>
              <div className="text-sm text-fg-strong font-medium truncate group-hover:text-[#3d6bff] transition-colors">{p.name}</div>
              {p.codebaseIndex && (
                <div className="text-xs text-fg-dim mt-1">{p.codebaseIndex.totalFiles} files · {(p.codebaseIndex.languages || []).slice(0, 2).join(', ')}</div>
              )}
            </button>
          ))}
        </div>
      </div>

      {tourStep > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" onClick={() => setTourStep(0)} />
          <div className="relative z-10 w-full max-w-lg mx-4 bg-overlay border border-border-soft rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-6 pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#00d4a3]/10 rounded-lg text-[#00d4a3]">
                  {TOUR_STEPS[tourStep - 1].icon}
                </div>
                <div className="text-xs text-fg-dim">
                  Step {tourStep} of 4
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
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i === tourStep ? 'bg-[#00d4a3]' : 'bg-panel-strong'}`} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                {tourStep > 1 && (
                  <button onClick={() => setTourStep(s => s - 1)} className="flex items-center gap-1 px-3 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">
                    <ChevronLeft size={14} /> Back
                  </button>
                )}
                {tourStep < 4 ? (
                  <button onClick={() => setTourStep(s => s + 1)} className="flex items-center gap-1.5 px-4 py-2 bg-[#00d4a3]/20 text-[#00d4a3] rounded-lg text-xs font-bold tracking-wider uppercase hover:bg-[#00d4a3]/30 transition-colors">
                    Next <ChevronRight size={14} />
                  </button>
                ) : (
                  <button onClick={() => setTourStep(0)} className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-[#3d6bff] to-[#6366f1] text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity">
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
