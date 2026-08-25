import { useEffect, useRef, useCallback, useState } from 'react';
import type { TerminalMessage, ToolCallEntry, Project, ToolPanelDef } from '../types';
import { GENERAL_PROJECT_ID } from '../types';
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
import { useConsoleTabs } from './useConsoleTabs';
import { useConsoleWsActions } from './useConsoleWsActions';
import { useConsoleNavigation } from './useConsoleNavigation';
import { useConsolePolling } from './useConsolePolling';
import { WS_MESSAGE_CASES } from './wsMessageCases';
import type { WsCtx } from './wsCtx';
import { waitForSocketOpen } from '../utils/waitForSocketOpen';
import { apiFetchJson } from '../utils/apiFetch';
import { makeMessage } from '../utils/makeMessage';

export function useConsole() {
  const projects = useProjects();
  const sessions = useSessions();
  // Phase T (2026-08-14): Chrome-style tabs with per-tab scan roots. Owns the tab list +
  // active tab; the live projects state above always reflects the ACTIVE tab (see the hook's
  // doc comment). Created right after projects so restoreTabs can drive the mount fetch.
  const tabs = useConsoleTabs(projects);

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

  // WS (re)connect: the server's per-connection state (aiEnabled, in-flight turns, busy
  // flags) resets whenever the socket reconnects — a busy indicator left true by a turn that
  // died with the old socket would otherwise keep the input disabled on the new connection
  // (audit 2026-08-06, Phase 3). Reads the setters via ctxRef at event time (the same pattern
  // as the WS router) so this stays a stable callback with no render-order dependencies.
  const handleWsOpen = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.ai.setAiThinking(false);
    ctx.ai.setAiThinkingText('');
    ctx.ai.setAiQueryInFlight(false);
    ctx.commandPending.setCommandPending(false);
  }, []);

  // Wire up wsRef from useWebSocket first so terminal shares the real socket ref —
  // previously useTerminal got a brand-new, never-populated ref, so handleConfirm/
  // handleToolConfirm's `!wsRef.current` check was always true and every Approve/
  // Reject/Cancel/Execute click silently no-op'd.
  const wsHandler = useWebSocket(handleWebSocketMessage, handleWsOpen);
  const { connected } = wsHandler;
  const terminal = useTerminal(
    wsHandler.wsRef,
    projects.activeProject,
  );

  const activeProjectRef = useRef(projects.activeProject);
  activeProjectRef.current = projects.activeProject;
  // Ref-read getter for the dock hook — commands always run for the session's active
  // project, so live output chunks are attributed to whatever project is active at call time.
  const getActiveProject = useCallback(() => activeProjectRef.current, []);
  // Phase T2: always-current project list for the tab switcher — it runs AFTER an awaited
  // fetchProjects (tab activation), so a closure-captured list would be the pre-fetch state.
  const projectsListRef = useRef(projects.projects);
  projectsListRef.current = projects.projects;

  const dock = useConsoleProcessDock(wsHandler.wsRef, getActiveProject);
  const toolHistory = useConsoleToolHistory(wsHandler.wsRef, sessions.setMessages);
  const workspace = useConsoleWorkspace(wsHandler.wsRef, projects.activeProject);
  const exports = useConsoleExports(projects.activeProject, sessions, tabs.activeTabId);
  const ai = useAI(wsHandler.sendMessage, sessions.setMessages);
  const search = useSearch(sessions.setMessages);
  // Phase 9 (2026-08-24 split): the small "send one WS message" handlers.
  const wsActions = useConsoleWsActions({ wsRef: wsHandler.wsRef, setMessages: sessions.setMessages });

  // Trigger-mode's equivalent of `aiThinking` — requested directly after a live test where a
  // slow-starting dev server command ("run the site") gave no visual sign the console was still
  // working, so there was no way to tell "still running" from "silently done". `aiThinking` only
  // ever gets set true by AI mode's own 'ai_start' event, so trigger-mode round trips (which are
  // most of what runs with AI off) had no busy indicator at all. Deliberately a separate state
  // rather than reusing aiThinking — this needs different semantics (stays true across
  // intermediate 'start'/'output' chunks, since a still-booting dev server keeps streaming text
  // without being "done"; only clears on a real end-of-turn signal) and different display text.
  const [commandPending, setCommandPending] = useState(false);
  // Phase 5: bumped after New Chat / session switch so Terminal can refocus its input (a
  // number, not a boolean — repeated bumps must always re-trigger the effect).
  const [chatFocusSignal, setChatFocusSignal] = useState(0);
  const [activeServers, setActiveServers] = useState<Array<{projectId: string; command: string; pid: number | null; url: string | null}>>([]);
  const [dashboardUpdateSignal, setDashboardUpdateSignal] = useState(0);
  // URLs the console has authoritatively seen as dev-server sites (server_url events +
  // /api/active-servers polls). The "Click here to open the site" chip only renders for
  // these — see TerminalMessages.tsx. Only ever grows; a stopped server's old chips stay
  // (the URL was real at the time), but error/answer bubbles with unrelated URLs (e.g. an
  // Ollama endpoint in a model error) never qualify.
  const [knownDevUrls, setKnownDevUrls] = useState<string[]>([]);
  // True between the server's 'ai_start' and the AI turn's stream_end — gates autoExpand
  // on output blocks created by commands the AI ran (see streamOutputCase).
  const [aiQueryInFlight, setAiQueryInFlight] = useState(false);
  // Phase 5: a newer published version of the console exists (server's once-per-boot
  // 'update_available' message). Dismissed via handleDismissUpdate; reappears next boot if
  // the new version still hasn't been installed.
  const [updateNotice, setUpdateNotice] = useState<{ current: string; latest: string } | null>(null);
  const handleDismissUpdate = useCallback(() => setUpdateNotice(null), []);

  // Phase 1.5 (UPGRADE-ROADMAP.md, 2026-08-11): the Tools surface (shared interactive tool
  // panels). `toolsOpen` swaps the top-level view to the Tools panel, `activeToolPanel`
  // records which registered tool's panel is open — both are settable from the WS layer
  // (the server's `answer` payload can carry an additive `openPanel` field) so typing
  // "open calculator" in chat lands in exactly the same panel state as clicking the card.
  // The registry itself is fetched from GET /api/tool-panels (server-driven so per-tool
  // availability can be reported later without a client restructure).
  const [toolsOpen, setToolsOpen] = useState(false);
  const [activeToolPanel, setActiveToolPanel] = useState<string | null>(null);
  const [toolPanels, setToolPanels] = useState<ToolPanelDef[]>([]);
  const [toolPanelsError, setToolPanelsError] = useState<string | null>(null);
  const fetchToolPanels = useCallback(async () => {
    const data = await apiFetchJson<{ panels: ToolPanelDef[] }>('/api/tool-panels');
    if (data?.panels) {
      setToolPanels(data.panels);
      setToolPanelsError(null);
    } else {
      setToolPanelsError('Could not load the tools list.');
    }
  }, []);

  const tokenBuffer = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once any token event has arrived for the current stream — lets stream_end tell
  // a genuinely empty AI completion (zero content, seen in real exported chats) apart from
  // one whose tokens were merely flushed by the 16ms timer already.
  const streamHadTokenRef = useRef(false);

  // Phase 9 (2026-08-24 split): chat/project/tab transition handlers.
  const navigation = useConsoleNavigation({
    wsActions,
    terminal,
    sessions,
    projects,
    tabs,
    setChatFocusSignal,
    resolveProjectById: useCallback((id: string) =>
      projectsListRef.current.find((p) => p.id === id) ?? null,
    []),
  });

  const handleCancel = wsActions.handleCancel;
  const handleAbortTurn = wsActions.handleAbortTurn;
  const handleDidYouMeanPick = wsActions.handleDidYouMeanPick;
  const handleDirectCommand = wsActions.handleDirectCommand;

  // Phase 13: rebuild the WS-case ctx bag every render and store it on the ref — the stable
  // router reads it fresh per event. Every setter/ref member is stable across renders (React
  // setState setters, useRef objects); `projects.projects` is deliberately read live.
  // Assigned BELOW handleSendMessage (2026-08-24): the undo toast needs sendMessage in the
  // ctx, and the assignment runs in the same render scope as the useCallback declaration.
  // M21: useCallback so the `onSendMessage` identity passed to TerminalMessages (and the
  // markdownComponents useMemo inside it) does not churn on every render — the old plain
  // `terminal.handleSendMessage = fn` reassigned a new function each render, which rebuilt
  // markdownComponents on every 16ms token frame and forced the whole thread to re-render.
  // (The useTerminal copy this replaces was dead code — see useTerminal.ts.)
  // 2026-08-12: no longer bails without an active project — the server resolves the reserved
  // '__general__' pseudo-workspace so a user can chat (and use personal tools) before picking
  // a project. The session lock is unaffected: a General-workspace session is created with
  // projectId '__general__' and locks to that id exactly like any other session.
  const handleSendMessage = useCallback(async (content: string) => {
    if (!wsHandler.wsRef.current) return;
    const open = await waitForSocketOpen(() => wsHandler.wsRef.current);
    // M19: the input was already cleared by the time this runs, so a dropped message used to
    // vanish silently — surface an error instead of swallowing it.
    if (!open) {
      sessions.setMessages(prev => [...prev, makeMessage(
        'error',
        'Could not send your message — the WebSocket is disconnected. Check the connection and try again.'
      )]);
      return;
    }
    sessions.setMessages(prev => [...prev, makeMessage('user', content)]);
    // Only trigger mode needs this — AI mode already gets its own busy indicator from the
    // server's 'ai_start' event (see ai.setAiThinking below), and showing both at once would be
    // redundant/confusing.
    if (!ai.aiEnabled) setCommandPending(true);
    wsHandler.wsRef.current.send(JSON.stringify({
      type: 'execute',
      payload: {
        projectId: projects.activeProject?.id ?? GENERAL_PROJECT_ID,
        input: content,
        sessionId: sessions.activeSessionId,
        // Phase T: the tab whose workspace this message belongs to (server resolves the
        // project inside that tab's cache — two tabs with same-named folders stay separate).
        tabId: tabs.activeTabId,
      }
    }));
  }, [projects.activeProject, wsHandler.wsRef, sessions.setMessages, sessions.activeSessionId, ai.aiEnabled, setCommandPending, tabs.activeTabId]);

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
      aiQueryInFlight,
      setAiQueryInFlight,
    },
    projects: {
      projects: projects.projects,
      setProjects: projects.setProjects,
      setActiveProject: projects.setActiveProject,
      setIndexingProjectId: projects.setIndexingProjectId,
    },
    workspace: { setWorkspaceProjects: workspace.setWorkspaceProjects },
    stream: { tokenBuffer, flushTimer, streamHadTokenRef },
    commandPending: { setCommandPending },
    setDashboardUpdateSignal,
    setKnownDevUrls,
    appendProcessOutput: dock.appendProcessOutput,
    addToolCall: toolHistory.addToolCall,
    fetchProcesses: dock.fetchProcesses,
    setUpdateNotice,
    toolPanel: { setActiveToolPanel, setToolsOpen },
    sendMessage: handleSendMessage,
  };

  // Phase 9 (2026-08-24 split): mount lifecycle + background polling (session fetch, WS
  // connect, tab restore, Ollama status, active-servers poll, 5s process refresh).
  useConsolePolling({
    fetchSessions: sessions.fetchSessions,
    connectWebSocket: wsHandler.connectWebSocket,
    disconnect: wsHandler.disconnect,
    restoreTabs: tabs.restoreTabs,
    fetchOllamaStatus: ai.fetchOllamaStatus,
    fetchProcesses: dock.fetchProcesses,
    setActiveServers,
    setKnownDevUrls,
  });

  // Phase 19 (2026-08-12): LAN display-name attribution. App.tsx calls this with the profile
  // name when /api/connected-users reports lanBound — the server then attributes
  // action-history/notes/reminders to this connection. Bound-to-127.0.0.1 installs never
  // call it, so everything stays "local" — zero behavior change single-user.
  const setDisplayName = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed || !wsHandler.wsRef.current) return;
    // Cancellable + bounded retry: the socket may still be opening (cold boot) — retry until
    // OPEN, but give up after 30s instead of retrying every second forever if it never opens
    // (the caller can also cancel via the returned cleanup, matching App.tsx's own pattern).
    let cancelled = false;
    let attempts = 0;
    const trySend = () => {
      if (cancelled) return;
      if (wsHandler.wsRef.current?.readyState === WebSocket.OPEN) {
        wsHandler.wsRef.current.send(JSON.stringify({ type: 'set_display_name', payload: { name: trimmed.slice(0, 40) } }));
      } else if (attempts++ < 30) {
        setTimeout(trySend, 1000);
      }
    };
    trySend();
    return () => { cancelled = true; };
  }, [wsHandler.wsRef]);

  // A brand-new chat with zero messages sent isn't "committed" to anything yet — deleting it
  // when the user navigates away (new chat / picks a different project) avoids piling up empty
  // orphaned sessions every time someone opens "New Chat" and then changes their mind before
  // typing anything. Only ever touches the *current* session, and only when it's genuinely empty.
  const deleteCurrentSessionIfEmpty = useCallback(async () => {
    if (sessions.activeSessionId && sessions.messages.length === 0) {
      await sessions.deleteSession(sessions.activeSessionId);
    }
  }, [sessions]);

  const { handleNewChat, handleQuickStart, handleScan, handleSelectProject, handleSelectProjectReuse, handleSwitchSession, handleSwitchToProject } = navigation;

  return {
    projects: projects.projects,
    activeProject: projects.activeProject,
    scanPath: projects.scanPath,
    setScanPath: projects.setScanPath,
    messages: sessions.messages,
    pendingConfirm: terminal.pendingConfirm,
    sessions: sessions.sessions,
    activeSessionId: sessions.activeSessionId,
    aiEnabled: ai.aiEnabled,
    ollamaStatus: ai.ollamaStatus,
    aiThinking: ai.aiThinking,
    aiThinkingText: ai.aiThinkingText,
    commandPending,
    chatFocusSignal,
    activeServers,
    knownDevUrls,
    dashboardUpdateSignal,
    processes: dock.processes,
    processLogs: dock.processLogs,
    logLoading: dock.logLoading,
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
    handleSendMessage,
    setDisplayName,
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
    exportAsPdf: exports.exportAsPdf,
    exportProjectChatLog: exports.exportProjectChatLog,
    handleDirectCommand,
    workspaceProjects: workspace.workspaceProjects,
    addToWorkspace: workspace.addToWorkspace,
    removeFromWorkspace: workspace.removeFromWorkspace,
    clearWorkspace: workspace.clearWorkspace,
    handleAIToggle: ai.handleAIToggle,
    handleSetModel: ai.handleSetModel,
    handleSetMode: ai.handleSetMode,
    handleSelectProject,
    handleSelectProjectReuse,
    handleSearch: search.handleSearch,
    handleDeepResearch: search.handleDeepResearch,
    handleNewChat,
    handleQuickStart,
    handleScan,
    createSession: sessions.createSession,
    switchSession: handleSwitchSession,
    deleteSession: sessions.deleteSession,
    renameSession: sessions.renameSession,
    // Phase 6: session-history pagination ("load earlier").
    historyTotal: sessions.historyTotal,
    loadedHistory: sessions.loadedHistory,
    loadEarlierMessages: sessions.loadEarlierMessages,
    handleSwitchToProject,
    connected,
    updateNotice,
    onDismissUpdate: handleDismissUpdate,
    toolsOpen,
    setToolsOpen,
    activeToolPanel,
    setActiveToolPanel,
    toolPanels,
    toolPanelsError,
    fetchToolPanels,
    // Phase T: Chrome-style tab strip (see useConsoleTabs.ts).
    tabs: tabs.tabs,
    activeTabId: tabs.activeTabId,
    activateTab: tabs.activateTab,
    duplicateTab: tabs.duplicateTab,
    closeTab: tabs.closeTab,
    registerViewSync: tabs.registerViewSync,
    isTabSwitchingRef: tabs.isTabSwitchingRef,
  };
}
