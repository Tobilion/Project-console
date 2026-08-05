import { useEffect, useRef, useCallback, useState } from 'react';
import type { TerminalMessage, ToolCallEntry, Project } from '../types';
import { useProjects } from './useProjects';
import { useSessions } from './useSessions';
import { useWebSocket } from './useWebSocket';
import { useAI } from './useAI';
import { useTerminal } from './useTerminal';
import { useSearch } from './useSearch';
import { useConsoleProcessDock } from './useConsoleProcessDock';
import { useConsoleToolHistory } from './useConsoleToolHistory';
import { useConsoleWorkspace } from './useConsoleWorkspace';
import { useConsoleExports } from './useConsoleExports';
import { WS_MESSAGE_CASES } from './wsMessageCases';
import type { WsCtx } from './wsCtx';
import { waitForSocketOpen } from '../utils/waitForSocketOpen';
import { apiFetchJson } from '../utils/apiFetch';
import { makeMessage } from '../utils/makeMessage';

export function useConsole() {
  const projects = useProjects();
  const sessions = useSessions();

  // Phase 13: the WS router is a stable callback that reads the ctx bag through a ref, so
  // every event sees the latest state. This is also stricter than the old code: the original
  // handleWebSocketMessage was captured once at first render (connectWebSocket's useCallback
  // deps + the mount effect's [] deps), so `projects.projects` in the workspace_updated case
  // was a stale first-render snapshot; ctxRef fixes that latent bug.
  const ctxRef = useRef<WsCtx | null>(null);
  const handleWebSocketMessage = useCallback((payload: any) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    WS_MESSAGE_CASES[payload.type]?.(ctx, payload);
  }, []);

  // Wire up wsRef from useWebSocket first so terminal shares the real socket ref —
  // previously useTerminal got a brand-new, never-populated ref, so handleConfirm/
  // handleToolConfirm's `!wsRef.current` check was always true and every Approve/
  // Reject/Cancel/Execute click silently no-op'd.
  const wsHandler = useWebSocket(handleWebSocketMessage);
  const terminal = useTerminal(
    wsHandler.wsRef,
    projects.activeProject,
    sessions.activeSessionId,
    sessions.setMessages,
  );

  const activeProjectRef = useRef(projects.activeProject);
  activeProjectRef.current = projects.activeProject;
  // Ref-read getter for the dock hook — commands always run for the session's active
  // project, so live output chunks are attributed to whatever project is active at call time.
  const getActiveProject = useCallback(() => activeProjectRef.current, []);

  const dock = useConsoleProcessDock(wsHandler.wsRef, getActiveProject);
  const toolHistory = useConsoleToolHistory(wsHandler.wsRef, sessions.setMessages);
  const workspace = useConsoleWorkspace(wsHandler.wsRef, projects.activeProject);
  const exports = useConsoleExports(projects.activeProject, sessions);
  const ai = useAI(wsHandler.sendMessage, sessions.setMessages);
  const search = useSearch(sessions.setMessages);

  // Trigger-mode's equivalent of `aiThinking` — requested directly after a live test where a
  // slow-starting dev server command ("run the site") gave no visual sign the console was still
  // working, so there was no way to tell "still running" from "silently done". `aiThinking` only
  // ever gets set true by AI mode's own 'ai_start' event, so trigger-mode round trips (which are
  // most of what runs with AI off) had no busy indicator at all. Deliberately a separate state
  // rather than reusing aiThinking — this needs different semantics (stays true across
  // intermediate 'start'/'output' chunks, since a still-booting dev server keeps streaming text
  // without being "done"; only clears on a real end-of-turn signal) and different display text.
  const [commandPending, setCommandPending] = useState(false);
  const [activeServers, setActiveServers] = useState<Array<{projectId: string; command: string; pid: number | null; url: string | null}>>([]);
  const [dashboardUpdateSignal, setDashboardUpdateSignal] = useState(0);

  const fetchActiveServers = useCallback(async () => {
    const data = await apiFetchJson<Array<{ projectId: string; command: string; pid: number | null; url: string | null }>>('/api/active-servers');
    if (data) setActiveServers(data);
  }, []);

  const tokenBuffer = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once any token event has arrived for the current stream — lets stream_end tell
  // a genuinely empty AI completion (zero content, seen in real exported chats) apart from
  // one whose tokens were merely flushed by the 16ms timer already.
  const streamHadTokenRef = useRef(false);

  // Requested directly (2026-07-29) after an AI query ran for 5+ minutes with no way to stop
  // it — CPU-only Ollama inference has no upper bound, and there was previously no cancel path
  // at all. Sends a 'cancel' WS message (server aborts the in-flight fetch or kills a running
  // trigger-mode command — see connection.js); the busy indicators clear themselves once the
  // server's own response to the cancel arrives, same as any other end-of-turn signal.
  const handleCancel = useCallback(() => {
    if (wsHandler.wsRef.current?.readyState === WebSocket.OPEN) {
      wsHandler.wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }
  }, [wsHandler]);

  // Requested directly (2026-08-04): click on a non-blocking "did you mean" chip — sends
  // 'did_you_mean_pick' (server resolves a pending disambiguation question with the pick, or
  // dispatches the intent directly — see connection.js's routeMessage).
  const handleDidYouMeanPick = useCallback((intent: string) => {
    if (wsHandler.wsRef.current?.readyState === WebSocket.OPEN) {
      wsHandler.wsRef.current.send(JSON.stringify({ type: 'did_you_mean_pick', payload: { intent } }));
    }
  }, [wsHandler.wsRef]);

  // Phase 13: rebuild the WS-case ctx bag every render and store it on the ref — the stable
  // router reads it fresh per event. Every setter/ref member is stable across renders (React
  // setState setters, useRef objects); `projects.projects` is deliberately read live.
  ctxRef.current = {
    wsRef: wsHandler.wsRef,
    sessions: { setMessages: sessions.setMessages },
    terminal: {
      setPendingConfirm: terminal.setPendingConfirm,
      setPendingToolConfirm: terminal.setPendingToolConfirm,
      setPendingMemorySuggestion: terminal.setPendingMemorySuggestion,
    },
    ai: {
      setAiEnabled: ai.setAiEnabled,
      setAiModel: ai.setAiModel,
      setAiMode: ai.setAiMode,
      setAiThinking: ai.setAiThinking,
      setAiThinkingText: ai.setAiThinkingText,
    },
    projects: {
      projects: projects.projects,
      setProjects: projects.setProjects,
      setIndexingProjectId: projects.setIndexingProjectId,
    },
    workspace: { setWorkspaceProjects: workspace.setWorkspaceProjects },
    stream: { tokenBuffer, flushTimer, streamHadTokenRef },
    commandPending: { setCommandPending },
    setDashboardUpdateSignal,
    appendProcessOutput: dock.appendProcessOutput,
    addToolCall: toolHistory.addToolCall,
    fetchProcesses: dock.fetchProcesses,
  };

  // Override wsRef in terminal with the real one
  terminal.handleSendMessage.bind = Function.prototype.bind;
  const origHandleSendMessage = terminal.handleSendMessage;
  terminal.handleSendMessage = async (content: string) => {
    if (!projects.activeProject || !wsHandler.wsRef.current) return;
    const open = await waitForSocketOpen(() => wsHandler.wsRef.current);
    if (!open) return;
    sessions.setMessages(prev => [...prev, makeMessage('user', content)]);
    // Only trigger mode needs this — AI mode already gets its own busy indicator from the
    // server's 'ai_start' event (see ai.setAiThinking below), and showing both at once would be
    // redundant/confusing.
    if (!ai.aiEnabled) setCommandPending(true);
    wsHandler.wsRef.current.send(JSON.stringify({
      type: 'execute',
      payload: { projectId: projects.activeProject.id, input: content, sessionId: sessions.activeSessionId }
    }));
  };

  useEffect(() => {
    projects.fetchProjects();
    sessions.fetchSessions();
    wsHandler.connectWebSocket();
    fetch('/api/ollama/status').then(r => r.ok ? r.json() : null).then(s => { if (s) ai.fetchOllamaStatus(); }).catch(() => {});
    fetchActiveServers();
    dock.fetchProcesses();
    const serverPollId = setInterval(() => {
      fetchActiveServers();
      dock.fetchProcesses();
    }, 5000);
    return () => {
      clearInterval(serverPollId);
      wsHandler.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A brand-new chat with zero messages sent isn't "committed" to anything yet — deleting it
  // when the user navigates away (new chat / picks a different project) avoids piling up empty
  // orphaned sessions every time someone opens "New Chat" and then changes their mind before
  // typing anything. Only ever touches the *current* session, and only when it's genuinely empty.
  const deleteCurrentSessionIfEmpty = useCallback(async () => {
    if (sessions.activeSessionId && sessions.messages.length === 0) {
      await sessions.deleteSession(sessions.activeSessionId);
    }
  }, [sessions]);

  const handleNewChat = async () => {
    try {
      terminal.setPendingConfirm(null);
      terminal.setPendingToolConfirm(null);
      await deleteCurrentSessionIfEmpty();
      sessions.setShowWelcome(false);
      sessions.createSession();
    } catch (err) {
      // Belt-and-suspenders: this is the one button whose whole job is to force the
      // Welcome-screen tree to unmount and the full dashboard tree to mount with no active
      // project yet — don't let any unexpected error here escape uncaught (the top-level
      // ErrorBoundary in main.tsx is the other half of this safety net).
      // eslint-disable-next-line no-console
       console.error('New Chat failed:', err);
       sessions.setMessages(prev => [...prev, makeMessage(
         'error',
         'Could not start a new chat — please try again.'
       )]);
    }
  };

  const QUICK_START_TEXT = [
    'Quick start:',
    '- Pick a project from the grid below, or scan a folder path up top, to get started.',
    '- Once a project is active, type things like "overview", "help", "git status", or "run dev" —',
    '  trigger mode answers from a fixed command list.',
    '- Toggle AI Assistant ON for open-ended requests: natural-language questions, file edits, and',
    '  running arbitrary commands (writes and risky commands always ask for approval first).',
    '- "New Chat" starts a fresh conversation; your chat history lives in the sidebar and always',
    '  reopens into the project it belongs to.',
  ].join('\n');

  const handleQuickStart = useCallback(() => {
    // The Quick Start Guide button is only ever shown on the Welcome screen, i.e. with no
    // active project — routing it through the normal send-message path silently no-ops there
    // (terminal.handleSendMessage bails out whenever !activeProject). Show the guide as a plain
    // local system message instead so it works with zero project/session/WS state required.
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
      sessions.setShowWelcome(false);
      if (!sessions.activeSessionId) {
        sessions.createSession();
      }
      sessions.setMessages(prev => [...prev, makeMessage('system', QUICK_START_TEXT)]);
  }, [sessions, terminal]);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await projects.scanNewPath(projects.scanPath);
    if (result.success) {
      sessions.setShowWelcome(false);
    } else {
      // Surface the failure instead of silently doing nothing (this was the actual cause of
      // "the folder picker doesn't let me pick anything" — the request was failing server-side
      // the whole time, just with no visible feedback).
      sessions.setShowWelcome(false);
      if (!sessions.activeSessionId) {
        sessions.createSession();
      }
      sessions.setMessages(prev => [...prev, makeMessage('error', result.error || 'Scan failed.')]);
    }
  };

  const handleSelectProject = async (p: any) => {
    // Mirror handleSwitchSession: a pending confirmation/tool-confirm from whatever project was
    // active before is misleading (and stale) once the user has jumped to a different project.
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    await deleteCurrentSessionIfEmpty();
    projects.setActiveProject(p);
    sessions.setShowWelcome(false);
    // Clicking a project card always opens a chat scoped to *that* project — it never relinks
    // whatever chat you happened to have open (that used to silently reassign an existing
    // conversation's project, which is exactly how a chat titled like one project could end up
    // actually linked to another one — confusing and surprising either way). "New Chat" is the
    // only thing that starts a fresh, unlinked session; selecting a project is always a fresh
    // session tied to it from creation.
    await sessions.createSession(p.id, p.name);
    projects.handleSelectProject(p);
  };

  const handleDirectCommand = useCallback((command: string) => {
    if (!wsHandler.wsRef.current || wsHandler.wsRef.current.readyState !== WebSocket.OPEN) return;
    sessions.setMessages(prev => [...prev, makeMessage('user', command)]);
    wsHandler.wsRef.current.send(JSON.stringify({
      type: 'execute_tool',
      payload: { tool: 'executeCommand', args: { command, risky: false } }
    }));
  }, [wsHandler.wsRef, sessions.setMessages]);

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    // Phase 15: clicking a chat from history while on Home must leave the Welcome screen —
    // every other path (New Chat / Quick Start / project select / scan) hides it, this one
    // didn't, so the loaded chat rendered behind the canvas forever.
    sessions.setShowWelcome(false);
    const s = await sessions.switchSession(sessionId);
    if (s?.projectId) {
      const project = projects.projects.find(p => p.id === s.projectId);
      if (project) {
        projects.setActiveProject(project);
        if (!project.codebaseIndex) {
          projects.handleSelectProject(project);
        }
      }
    }
  }, [sessions, projects, terminal]);

  // Recovery action for the "Session is locked to X" error: the currently-loaded chat and its
  // messages are already correct — the only thing out of sync is *which project is active*, so
  // fix just that (no new session, nothing about the open chat needs to change).
  const handleSwitchToProject = useCallback((projectId: string) => {
    const project = projects.projects.find(p => p.id === projectId);
    if (project) {
      projects.setActiveProject(project);
      if (!project.codebaseIndex) {
        projects.handleSelectProject(project);
      }
    } else {
      sessions.setMessages(prev => [...prev, makeMessage('error', 'Couldn\'t find that project in the current list — try rescanning.')]);
    }
  }, [projects, sessions]);

  return {
    projects: projects.projects,
    activeProject: projects.activeProject,
    scanPath: projects.scanPath,
    setScanPath: projects.setScanPath,
    messages: sessions.messages,
    pendingConfirm: terminal.pendingConfirm,
    sessions: sessions.sessions,
    activeSessionId: sessions.activeSessionId,
    showSessions: sessions.showSessions,
    setShowSessions: sessions.setShowSessions,
    aiEnabled: ai.aiEnabled,
    ollamaStatus: ai.ollamaStatus,
    aiThinking: ai.aiThinking,
    aiThinkingText: ai.aiThinkingText,
    commandPending,
    activeServers,
    dashboardUpdateSignal,
    processes: dock.processes,
    processLogs: dock.processLogs,
    selectedProcessId: dock.selectedProcessId,
    setSelectedProcessId: dock.setSelectedProcessId,
    dockExpanded: dock.dockExpanded,
    setDockExpanded: dock.setDockExpanded,
    dockTab: dock.dockTab,
    setDockTab: dock.setDockTab,
    handleStopProcess: dock.handleStopProcess,
    handleDidYouMeanPick,
    indexingProjectId: projects.indexingProjectId,
    aiModel: ai.aiModel,
    aiMode: ai.aiMode,
    showWelcome: sessions.showWelcome,
    setShowWelcome: sessions.setShowWelcome,
    pendingToolConfirm: terminal.pendingToolConfirm,
    pendingMemorySuggestion: terminal.pendingMemorySuggestion,
    handleSendMessage: terminal.handleSendMessage,
    handleCancel,
    handleConfirm: terminal.handleConfirm,
    handleToolConfirm: terminal.handleToolConfirm,
    handleApproveTask: terminal.handleApproveTask,
    handleMemorySuggestionRespond: terminal.handleMemorySuggestionRespond,
    toolHistory: toolHistory.toolHistory,
    showToolHistory: toolHistory.showToolHistory,
    setShowToolHistory: toolHistory.setShowToolHistory,
    rerunToolCall: toolHistory.rerunToolCall,
    exportAsMarkdown: exports.exportAsMarkdown,
    exportAsJson: exports.exportAsJson,
    handleDirectCommand,
    workspaceProjects: workspace.workspaceProjects,
    addToWorkspace: workspace.addToWorkspace,
    removeFromWorkspace: workspace.removeFromWorkspace,
    clearWorkspace: workspace.clearWorkspace,
    handleAIToggle: ai.handleAIToggle,
    handleSetModel: ai.handleSetModel,
    handleSetMode: ai.handleSetMode,
    handlePullModel: ai.handlePullModel,
    fetchOllamaStatus: ai.fetchOllamaStatus,
    handleSelectProject,
    handleSearch: search.handleSearch,
    handleDeepResearch: search.handleDeepResearch,
    handleNewChat,
    handleQuickStart,
    handleScan,
    createSession: sessions.createSession,
    switchSession: handleSwitchSession,
    deleteSession: sessions.deleteSession,
    handleSwitchToProject,
  };
}
