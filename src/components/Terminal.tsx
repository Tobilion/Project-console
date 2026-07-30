import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { TerminalMessage, Project, AIStatus, PendingToolConfirm, PendingMemorySuggestion, ToolCallEntry } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { Terminal as TerminalIcon, Send, Search, CheckCircle, XCircle, Brain, Loader2, History, Copy, FileDown, ListChecks, Download, Square, Maximize2, Minimize2 } from 'lucide-react';
import { AIAssistantInterface } from './ui/AIAssistantInterface';
import { ToolHistoryPanel } from './ToolHistoryPanel';

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
}

/** Parses a JSON code-block child string and returns the parsed object, or null. */
function tryParseJsonBlock(children: React.ReactNode): Record<string, unknown> | null {
  const text = typeof children === 'string' ? children : '';
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return null;
}

/** Renders a ```json block with copy button and type-specific actions when in structured mode. */
function StructuredJsonBlock({ content, onSendMessage }: { content: string; onSendMessage: (msg: string) => void }) {
  const [copied, setCopied] = useState(false);
  const parsed = tryParseJsonBlock(content);
  const dataType = parsed?.type as string || 'generic';
  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const handleApply = () => {
    const path = parsed?.data && typeof parsed.data === 'object' ? (parsed.data as any).path || null : null;
    if (path) {
      onSendMessage(`Write the following to ${path}:\n\`\`\`\n${JSON.stringify(parsed.data, null, 2)}\n\`\`\``);
    } else {
      onSendMessage(`Apply this to the project:\n\`\`\`json\n${content}\n\`\`\``);
    }
  };

  return (
    <div className="relative group">
      <div className="flex items-center justify-between px-3 py-1.5 bg-black/30 border-b border-white/10 rounded-t-lg">
        <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
          JSON {dataType !== 'generic' ? `— ${dataType.replace('_', ' ')}` : ''}
        </span>
        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={handleCopy} className="p-1 text-gray-500 hover:text-gray-200 transition-colors" title="Copy JSON">
            {copied ? <span className="text-[10px] text-teal-400">Copied</span> : <Copy size={12} />}
          </button>
          {parsed && (
            <button onClick={handleApply} className="p-1 text-gray-500 hover:text-teal-400 transition-colors" title={parsed?.data && typeof parsed.data === 'object' && (parsed.data as any).path ? `Apply to ${(parsed.data as any).path}` : 'Apply to project'}>
              <FileDown size={12} />
            </button>
          )}
        </div>
      </div>
      <pre className="bg-black/50 border border-white/10 rounded-b-lg p-3 overflow-x-auto">
        <code className="text-xs text-gray-200">{content}</code>
      </pre>
    </div>
  );
}

const AI_MODES = [
  { value: 'default', label: 'General' },
  { value: 'coding', label: 'Coding' },
  { value: 'tutor', label: 'Tutor' },
  { value: 'creative', label: 'Creative' },
  { value: 'consultant', label: 'Consultant' },
  { value: 'structured', label: 'Structured' }
];

export const Terminal = ({ messages, onSendMessage, onSearch, onDeepResearch, activeProject, pendingConfirm, onConfirm, pendingToolConfirm, onToolConfirm, pendingMemorySuggestion, onMemorySuggestionRespond, aiEnabled, aiThinking, aiThinkingText, commandPending, onCancel, ollamaStatus, aiModel, aiMode, onAIToggle, onSetModel, onSetMode, toolHistory, showToolHistory, onToggleToolHistory, onRerunToolCall, onExportMarkdown, onExportJson, onDirectCommand, workspaceProjects, addToWorkspace, removeFromWorkspace, clearWorkspace, onSwitchToProject, isFullscreen, onToggleFullscreen }: TerminalProps) => {
  const [input, setInput] = useState('');
  const [showSearchOverlay, setShowSearchOverlay] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
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
    <div className="flex flex-col h-full bg-[#0a0c10]/80 backdrop-blur-md rounded-2xl border border-white/10 relative">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-white/10 bg-white/5">
        <TerminalIcon size={18} className="text-[#3d6bff]" />
        <span className="font-mono text-sm text-gray-300 flex-1">
          {activeProject ? `Connected: ${activeProject.name}` : 'No Project Selected'}
        </span>
        {onToggleFullscreen && (
          <button onClick={onToggleFullscreen} className="p-1.5 text-gray-500 hover:text-gray-200 transition-colors flex-shrink-0" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen chat'}>
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
        {ollamaStatus && (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button onClick={onAIToggle} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors border flex-shrink-0 ${aiEnabled ? 'bg-teal-500/20 border-teal-500/40 text-teal-300' : 'bg-white/5 border-white/10 text-gray-500 hover:text-gray-300'}`}>
              <Brain size={14} />
              <span>AI {aiEnabled ? 'ON' : 'OFF'}</span>
            </button>
            {aiEnabled && ((ollamaStatus.models?.length ?? 0) > 0 || (ollamaStatus.cloudModels?.length ?? 0) > 0) && (
              <>
                <select
                  value={aiModel}
                  onChange={(e) => onSetModel(e.target.value)}
                  title={ollamaStatus.cloudModels?.some(m => m.name === aiModel) ? 'Running on Ollama Cloud — needs internet + `ollama signin`' : 'Running locally'}
                  className="bg-[#12151c] border border-white/10 rounded-lg px-2 py-1 text-xs font-mono text-gray-300 focus:outline-none focus:border-teal-500/40"
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
                  className="bg-[#12151c] border border-white/10 rounded-lg px-2 py-1 text-xs font-mono text-gray-300 focus:outline-none focus:border-teal-500/40"
                >
                  {AI_MODES.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </>
            )}
            {workspaceProjects.length > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10">
                <span className="text-[10px] text-gray-500 font-mono">Workspace:</span>
                {workspaceProjects.map((p) => (
                  <span key={p.id} className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#3d6bff]/10 border border-[#3d6bff]/30 text-xs text-[#3d6bff] font-mono">
                    {p.name}
                    <button onClick={() => removeFromWorkspace(p.id)} className="text-[#3d6bff]/60 hover:text-[#3d6bff] transition-colors">×</button>
                  </span>
                ))}
                <button onClick={clearWorkspace} className="text-gray-600 hover:text-red-400 transition-colors text-xs" title="Clear workspace">×</button>
              </div>
            )}
            <div className="flex items-center gap-1">
              <button onClick={onExportMarkdown} className="p-1.5 text-gray-500 hover:text-gray-200 transition-colors" title="Export session as Markdown">
                <Download size={14} />
              </button>
              <button onClick={onExportJson} className="p-1.5 flex items-center gap-0.5 text-gray-500 hover:text-teal-400 transition-colors" title="Export session as JSON">
                <Download size={11} /><span className="text-[9px] font-mono">JSON</span>
              </button>
            </div>
            <button onClick={onToggleToolHistory} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors border ${showToolHistory ? 'bg-[#3d6bff]/20 border-[#3d6bff]/40 text-[#3d6bff]' : 'bg-white/5 border-white/10 text-gray-500 hover:text-gray-300'}`} title="Tool Call History">
              <ListChecks size={14} />
              {toolHistory.length > 0 && <span className="text-[10px]">{toolHistory.length}</span>}
            </button>
          </div>
        )}
      </div>
      
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => (
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
                    : 'bg-white/5 border border-white/10 text-gray-200 rounded-bl-none'
                }`}
              >
                {msg.type === 'user' || !msg.isMarkdown ? (
                   <div className="whitespace-pre-wrap font-mono text-sm leading-relaxed">{msg.content}</div>
                ) : (
                   <div className="prose prose-invert prose-sm max-w-none prose-pre:bg-black/50 prose-pre:border prose-pre:border-white/10 prose-pre:p-0 prose-p:leading-relaxed">
                      <ReactMarkdown components={markdownComponents}>{msg.content}</ReactMarkdown>
                    </div>
                )}
                
                {msg.suggestions && msg.suggestions.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-white/10">
                    <p className="text-xs text-gray-500 font-mono mb-2">SUGGESTIONS:</p>
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
                          className="px-3 py-1 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-[#00d4a3] transition-colors"
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
                      className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-xs text-red-300 font-mono transition-colors"
                    >
                      Switch to "{msg.switchProjectAction.projectName}"
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {pendingConfirm && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-start"
          >
            <div className="bg-orange-500/10 border border-orange-500/20 text-orange-200 rounded-2xl rounded-bl-none px-5 py-4 max-w-[85%]">
              <div className="flex items-center gap-2 mb-2 text-orange-400">
                <Search size={16} />
                <span className="font-bold text-sm tracking-wider uppercase">Safety Confirmation</span>
              </div>
              <p className="font-mono text-sm mb-4">
                You are about to execute a risky command:<br/>
                <span className="text-white bg-black/50 px-2 py-1 rounded mt-2 inline-block border border-white/10">{pendingConfirm.command}</span>
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => onConfirm(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/40 text-red-400 rounded-lg border border-red-500/30 transition-colors text-sm font-bold"
                >
                  <CheckCircle size={16} /> Execute
                </button>
                <button
                  onClick={() => onConfirm(false)}
                  className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg border border-white/10 transition-colors text-sm"
                >
                  <XCircle size={16} /> Cancel
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
            <div className="bg-orange-500/10 border border-orange-500/20 text-orange-200 rounded-2xl rounded-bl-none px-5 py-4 max-w-[85%]">
              <div className="flex items-center gap-2 mb-2 text-orange-400">
                <Brain size={16} />
                <span className="font-bold text-sm tracking-wider uppercase">AI wants to run: {pendingToolConfirm.tool}</span>
              </div>
              <pre className="font-mono text-xs mb-4 whitespace-pre-wrap break-all bg-black/50 px-3 py-2 rounded border border-white/10 text-gray-300">
                {JSON.stringify(pendingToolConfirm.args, null, 2)}
              </pre>
              <div className="flex gap-3">
                <button
                  onClick={() => onToolConfirm(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/40 text-red-400 rounded-lg border border-red-500/30 transition-colors text-sm font-bold"
                >
                  <CheckCircle size={16} /> Approve
                </button>
                <button
                  onClick={() => onToolConfirm(false)}
                  className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg border border-white/10 transition-colors text-sm"
                >
                  <XCircle size={16} /> Reject
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {pendingMemorySuggestion && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-start"
          >
            <div className="bg-teal-500/10 border border-teal-500/20 text-teal-200 rounded-2xl rounded-bl-none px-5 py-4 max-w-[85%]">
              <div className="flex items-center gap-2 mb-2 text-teal-400">
                <Brain size={16} />
                <span className="font-bold text-sm tracking-wider uppercase">Memory suggestion</span>
              </div>
              <p className="text-sm mb-4">{pendingMemorySuggestion.message}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => onMemorySuggestionRespond?.(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-teal-500/20 hover:bg-teal-500/40 text-teal-300 rounded-lg border border-teal-500/30 transition-colors text-sm font-bold"
                >
                  <CheckCircle size={16} /> Add to CLAUDE.md
                </button>
                <button
                  onClick={() => onMemorySuggestionRespond?.(false)}
                  className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg border border-white/10 transition-colors text-sm"
                >
                  <XCircle size={16} /> Not now
                </button>
              </div>
            </div>
          </motion.div>
        )}

        <div ref={endRef} />

        {aiThinking && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3 text-teal-400/60 text-xs font-mono">
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
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 text-[#00d4a3]/60 text-xs font-mono">
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

      <ToolHistoryPanel toolHistory={toolHistory} show={showToolHistory} onToggle={onToggleToolHistory} onRerun={onRerunToolCall} />

      {aiEnabled ? (
        <div className="p-3 bg-white/5 border-t border-white/10">
          <AIAssistantInterface onSend={(text) => { onSendMessage(text); setInput(''); }} onSearch={(q) => { onSearch?.(q); }} onDeepResearch={(q) => { onDeepResearch?.(q); }} disabled={!activeProject || aiThinking || isBlocked} placeholder={isBlocked ? 'Resolve the pending confirmation first (Esc to cancel)...' : aiThinking ? 'AI is thinking...' : 'Ask me anything...'} />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="p-4 bg-white/5 border-t border-white/10">
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => { setInput(e.target.value); resetTab(); }}
              onKeyDown={handleInputKeyDown}
              disabled={!activeProject || aiThinking || commandPending}
              placeholder={!activeProject ? "Select a project to start..." : aiThinking ? "AI is thinking..." : commandPending ? "Running..." : "Ask a question or enter a command... (Ctrl+R for history)"}
              className="w-full bg-[#12151c] border border-white/10 rounded-xl py-3 pl-4 pr-12 text-gray-100 font-mono text-sm focus:outline-none focus:border-[#3d6bff] transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || !activeProject || aiThinking || commandPending || isBlocked}
              title={isBlocked ? 'Resolve the pending confirmation first (Esc to cancel)' : undefined}
              className="absolute right-2 p-2 text-gray-400 hover:text-[#00d4a3] disabled:opacity-50 transition-colors"
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
            className="absolute bottom-20 left-4 right-4 bg-[#12151c] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50"
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/5">
              <History size={14} className="text-gray-500" />
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
                className="flex-1 bg-transparent text-gray-100 font-mono text-sm outline-none placeholder:text-gray-600"
                autoFocus
              />
              <button
                onClick={() => { setShowSearchOverlay(false); setSearchQuery(''); inputRef.current?.focus(); }}
                className="text-gray-600 hover:text-gray-300 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredHistory.length === 0 ? (
                <div className="px-4 py-6 text-center text-gray-600 text-sm font-mono">
                  {searchQuery.trim() ? 'No matching commands found' : 'No command history yet'}
                </div>
              ) : (
                filteredHistory.map((cmd, i) => (
                  <button
                    key={i}
                    onClick={() => handleSearchOverlaySelect(cmd)}
                    className="w-full text-left px-4 py-2 hover:bg-white/5 transition-colors font-mono text-sm text-gray-300 border-b border-white/5 last:border-b-0"
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
