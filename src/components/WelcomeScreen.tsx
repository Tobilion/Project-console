import React from 'react';
import { TextScramble } from './TextScramble';
import { GlowOrbs } from './GlowOrbs';
import { Project, AIStatus } from '../types';
import { FolderSearch, MessageSquare, Brain, Cpu, HardDrive, Code, Zap, BookOpen } from 'lucide-react';

interface WelcomeScreenProps {
  projects: Project[];
  ollamaStatus: AIStatus | null;
  aiEnabled: boolean;
  onAIToggle: () => void;
  onSelectProject: (p: Project) => void;
  onNewChat: () => void;
  onQuickStart: () => void;
}

export function WelcomeScreen({ projects, ollamaStatus, aiEnabled, onAIToggle, onSelectProject, onNewChat, onQuickStart }: WelcomeScreenProps) {
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
          <h1 className="text-5xl md:text-7xl font-serif italic text-white mb-4">
            <TextScramble text="Welcome Master Tobi" />
          </h1>
          <p className="text-sm tracking-[0.2em] uppercase text-gray-500 font-bold">
            V4 Knowledge Engine — {projects.length} Projects Loaded
          </p>
        </div>

        {ollamaStatus && (
          <div className="flex justify-center gap-4 mb-10">
            <button onClick={onAIToggle} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-mono transition-all border ${aiEnabled ? 'bg-teal-500/20 border-teal-500/40 text-teal-300 shadow-lg shadow-teal-500/10' : 'bg-white/5 border-white/10 text-gray-400 hover:text-gray-200'}`}>
              <Brain size={16} />
              AI Assistant — {aiEnabled ? 'ON' : 'OFF'}
            </button>
            {ollamaStatus.models?.length > 0 && (
              <span className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-xs text-gray-500 font-mono">
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
            <div key={i} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-center hover:bg-white/10 transition-colors">
              <div className="text-[#3d6bff] mb-1 flex justify-center">{stat.icon}</div>
              <div className="text-white text-lg font-bold font-mono">{stat.value}</div>
              <div className="text-gray-500 text-xs">{stat.label}</div>
            </div>
          ))}
        </div>

        <div className="flex justify-center gap-4 mb-10">
          <button onClick={onNewChat} className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-[#3d6bff] to-[#6366f1] text-white rounded-xl font-bold text-sm hover:opacity-90 transition-opacity shadow-lg">
            <MessageSquare size={16} /> New Chat
          </button>
          <button onClick={onQuickStart} className="flex items-center gap-2 px-6 py-3 bg-white/5 border border-white/10 text-gray-300 rounded-xl font-bold text-sm hover:bg-white/10 transition-colors">
            <BookOpen size={16} /> Quick Start Guide
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {latestProjects.map(p => (
            <button key={p.id} onClick={() => onSelectProject(p)} className="bg-white/5 border border-white/10 rounded-xl p-4 text-left hover:bg-white/10 hover:border-[#3d6bff]/30 transition-all group">
              <div className="text-xs font-bold text-gray-400 tracking-wider uppercase mb-1">Project</div>
              <div className="text-sm text-white font-medium truncate group-hover:text-[#3d6bff] transition-colors">{p.name}</div>
              {p.codebaseIndex && (
                <div className="text-xs text-gray-500 mt-1">{p.codebaseIndex.totalFiles} files · {(p.codebaseIndex.languages || []).slice(0, 2).join(', ')}</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
