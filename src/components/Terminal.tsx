import React, { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { TerminalMessage, Project, AIStatus, PendingToolConfirm, PendingMemorySuggestion, ToolCallEntry } from '../types';
import { getRandomChatPrompt, getRandomEmptyStatePrompt, getEmptyStateActions } from '../utils/greetings';
import { ToolHistoryPanel } from './ToolHistoryPanel';
import { ProcessDock, ProcessInfo } from './ProcessDock';
import { TerminalHeader } from './TerminalHeader';
import { TerminalMessages } from './TerminalMessages';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { TerminalInput } from './TerminalInput';
import { ErrorBoundary } from './ErrorBoundary';
import { Minimize2 } from 'lucide-react';

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

export interface TerminalProps {
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
  // Inline confirm cards in the chat thread (the App-level ConfirmCardsOverlay only
  // renders while a non-chat view is active — see App.tsx).
  onApproveTask?: () => void;
  pendingMemorySuggestion?: PendingMemorySuggestion | null;
  onMemorySuggestionRespond?: (accept: boolean) => void;
  aiEnabled: boolean;
  aiThinking: boolean;
  aiThinkingText?: string;
  commandPending: boolean;
  /** Phase 5: bumped by useConsole after New Chat / session switch — focus the input. */
  focusSignal?: number;
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
  onExportPdf: () => void;
  onExportProjectChatLog: () => void;
  onDirectCommand?: (command: string) => void;
  onDidYouMeanPick?: (intent: string) => void;
  workspaceProjects: Project[];
  addToWorkspace: (project: Project) => void;
  removeFromWorkspace: (projectId: string) => void;
  clearWorkspace: () => void;
  onSwitchToProject?: (projectId: string) => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Feature B (2026-08-14): opens the full Chat History overlay (General/Projects tabs). */
  onOpenChatHistory?: () => void;
  processes?: ProcessInfo[];
  processLogs?: Record<string, string[]>;
  logLoading?: boolean;
  selectedProcessId?: string | null;
  onSelectProcess?: (projectId: string) => void;
  onStopProcess?: (projectId: string) => void;
  dockExpanded?: boolean;
  onToggleDock?: () => void;
  dockTab?: 'logs' | 'projects' | 'history';
  onSetDockTab?: (tab: 'logs' | 'projects' | 'history') => void;
  projects?: Project[];
  /** Phase T (2026-08-14): the tab whose workspace the dock's History tab addresses. */
  tabId?: string | null;
   knownDevUrls: string[];
   connected: boolean;
  /** Phase 6 (2026-08-17): "load earlier" — true while the buffer holds fewer stored
      messages than the session log contains. */
  historyHasMore?: boolean;
  onLoadEarlier?: () => void;
 }

// Audit 2026-08-17: memoize the terminal — it's the heaviest subtree (messages + dock + log
// joins) and App re-renders for unrelated reasons (dashboard polls, deck usage, theme). The
// comparator ignores the five stateless inline lambdas App passes by identity: each is a
// pure `v => !v` / `() => setX(...)` closure with no captured state, so behavior is identical
// across renders. Every other prop is compared by reference — messages/processLogs/knownDevUrls
// only change identity when their data actually changes.
const VOLATILE_MEMO_PROPS = new Set([
  'onToggleFullscreen', 'onToggleToolHistory', 'onOpenChatHistory', 'onToggleDock', 'onSetDockTab',
]);
const terminalAreEqual = (prev: TerminalProps, next: TerminalProps) =>
  (Object.keys(next) as (keyof TerminalProps)[]).every((k) => VOLATILE_MEMO_PROPS.has(k as string) || prev[k] === next[k]);

export const Terminal = memo(function Terminal({ messages, onSendMessage, onSearch, onDeepResearch, activeProject, userName, pendingConfirm, onConfirm, pendingToolConfirm, onToolConfirm, onApproveTask, pendingMemorySuggestion, onMemorySuggestionRespond, aiEnabled, aiThinking, aiThinkingText, commandPending, onCancel, ollamaStatus, aiModel, aiMode, onAIToggle, onSetModel, onSetMode, toolHistory, showToolHistory, onToggleToolHistory, onRerunToolCall, onExportMarkdown, onExportJson, onExportPdf, onExportProjectChatLog, onDirectCommand, onDidYouMeanPick, workspaceProjects, addToWorkspace, removeFromWorkspace, clearWorkspace, onSwitchToProject, isFullscreen, onToggleFullscreen, onOpenChatHistory, processes, processLogs, logLoading, selectedProcessId, onSelectProcess, onStopProcess, dockExpanded, onToggleDock, dockTab, onSetDockTab, projects, tabId, knownDevUrls, connected, focusSignal, historyHasMore, onLoadEarlier }: TerminalProps) {
  const [input, setInput] = useState('');
  const [showSearchOverlay, setShowSearchOverlay] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Phase 5: focus the chat input when useConsole bumps the signal (New Chat, session
  // switch, project pick). Runs after the re-render so the input exists; null-safe when
  // the chat view isn't the active one or AI mode renders a different input.
  useEffect(() => {
    if (focusSignal) inputRef.current?.focus();
  }, [focusSignal]);

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

  const isBlocked = !!pendingConfirm || !!pendingToolConfirm;

  // Audit 2026-08-17: Esc exits chat fullscreen. The window listener is armed only while
  // fullscreen is active; while a confirm card is up, Escape stays owned by the card's own
  // reject handler (the input's keydown handles that) and must not also collapse the view.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pendingConfirm || pendingToolConfirm) return;
      onToggleFullscreen?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen, pendingConfirm, pendingToolConfirm, onToggleFullscreen]);

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
    // 2026-08-12: no active-project gate — without a project the message goes to the server's
    // General pseudo-workspace ('__general__'), so a user can chat before picking a project.
    if (!input.trim() || isBlocked) return;
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
         onOpenChatHistory={onOpenChatHistory}
         ollamaStatus={ollamaStatus}
         workspaceProjects={workspaceProjects}
         removeFromWorkspace={removeFromWorkspace}
         clearWorkspace={clearWorkspace}
         onExportMarkdown={onExportMarkdown}
         onExportJson={onExportJson}
         onExportPdf={onExportPdf}
         onExportProjectChatLog={onExportProjectChatLog}
         toolHistory={toolHistory}
         showToolHistory={showToolHistory}
         onToggleToolHistory={onToggleToolHistory}
         connected={connected}
       />

      <ErrorBoundary>
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
          historyHasMore={historyHasMore}
          onLoadEarlier={onLoadEarlier}
        />
      </ErrorBoundary>

      {/* Audit 2026-08-17: slim always-visible exit affordance while fullscreen — the header's
          Minimize button is up top, this sits at the thread's top-right corner so the way out
          is never more than a glance away. */}
      {isFullscreen && onToggleFullscreen && (
        <button
          onClick={onToggleFullscreen}
          className="absolute top-12 right-3 z-40 flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-bold tracking-wider uppercase text-fg-dim hover:text-fg-strong bg-scrim-faint border border-border-soft rounded-lg transition-colors"
          title="Exit fullscreen (Esc)"
        >
          <Minimize2 size={11} /> Exit fullscreen
        </button>
      )}

      <ToolHistoryPanel toolHistory={toolHistory} show={showToolHistory} onToggle={onToggleToolHistory} onRerun={onRerunToolCall} />

      <ErrorBoundary>
        <ProcessDock
          processes={processes || []}
          processLogs={processLogs || {}}
          logLoading={logLoading}
          selectedProcessId={selectedProcessId || null}
          onSelectProcess={(pid) => onSelectProcess?.(pid)}
          onStopProcess={(pid) => onStopProcess?.(pid)}
          expanded={!!dockExpanded}
          onToggleExpanded={() => onToggleDock?.()}
          dockTab={dockTab || 'logs'}
          onSetDockTab={onSetDockTab}
          projects={projects || []}
          activeProjectId={activeProject?.id || null}
          onSendMessage={onSendMessage}
          tabId={tabId}
        />
      </ErrorBoundary>

      <TerminalInput
        centerCol={centerCol}
        aiEnabled={aiEnabled}
        aiThinking={aiThinking}
        commandPending={commandPending}
        isBlocked={isBlocked}
        ollamaStatus={ollamaStatus}
         aiModel={aiModel}
         aiMode={aiMode}
         connected={connected}
         onAIToggle={onAIToggle}
        onSetModel={onSetModel}
        onSetMode={onSetMode}
        chatPrompt={chatPrompt}
        input={input}
        onInputChange={(value) => { setInput(value); resetTab(); }}
        onInputKeyDown={handleInputKeyDown}
        onSubmit={handleSubmit}
        inputRef={inputRef}
        onAISend={(text) => { pushHistory(text); onSendMessage(text); setInput(''); }}
        onSearch={onSearch}
        onDeepResearch={onDeepResearch}
        getHistory={() => commandHistory.current}
      />

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
}, terminalAreEqual);
