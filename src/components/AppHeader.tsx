// The top app header (2026-08-24, split out of App.tsx): brand, Developer/General pill,
// live-server/port badges, the view toggles (Home / Ctrl+K / Command reference / Dashboard /
// Tools / Settings / Tours / theme), and the hidden folder-picker input. Pure props — no
// state lives here.

import React from 'react';
import { Home, LayoutDashboard, LayoutGrid, Search, Settings, Loader2, BookOpen, HelpCircle } from 'lucide-react';
import { TextScramble } from './TextScramble';
import { ThemeToggle } from './ui/ThemeToggle';

export interface AppHeaderProps {
  workspaceTab: 'dev' | 'general';
  onWorkspaceTabChange: (mode: 'dev' | 'general') => void;
  activeServersCount: number;
  indexingProjectId: string | null;
  showCommandRef: boolean;
  toolsOpen: boolean;
  showDashboard: boolean;
  onHome: () => void;
  onToggleDeck: () => void;
  onToggleCommandRef: () => void;
  onToggleDashboard: () => void;
  onToggleTools: () => void;
  onOpenProfile: () => void;
  onOpenTourPicker: () => void;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  onFolderPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function AppHeader(props: AppHeaderProps) {
  const {
    workspaceTab, onWorkspaceTabChange, activeServersCount, indexingProjectId,
    showCommandRef, toolsOpen, showDashboard,
    onHome, onToggleDeck, onToggleCommandRef, onToggleDashboard, onToggleTools,
    onOpenProfile, onOpenTourPicker, folderInputRef, onFolderPick,
  } = props;

  return (
    <header className="relative z-10 flex-shrink-0 flex items-center gap-3 h-[52px] px-6 bg-background border-b border-border-faint">
      <div className="flex items-center gap-3 min-w-0">
        <h1 className="text-[18px] leading-6 font-semibold italic text-fg-strong whitespace-nowrap">
          <TextScramble text="Project Console" />
        </h1>
        <p className="text-caption tracking-[0.2em] uppercase text-fg-dim font-bold hidden sm:inline">
          Local Project Engine
        </p>
        {indexingProjectId && (
          <span className="text-xs text-accent-orange animate-pulse"><Loader2 size={12} className="inline-block mr-1 animate-spin" />Indexing...</span>
        )}
      </div>
      <div className="flex items-center gap-2 ml-auto flex-shrink-0">
        <div className="flex items-center gap-1 bg-overlay rounded-full p-1 border border-border-faint">
          <button
            onClick={() => onWorkspaceTabChange('dev')}
            className={`px-3 py-1 text-xs rounded-full transition-colors ${workspaceTab === 'dev' ? 'bg-accent-blue text-white' : 'text-fg-dim hover:text-fg-strong'}`}
            title="Developer workspace — git/npm/run/diagnostics suggestions"
          >
            Developer
          </button>
          <button
            onClick={() => onWorkspaceTabChange('general')}
            className={`px-3 py-1 text-xs rounded-full transition-colors ${workspaceTab === 'general' ? 'bg-accent-blue text-white' : 'text-fg-dim hover:text-fg-strong'}`}
            title="General workspace — file tools, notes, reminders, PDF tools"
          >
            General
          </button>
        </div>
        {activeServersCount > 0 && (
          <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-accent-green bg-accent-green/10 rounded-lg border border-accent-green/20 whitespace-nowrap flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-green inline-block animate-pulse" />
            {activeServersCount} running
          </span>
        )}
        {window.location.port && (
          <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-strong font-mono bg-scrim-faint rounded-lg border border-border-soft whitespace-nowrap flex-shrink-0"
            title={`Console running at http://${window.location.hostname}:${window.location.port}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block animate-pulse" />
            :{window.location.port}
          </span>
        )}
        <button onClick={onHome} className="p-3 text-fg-dim hover:text-fg-strong transition-colors" title="Home">
          <Home size={18} />
        </button>
        <button onClick={onToggleDeck} className="p-3 text-fg-dim hover:text-fg-strong transition-colors" title="Command deck (Ctrl+K)">
          <Search size={18} />
        </button>
        <button onClick={onToggleCommandRef} className={`p-3 transition-colors ${showCommandRef ? 'text-accent-blue' : 'text-fg-dim hover:text-fg-strong'}`} title="Command reference (all commands)">
          <BookOpen size={18} />
        </button>
        <button onClick={onToggleDashboard} className={`p-3 transition-colors ${showDashboard ? 'text-accent-blue' : 'text-fg-dim hover:text-fg-strong'}`} title="Dashboard">
          <LayoutDashboard size={18} />
        </button>
        {/* Stage B: the Tools icon is visible in BOTH Developer and General modes — a
            functional fix, not just visual (the panels were previously General-only). */}
        <button data-tour="tools-button" onClick={onToggleTools} className={`p-3 transition-colors ${toolsOpen ? 'text-accent-blue' : 'text-fg-dim hover:text-fg-strong'}`} title="Interactive tools">
          <LayoutGrid size={18} />
        </button>
        <button data-tour="settings-button" onClick={onOpenProfile} className="p-3 text-fg-dim hover:text-fg-strong transition-colors" title="User profile">
          <Settings size={18} />
        </button>
        <button onClick={onOpenTourPicker} className="p-3 text-fg-dim hover:text-fg-strong transition-colors" title="Help — walkthroughs & tours">
          <HelpCircle size={18} />
        </button>
        <ThemeToggle />
      </div>
      <input
        ref={folderInputRef}
        type="file"
        onChange={onFolderPick}
        className="hidden"
        /* @ts-ignore */
        webkitdirectory=""
        directory=""
      />
    </header>
  );
}