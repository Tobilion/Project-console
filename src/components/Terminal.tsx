import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { TerminalMessage, Project, AIStatus, PendingToolConfirm, PendingMemorySuggestion, ToolCallEntry } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { Terminal as TerminalIcon, Send, Search, CheckCircle, XCircle, Brain, Loader2, History, FileDown, ListChecks, Download, Square, Maximize2, Minimize2, AlertTriangle, Settings } from 'lucide-react';
import { AIAssistantInterface } from './ui/AIAssistantInterface';
import { ToolHistoryPanel } from './ToolHistoryPanel';
import { ProcessDock, ProcessInfo } from './ProcessDock';
import { OutputBlock } from './TerminalOutputBlock';
import { StructuredJsonBlock } from './StructuredJsonBlock';

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
}

/** The server appends a performance note to the end of streamed AI replies (see
 * server/ollama.js chatStream): `\n\n_(2.0s, 9 tok/s)_`. Strip it from the rendered
 * markdown and surface it as a muted footer below the response block instead. */
const TELEMETRY_RE = /\n\n_\(([\d.]+s, \d+ tok\/s)\)_$/;
function splitTelemetry(content: string): { body: string; meta: string | null } {
  const m = content.match(TELEMETRY_RE);
  if (!m) return { body: content, meta: null };
  return { body: content.slice(0, content.length - m[0].length), meta: m[1] };
}

const AI_MODES = [
  { value: 'default', label: 'General' },
  { value: 'coding', label: 'Coding' },
  { value: 'tutor', label: 'Tutor' },
  { value: 'creative', label: 'Creative' },
  { value: 'consultant', label: 'Consultant' },
  { value: 'structured', label: 'Structured' }
];

export const Terminal = ({ messages, onSendMessage, onSearch, onDeepResearch, activeProject, pendingConfirm, onConfirm, pendingToolConfirm, onToolConfirm, onApproveTask, pendingMemorySuggestion, onMemorySuggestionRespond, aiEnabled, aiThinking, aiThinkingText, commandPending, onCancel, ollamaStatus, aiModel, aiMode, onAIToggle, onSetModel, onSetMode, toolHistory, showToolHistory, onToggleToolHistory, onRerunToolCall, onExportMarkdown, onExportJson, onDirectCommand, workspaceProjects, addToWorkspace, removeFromWorkspace, clearWorkspace, onSwitchToProject, isFullscreen, onToggleFullscreen, processes, processLogs, selectedProcessId, onSelectProcess, onStopProcess, dockExpanded, onToggleDock }: TerminalProps) => {
  const [input, setInput] = useState('');
  const [showSearchOverlay, setShowSearchOverlay] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Command history
  const commandHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const savedInput = useRef('');
  const storageKey = `lpc:history:${activeProject?.id || 'global'}`;

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

  useEffect(() => {
    if (showSearchOverlay && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearchOverlay]);

  const isBlocked = !!pendingConfirm || !!pendingToolConfirm;

  // Full-screen mode centers the whole chat column (thread + input) so bubbles never stretch
  // across a wide monitor — Claude/ChatGPT-style readable column. Non-fullscreen is untouched.
  const centerCol = isFullscreen ? 'mx-auto w-full max-w-3xl' : '';

  // Custom markdown components for structured JSON blocks
  const markdownComponents = useMemo(() => ({
    code({ className, children, ...props }: any) {
      const isJson = className === 'language-json' || className === 'language-js';
      if (isJson && aiMode === 'structured') {
        const text = String(children).replace(/\n$/, '');
        return <StructuredJsonBlock content={text} onSendMessage={onSendMessage} />;
      }
      return <code className={className} {...props}>{children}</code>;
    }
  }), [aiMode, onSendMessage]);

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
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border-soft bg-panel flex-wrap">
        <TerminalIcon size={18} className="text-[#3d6bff]" />
        <span className="text-sm text-fg-muted flex-1">
          {activeProject ? `Connected: ${activeProject.name}` : 'No Project Selected'}
        </span>
        {onToggleFullscreen && (
          <button onClick={onToggleFullscreen} className="p-1.5 text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen chat'}>
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
        {ollamaStatus && (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {workspaceProjects.length > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-panel border border-border-soft">
                <span className="text-[10px] text-fg-dim">Workspace:</span>
                {workspaceProjects.map((p) => (
                  <span key={p.id} className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#3d6bff]/10 border border-[#3d6bff]/30 text-xs text-[#3d6bff]">
                    {p.name}
                    <button onClick={() => removeFromWorkspace(p.id)} className="text-[#3d6bff]/60 hover:text-[#3d6bff] transition-colors">×</button>
                  </span>
                ))}
                <button onClick={clearWorkspace} className="text-fg-faint hover:text-red-400 transition-colors text-xs" title="Clear workspace">×</button>
              </div>
            )}
            <div className="flex items-center gap-1">
              <button onClick={onExportMarkdown} className="p-1.5 text-fg-dim hover:text-fg-strong transition-colors" title="Export session as Markdown">
                <Download size={14} />
              </button>
              <button onClick={onExportJson} className="p-1.5 flex items-center gap-0.5 text-fg-dim hover:text-teal-400 transition-colors" title="Export session as JSON">
                <Download size={11} /><span className="text-[9px]">JSON</span>
              </button>
            </div>
            <button onClick={onToggleToolHistory} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors border ${showToolHistory ? 'bg-[#3d6bff]/20 border-[#3d6bff]/40 text-[#3d6bff]' : 'bg-panel border-border-soft text-fg-dim hover:text-fg-muted'}`} title="Tool Call History">
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
                  <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border-soft rounded-lg shadow-2xl py-1 min-w-[200px]">
                    <button onClick={() => { setShowSessionMenu(false); onExportMarkdown(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                      <Download size={12} /> Export as Markdown
                    </button>
                    <button onClick={() => { setShowSessionMenu(false); onExportJson(); }} className="w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:bg-panel flex items-center gap-2 transition-colors">
                      <FileDown size={12} /> Export as JSON
                    </button>
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
      
      <div className="flex-1 overflow-y-auto p-4">
        <div className={`${centerCol} space-y-3`}>
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => {
            if (msg.type === 'output') {
              return (
                <motion.div
                  key={msg.id || i}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col items-start max-w-[85%]"
                >
                  <OutputBlock content={msg.content} />
                </motion.div>
              );
            }
            const tel = splitTelemetry(msg.content);
            return (
            <motion.div
              key={msg.id || i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex flex-col ${msg.type === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-5 py-3 ${
                  msg.type === 'user' 
                    ? 'bg-[#3d6bff] text-white rounded-br-none' 
                    : msg.type === 'error'
                    ? 'bg-red-500/10 border border-red-500/20 text-red-400 rounded-bl-none font-mono text-sm'
                    : msg.type === 'warning'
                    ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-bl-none'
                    : 'bg-panel border border-border-soft text-fg rounded-bl-none'
                }`}
              >
                {msg.type === 'warning' ? (
                   <div className="flex items-start gap-2">
                     <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                     <div className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</div>
                   </div>
                ) : msg.type === 'user' || !msg.isMarkdown ? (
                   <div className="whitespace-pre-wrap text-sm leading-relaxed">{tel.body}</div>
                ) : (
                   <>
                     <div className="prose prose-sm max-w-none prose-pre:bg-scrim prose-pre:border prose-pre:border-border-soft prose-pre:p-0 prose-p:leading-relaxed">
                       <ReactMarkdown components={markdownComponents}>{tel.body}</ReactMarkdown>
                     </div>
                     {tel.meta && (
                       <div className="mt-2 text-xs font-mono text-fg-dim">{tel.meta}</div>
                     )}
                   </>
                )}
                
                {msg.suggestions && msg.suggestions.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-border-soft">
                    <p className="text-xs text-fg-dim mb-2">SUGGESTIONS:</p>
                    <div className="flex flex-wrap gap-2">
                      {msg.suggestions.map((sug, idx) => (
                        <button
                          key={idx}
                          onClick={() => {
                            if (!isBlocked) {
                              if (onDirectCommand && /^(npm|npx|python|node|git)\s/.test(sug)) {
                                onDirectCommand(sug);
                              } else {
                                onSendMessage(sug);
                              }
                            }
                          }}
                          className="px-3 py-1 rounded-full bg-panel hover:bg-panel-strong border border-border-soft text-xs text-[#00d4a3] transition-colors"
                        >
                          {sug}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {msg.switchProjectAction && onSwitchToProject && (
                  <div className="mt-3 pt-3 border-t border-red-500/20">
                    <button
                      onClick={() => onSwitchToProject(msg.switchProjectAction!.projectId)}
                      className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-xs text-red-300 transition-colors"
                    >
                      Switch to "{msg.switchProjectAction.projectName}"
                    </button>
                  </div>
                )}
              </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {pendingConfirm && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-start"
          >
            <div className="bg-orange-500/10 border border-orange-500/20 text-orange-200 rounded-xl px-4 py-3 max-w-[85%]">
              <div className="flex items-center gap-2 text-orange-400">
                <Search size={13} />
                <span className="font-bold text-[10px] tracking-wider uppercase">Safety Confirmation</span>
              </div>
              <p className="font-mono text-xs mt-2">
                Execute: <span className="text-fg-strong bg-scrim px-1.5 py-0.5 rounded border border-border-soft break-all">{pendingConfirm.command}</span>
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  onClick={() => onConfirm(true)}
                  className="flex items-center gap-1.5 px-3 py-1 bg-red-500/20 hover:bg-red-500/40 text-red-400 rounded-md border border-red-500/30 transition-colors text-xs font-bold"
                >
                  <CheckCircle size={13} /> Execute
                </button>
                <button
                  onClick={() => onConfirm(false)}
                  className="flex items-center gap-1.5 px-3 py-1 bg-panel hover:bg-panel-strong text-fg-muted rounded-md border border-border-soft transition-colors text-xs"
                >
                  <XCircle size={13} /> Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {pendingToolConfirm && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-start"
          >
            <div className="bg-orange-500/10 border border-orange-500/20 text-orange-200 rounded-xl px-4 py-3 max-w-[85%]">
              <div className="flex items-center gap-2 text-orange-400">
                <Brain size={13} />
                <span className="font-bold text-[10px] tracking-wider uppercase">AI wants to run: {pendingToolConfirm.tool}</span>
              </div>
              <pre className="font-mono text-xs mt-2 mb-3 whitespace-pre-wrap break-all bg-scrim px-2 py-1.5 rounded border border-border-soft text-fg-muted max-h-32 overflow-y-auto">
                {JSON.stringify(pendingToolConfirm.args, null, 2)}
              </pre>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => onToolConfirm(true)}
                  className="flex items-center gap-1.5 px-3 py-1 bg-red-500/20 hover:bg-red-500/40 text-red-400 rounded-md border border-red-500/30 transition-colors text-xs font-bold"
                >
                  <CheckCircle size={13} /> Approve
                </button>
                <button
                  onClick={() => onToolConfirm(false)}
                  className="flex items-center gap-1.5 px-3 py-1 bg-panel hover:bg-panel-strong text-fg-muted rounded-md border border-border-soft transition-colors text-xs"
                >
                  <XCircle size={13} /> Reject
                </button>
              </div>
              {onApproveTask && pendingToolConfirm.tool !== 'executeCommand' && (
                <button
                  onClick={onApproveTask}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1 bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-300 rounded-md border border-emerald-500/30 transition-colors text-xs"
                  title="Approves this edit AND lets the rest of this task's file edits run without asking. Commands and tests still confirm every time."
                >
                  <CheckCircle size={13} /> Approve + auto-approve file edits this conversation
                </button>
              )}
            </div>
          </motion.div>
        )}

        {pendingMemorySuggestion && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-start"
          >
            <div className="bg-teal-500/10 border border-teal-500/20 text-teal-200 rounded-xl px-4 py-3 max-w-[85%]">
              <div className="flex items-center gap-2 text-teal-400">
                <Brain size={13} />
                <span className="font-bold text-[10px] tracking-wider uppercase">Memory suggestion</span>
              </div>
              <p className="text-xs mt-2">{pendingMemorySuggestion.message}</p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  onClick={() => onMemorySuggestionRespond?.(true)}
                  className="flex items-center gap-1.5 px-3 py-1 bg-teal-500/20 hover:bg-teal-500/40 text-teal-300 rounded-md border border-teal-500/30 transition-colors text-xs font-bold"
                >
                  <CheckCircle size={13} /> Add to CLAUDE.md
                </button>
                <button
                  onClick={() => onMemorySuggestionRespond?.(false)}
                  className="flex items-center gap-1.5 px-3 py-1 bg-panel hover:bg-panel-strong text-fg-muted rounded-md border border-border-soft transition-colors text-xs"
                >
                  <XCircle size={13} /> Not now
                </button>
              </div>
            </div>
          </motion.div>
        )}

        <div ref={endRef} />

        {aiThinking && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3 text-teal-400/60 text-xs">
              <Loader2 size={14} className="animate-spin" />
              AI is thinking...
              {/* Requested directly (2026-07-29) after a query ran 5+ minutes with no way to stop
                  it — CPU-only Ollama inference has no upper bound on its own. */}
              {onCancel && (
                <button
                  onClick={onCancel}
                  className="flex items-center gap-1 px-2 py-0.5 rounded border border-red-500/30 text-red-400/80 hover:text-red-300 hover:border-red-500/60 hover:bg-red-500/10 transition-colors"
                  title="Cancel this request"
                >
                  <Square size={10} /> Stop
                </button>
              )}
            </div>
            {/* Requested directly (2026-07-30) — the server already separates a reasoning
                model's internal deliberation (Ollama's `message.thinking`) from its real answer
                and streams the former as its own 'thinking' event; previously the spinner above
                was the only signal anything was happening, with no visibility into what the
                model was actually doing. Capped height + scroll so a long reasoning trace doesn't
                push the input bar off-screen; only rendered once there's actually text to show. */}
            {aiThinkingText && (
              <div className="max-h-24 overflow-y-auto text-teal-400/40 text-xs font-mono italic whitespace-pre-wrap pl-6 border-l border-teal-400/20">
                {aiThinkingText}
              </div>
            )}
          </motion.div>
        )}

        {/* Trigger-mode busy indicator — requested directly after "run the site" gave no visual
            sign the console was still working on a slow-starting command (e.g. a dev server
            still booting), leaving no way to tell "still running" from "silently done". */}
        {commandPending && !aiThinking && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 text-[#00d4a3]/60 text-xs">
            <Loader2 size={14} className="animate-spin" />
            Running...
            {onCancel && (
              <button
                onClick={onCancel}
                className="flex items-center gap-1 px-2 py-0.5 rounded border border-red-500/30 text-red-400/80 hover:text-red-300 hover:border-red-500/60 hover:bg-red-500/10 transition-colors"
                title="Cancel this command"
              >
                <Square size={10} /> Stop
              </button>
            )}
          </motion.div>
        )}
        </div>
      </div>

      <ToolHistoryPanel toolHistory={toolHistory} show={showToolHistory} onToggle={onToggleToolHistory} onRerun={onRerunToolCall} />

      <ProcessDock
        processes={processes || []}
        processLogs={processLogs || {}}
        selectedProcessId={selectedProcessId || null}
        onSelectProcess={(pid) => onSelectProcess?.(pid)}
        onStopProcess={(pid) => onStopProcess?.(pid)}
        expanded={!!dockExpanded}
        onToggleExpanded={() => onToggleDock?.()}
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
                  <optgroup label="🌐 Ollama Cloud (needs sign-in + internet)">
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
          <AIAssistantInterface onSend={(text) => { onSendMessage(text); setInput(''); }} onSearch={(q) => { onSearch?.(q); }} onDeepResearch={(q) => { onDeepResearch?.(q); }} disabled={!activeProject || aiThinking || isBlocked} placeholder={isBlocked ? 'Resolve the pending confirmation first (Esc to cancel)...' : aiThinking ? 'AI is thinking...' : 'Ask me anything...'} />
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
              placeholder={!activeProject ? "Select a project to start..." : aiThinking ? "AI is thinking..." : commandPending ? "Running..." : "Ask a question or enter a command... (Ctrl+R for history)"}
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

      {/* Ctrl+R Search Overlay */}
      <AnimatePresence>
        {showSearchOverlay && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className={`absolute bottom-20 z-50 ${isFullscreen ? 'inset-x-0 mx-auto max-w-3xl' : 'left-4 right-4'} bg-surface border border-border-soft rounded-xl shadow-2xl overflow-hidden`}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border-soft bg-panel">
              <History size={14} className="text-fg-dim" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filteredHistory.length > 0) {
                    handleSearchOverlaySelect(filteredHistory[0]);
                  } else if (e.key === 'Escape') {
                    setShowSearchOverlay(false);
                    setSearchQuery('');
                    inputRef.current?.focus();
                  }
                }}
                placeholder="Search command history..."
                className="flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-fg-faint"
                autoFocus
              />
              <button
                onClick={() => { setShowSearchOverlay(false); setSearchQuery(''); inputRef.current?.focus(); }}
                className="text-fg-faint hover:text-fg-muted transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredHistory.length === 0 ? (
                <div className="px-4 py-6 text-center text-fg-faint text-sm">
                  {searchQuery.trim() ? 'No matching commands found' : 'No command history yet'}
                </div>
              ) : (
                filteredHistory.map((cmd, i) => (
                  <button
                    key={i}
                    onClick={() => handleSearchOverlaySelect(cmd)}
                    className="w-full text-left px-4 py-2 hover:bg-panel transition-colors font-mono text-sm text-fg-muted border-b border-border-faint last:border-b-0"
                  >
                    {cmd}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
