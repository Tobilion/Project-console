import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { TerminalMessage, Project, AIStatus, PendingToolConfirm, PendingMemorySuggestion, ToolCallEntry } from '../types';
import { Send, Brain } from 'lucide-react';
import { AIAssistantInterface } from './ui/AIAssistantInterface';
import { getRandomChatPrompt, getRandomEmptyStatePrompt, getEmptyStateActions } from '../utils/greetings';
import { ToolHistoryPanel } from './ToolHistoryPanel';
import { ProcessDock, ProcessInfo } from './ProcessDock';
import { TerminalHeader } from './TerminalHeader';
import { TerminalMessages } from './TerminalMessages';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';

const MAX_HISTORY = 200;

const KNOWN_COMMANDS = [
  'help', 'overview', 'describe', 'tech stack', 'gotchas', 'architecture',
  'project structure', 'entry point', 'how many files',
  'run tests', 'show dependencies', 'show config',
  'git status', 'git commit', 'git push', 'git pull', 'git log', 'git branch',
  'git init', 'git add', 'deploy', 'push live', 'commit and push',
  'run the site', 'run the project', 'run dev',
  'where is the link', 'stop server', 'kill server',
  'npx serve .', 'python -m http.server',
  'explain more', 'undo', 'clear',
  'npm install', 'npm run build', 'npm run dev', 'npm start',
  'review learning', 'check learning', 'approve suggestions',
  'telemetry review', 'telemetry stats', 'telemetry suggest',
  'telemetry auto-apply', 'check collisions',
  'review distillations', 'apply distillation',
  'review memory', 'project memory', 'telemetry clear',
];

interface TerminalProps {
  messages: TerminalMessage[];
  onSendMessage: (msg: string) => void;
  onSearch?: (query: string) => void;
  onDeepResearch?: (query: string) => void;
  activeProject: Project | null;
  userName?: string;
  pendingConfirm: { token: string; command: string } | null;
  onConfirm: (confirmed: boolean) => void;
  pendingToolConfirm: PendingToolConfirm | null;
  onToolConfirm: (confirmed: boolean) => void;
  onApproveTask?: () => void;
  pendingMemorySuggestion?: PendingMemorySuggestion | null;
  onMemorySuggestionRespond?: (accept: boolean) => void;
  aiEnabled: boolean;
  aiThinking: boolean;
  aiThinkingText?: string;
  commandPending: boolean;
  onCancel?: () => void;
  ollamaStatus: AIStatus | null;
  aiModel: string;
  aiMode: string;
  onAIToggle: () => void;
  onSetModel: (model: string) => void;
  onSetMode: (mode: string) => void;
  toolHistory: ToolCallEntry[];
  showToolHistory: boolean;
  onToggleToolHistory: () => void;
  onRerunToolCall: (entry: ToolCallEntry) => void;
  onExportMarkdown: () => void;
  onExportJson: () => void;
  onDirectCommand?: (command: string) => void;
  onDidYouMeanPick?: (intent: string) => void;
  workspaceProjects: Project[];
  addToWorkspace: (project: Project) => void;
  removeFromWorkspace: (projectId: string) => void;
  clearWorkspace: () => void;
  onSwitchToProject?: (projectId: string) => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  processes?: ProcessInfo[];
  processLogs?: Record<string, string[]>;
  selectedProcessId?: string | null;
  onSelectProcess?: (projectId: string) => void;
  onStopProcess?: (projectId: string) => void;
  dockExpanded?: boolean;
  onToggleDock?: () => void;
  dockTab?: 'logs' | 'projects';
  onSetDockTab?: (tab: 'logs' | 'projects') => void;
  projects?: Project[];
  knownDevUrls: string[];
}

const AI_MODES = [
  { value: 'default', label: 'General' },
  { value: 'coding', label: 'Coding' },
  { value: 'tutor', label: 'Tutor' },
  { value: 'creative', label: 'Creative' },
  { value: 'consultant', label: 'Consultant' },
  { value: 'structured', label: 'Structured' }
];

export const Terminal = ({ messages, onSendMessage, onSearch, onDeepResearch, activeProject, userName, pendingConfirm, onConfirm, pendingToolConfirm, onToolConfirm, onApproveTask, pendingMemorySuggestion, onMemorySuggestionRespond, aiEnabled, aiThinking, aiThinkingText, commandPending, onCancel, ollamaStatus, aiModel, aiMode, onAIToggle, onSetModel, onSetMode, toolHistory, showToolHistory, onToggleToolHistory, onRerunToolCall, onExportMarkdown, onExportJson, onDirectCommand, onDidYouMeanPick, workspaceProjects, addToWorkspace, 
removeFromWorkspace, clearWorkspace, onSwitchToProject, isFullscreen, onToggleFullscreen, processes, processLogs, 
selectedProcessId, onSelectProcess, onStopProcess, dockExpanded, onToggleDock, dockTab, onSetDockTab, projects, knownDevUrls }: TerminalProps) => {
  const [input, setInput] = useState('');
  const [showSearchOverlay, setShowSearchOverlay] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Command history
  const commandHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const savedInput = useRef('');
  const storageKey = `lpc:history:${activeProject?.id || 'global'}`;
  // Random personalized input placeholder; re-rolls on profile name change or project switch.
  const chatPrompt = useMemo(() => getRandomChatPrompt(userName || 'there'), [userName, activeProject?.id]);
  // Centered empty-thread greeting + quick actions; re-rolls per project/chat, gone on first send.
  const emptyStatePrompt = useMemo(() => getRandomEmptyStatePrompt(userName || 'there'), [userName, activeProject?.id]);
  const emptyStateActions = useMemo(() => getEmptyStateActions(activeProject), [activeProject]);

  const loadHistory = useCallback(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          commandHistory.current = parsed.slice(-MAX_HISTORY);
        }
      }
    } catch { /* ignore corrupt data */ }
    historyIndex.current = -1;
    setHistoryVersion(v => v + 1);
  }, [storageKey]);

  const saveHistory = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(commandHistory.current));
    } catch { /* quota exceeded, ignore */ }
  }, [storageKey]);

  const pushHistory = useCallback((cmd: string) => {
    if (!cmd.trim()) return;
    commandHistory.current = [...commandHistory.current.filter(c => c !== cmd), cmd];
    if (commandHistory.current.length > MAX_HISTORY) {
      commandHistory.current = commandHistory.current.slice(-MAX_HISTORY);
    }
    historyIndex.current = -1;
    saveHistory();
  }, [saveHistory]);

  const navigateHistory = useCallback((direction: 'up' | 'down') => {
    if (commandHistory.current.length === 0) return;
    if (direction === 'up') {
      if (historyIndex.current === -1) {
        savedInput.current = input;
      }
      if (historyIndex.current < commandHistory.current.length - 1) {
        historyIndex.current++;
        setInput(commandHistory.current[commandHistory.current.length - 1 - historyIndex.current]);
      }
    } else {
      if (historyIndex.current > 0) {
        historyIndex.current--;
        setInput(commandHistory.current[commandHistory.current.length - 1 - historyIndex.current]);
      } else {
        historyIndex.current = -1;
        setInput(savedInput.current);
      }
    }
  }, [input]);

  // Tab completion
  const [tabIndex, setTabIndex] = useState(-1);
  const [tabBase, setTabBase] = useState('');

  const getCompletions = useCallback((value: string): string[] => {
    if (!value.trim()) return [];
    const lower = value.toLowerCase();
    return KNOWN_COMMANDS.filter(c => c.startsWith(lower) && c !== lower);
  }, []);

  const handleTabComplete = useCallback(() => {
    if (!input.trim()) return;
    const completions = getCompletions(input);
    if (completions.length === 0) return;
    const nextIdx = tabIndex + 1 >= completions.length ? 0 : tabIndex + 1;
    setTabIndex(nextIdx);
    setInput(completions[nextIdx]);
  }, [input, tabIndex, getCompletions]);

  const resetTab = useCallback(() => {
    setTabIndex(-1);
    setTabBase('');
  }, []);

  // Filtered history for Ctrl+R
  const filteredHistory = useMemo(() => {
    if (!searchQuery.trim()) return commandHistory.current.slice().reverse();
    const q = searchQuery.toLowerCase();
    return commandHistory.current.filter(c => c.toLowerCase().includes(q)).reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, historyVersion]);

  // Load/save history on project change
  const isFirstRender = useRef(true);
  useEffect(() => {
    loadHistory();
    if (!isFirstRender.current) {
      // Reset cursor position when switching projects
      historyIndex.current = -1;
      savedInput.current = '';
    }
    isFirstRender.current = false;
  }, [loadHistory]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingConfirm, pendingToolConfirm, pendingMemorySuggestion]);

  const isBlocked = !!pendingConfirm || !!pendingToolConfirm;

  // Full-screen mode centers the whole chat column (thread + input) so bubbles never stretch
  // across a wide monitor — Claude/ChatGPT-style readable column. Non-fullscreen is untouched.
  const centerCol = isFullscreen ? 'mx-auto w-full max-w-3xl' : '';

  // Keyboard handler for the main input
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && (pendingConfirm || pendingToolConfirm)) {
      if (pendingConfirm) onConfirm(false);
      if (pendingToolConfirm) onToolConfirm(false);
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      e.preventDefault();
      navigateHistory('up');
    } else if (e.key === 'ArrowDown' && !e.shiftKey) {
      e.preventDefault();
      navigateHistory('down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      handleTabComplete();
    } else if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!activeProject) return;
      setSearchQuery('');
      setShowSearchOverlay(true);
    } else {
      resetTab();
    }
  }, [navigateHistory, handleTabComplete, resetTab, activeProject, pendingConfirm, pendingToolConfirm, onConfirm, onToolConfirm]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !activeProject || isBlocked) return;
    pushHistory(input);
    onSendMessage(input);
    setInput('');
    resetTab();
  };

  const handleSearchOverlaySelect = (cmd: string) => {
    setInput(cmd);
    setShowSearchOverlay(false);
    setSearchQuery('');
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full bg-overlay/80 backdrop-blur-md rounded-2xl border border-border-soft relative">
      <TerminalHeader
        activeProject={activeProject}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        ollamaStatus={ollamaStatus}
        workspaceProjects={workspaceProjects}
        removeFromWorkspace={removeFromWorkspace}
        clearWorkspace={clearWorkspace}
        onExportMarkdown={onExportMarkdown}
        onExportJson={onExportJson}
        toolHistory={toolHistory}
        showToolHistory={showToolHistory}
        onToggleToolHistory={onToggleToolHistory}
      />
      
      <TerminalMessages
        messages={messages}
        centerCol={centerCol}
        isBlocked={isBlocked}
        onSendMessage={onSendMessage}
        onDirectCommand={onDirectCommand}
        onSwitchToProject={onSwitchToProject}
        aiMode={aiMode}
        endRef={endRef}
        aiThinking={aiThinking}
        aiThinkingText={aiThinkingText}
        commandPending={commandPending}
        onCancel={onCancel}
        pendingConfirm={pendingConfirm}
        onConfirm={onConfirm}
        pendingToolConfirm={pendingToolConfirm}
        onToolConfirm={onToolConfirm}
        onApproveTask={onApproveTask}
        pendingMemorySuggestion={pendingMemorySuggestion}
        onMemorySuggestionRespond={onMemorySuggestionRespond}
        emptyStatePrompt={emptyStatePrompt}
        emptyStateActions={emptyStateActions}
        onDidYouMeanPick={onDidYouMeanPick}
        knownDevUrls={knownDevUrls}
      />

      <ToolHistoryPanel toolHistory={toolHistory} show={showToolHistory} onToggle={onToggleToolHistory} onRerun={onRerunToolCall} />

      <ProcessDock
        processes={processes || []}
        processLogs={processLogs || {}}
        selectedProcessId={selectedProcessId || null}
        onSelectProcess={(pid) => onSelectProcess?.(pid)}
        onStopProcess={(pid) => onStopProcess?.(pid)}
        expanded={!!dockExpanded}
        onToggleExpanded={() => onToggleDock?.()}
        dockTab={dockTab || 'logs'}
        onSetDockTab={onSetDockTab}
        projects={projects || []}
      />

      {ollamaStatus && (
        <div className={`${centerCol} flex items-center gap-2 px-4 py-1.5 bg-panel border-t border-border-soft flex-wrap`}>
          <button onClick={onAIToggle} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors border flex-shrink-0 ${aiEnabled ? 'bg-teal-500/20 border-teal-500/40 text-teal-300' : 'bg-panel border-border-soft text-fg-dim hover:text-fg-muted'}`}>
            <Brain size={13} />
            <span>AI {aiEnabled ? 'ON' : 'OFF'}</span>
          </button>
          {aiEnabled && ((ollamaStatus.models?.length ?? 0) > 0 || (ollamaStatus.cloudModels?.length ?? 0) > 0) && (
            <>
              <select
                value={aiModel}
                onChange={(e) => onSetModel(e.target.value)}
                title={ollamaStatus.cloudModels?.some(m => m.name === aiModel) ? 'Running on Ollama Cloud — needs internet + `ollama signin`' : 'Running locally'}
                className="bg-surface border border-border-soft rounded-md px-1.5 py-1 text-[11px] text-fg-muted focus:outline-none focus:border-teal-500/40 flex-shrink-0 max-w-[220px]"
              >
                {(ollamaStatus.models?.length ?? 0) > 0 && (
                  <optgroup label="Local (offline)">
                    {ollamaStatus.models.map((m: any) => (
                      <option key={m.name} value={m.name}>{m.name}</option>
                    ))}
                  </optgroup>
                )}
                {(ollamaStatus.cloudModels?.length ?? 0) > 0 && (
                  <optgroup label="Ollama Cloud (needs sign-in + internet)">
                    {ollamaStatus.cloudModels!.map((m) => (
                      <option key={m.name} value={m.name}>{m.label}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <select
                value={aiMode}
                onChange={(e) => onSetMode(e.target.value)}
                className="bg-surface border border-border-soft rounded-md px-1.5 py-1 text-[11px] text-fg-muted focus:outline-none focus:border-teal-500/40 flex-shrink-0"
              >
                {AI_MODES.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </>
          )}
        </div>
      )}

      {aiEnabled ? (
        <div className={`${centerCol} p-3 bg-panel border-t border-border-soft`}>
          <AIAssistantInterface onSend={(text) => { pushHistory(text); onSendMessage(text); setInput(''); }} onSearch={(q) => { onSearch?.(q); }} onDeepResearch={(q) => { onDeepResearch?.(q); }} disabled={!activeProject || aiThinking || isBlocked} placeholder={isBlocked ? 'Resolve the pending confirmation first (Esc to cancel)...' : aiThinking ? 'AI is thinking...' : chatPrompt} getHistory={() => commandHistory.current} />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className={`${centerCol} p-4 bg-panel border-t border-border-soft`}>
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => { setInput(e.target.value); resetTab(); }}
              onKeyDown={handleInputKeyDown}
              disabled={!activeProject || aiThinking || commandPending}
              placeholder={!activeProject ? "Select a project to start..." : aiThinking ? "AI is thinking..." : commandPending ? "Running..." : chatPrompt}
              className="w-full bg-surface border border-border-soft rounded-xl py-3 pl-4 pr-12 text-fg text-sm focus:outline-none focus:border-[#3d6bff] transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || !activeProject || aiThinking || commandPending || isBlocked}
              title={isBlocked ? 'Resolve the pending confirmation first (Esc to cancel)' : undefined}
              className="absolute right-2 p-2 text-fg-subtle hover:text-[#00d4a3] disabled:opacity-50 transition-colors"
            >
              <Send size={18} />
            </button>
          </div>
        </form>
      )}

      <TerminalSearchOverlay
        show={showSearchOverlay}
        isFullscreen={isFullscreen}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onClose={() => { setShowSearchOverlay(false); setSearchQuery(''); inputRef.current?.focus(); }}
        onSelect={handleSearchOverlaySelect}
        history={filteredHistory}
        inputRef={inputRef}
      />
    </div>
  );
};
