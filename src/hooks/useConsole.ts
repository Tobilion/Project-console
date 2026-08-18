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
import { WS_MESSAGE_CASES } from './wsMessageCases';
import type { WsCtx } from './wsCtx';
import { waitForSocketOpen } from '../utils/waitForSocketOpen';
import { apiFetchJson } from '../utils/apiFetch';
import { makeMessage } from '../utils/makeMessage';

// True when an absolute path sits inside (or equals) a scan root — case-insensitive, separator-
// normalized prefix match on win32. Shared by findTabForSession and the orphan-workspace check.
const pathInScanRoot = (path: string, root: string): boolean => {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const r = norm(root).replace(/\/+$/, '');
  const q = norm(path);
  return q.startsWith(r + '/') || q === r;
};

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

  const fetchActiveServers = useCallback(async () => {
    const data = await apiFetchJson<Array<{ projectId: string; command: string; pid: number | null; url: string | null }>>('/api/active-servers');
    if (data) {
      setActiveServers(data);
      const urls = data.map(s => s.url).filter((u): u is string => !!u);
      // Audit 2026-08-17: keep the array IDENTITY stable when nothing is actually new — the
      // old Set-spread rebuilt the array on every poll even with zero additions, which
      // re-rendered TerminalMessages (its URL-chip check reads this array) on every 5s poll.
      if (urls.length) setKnownDevUrls(prev => {
        const added = urls.filter(u => !prev.includes(u));
        return added.length ? [...prev, ...added] : prev;
      });
    }
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

  // Switching chats/projects must stop a still-streaming AI turn — its tokens/tool output
  // would otherwise land in the newly-opened chat and its final answer would persist into
  // whatever session becomes current. Deliberately NOT handleCancel(): the 'cancel' message
  // also kills running commands/dev servers (see the 'cancel' case in connectionRoutes.js),
  // and switching chats must never tear down a dev server the user started (audit 2026-08-06,
  // Phase 3). 'abort_ai' releases the turn's confirm cards and aborts the query, nothing else.
  const handleAbortTurn = useCallback(() => {
    if (wsHandler.wsRef.current?.readyState === WebSocket.OPEN) {
      wsHandler.wsRef.current.send(JSON.stringify({ type: 'abort_ai' }));
    }
  }, [wsHandler.wsRef]);

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
  };

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

  useEffect(() => {
    // Phase T2 fix (2026-08-14): restoreTabs used to be awaited BEFORE fetchSessions/WS
    // connect, so a slow multi-tab restore (each persisted tab re-scans its root server-side)
    // left the chat list empty and the socket unconnected for a long time — history looked
    // wiped. Sessions + WS now start immediately; tab restore runs in the background and
    // swaps the active tab's project list in when it finishes.
    sessions.fetchSessions();
    wsHandler.connectWebSocket();
    tabs.restoreTabs();
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

  const handleNewChat = async () => {
    try {
      handleAbortTurn();
      terminal.setPendingConfirm(null);
      terminal.setPendingToolConfirm(null);
      terminal.setPendingMemorySuggestion(null);
      await deleteCurrentSessionIfEmpty();
      sessions.setShowWelcome(false);
      // 2026-08-12: without an active project, start a General-workspace session (the server's
      // '__general__' pseudo-project) so chat works before picking a project — session-locked
      // to that id like any other session.
      const s = await sessions.createSession(projects.activeProject?.id ?? GENERAL_PROJECT_ID, projects.activeProject?.name ?? 'General', tabs.activeTabId);
      tabs.setActiveTabSession(s?.id ?? null);
      setChatFocusSignal(n => n + 1);
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
    // Phase T: the scan targets the ACTIVE tab's workspace — a duplicated tab scanning a new
    // folder changes only that tab, never the other tabs' folders.
    const result = await projects.scanNewPath(projects.scanPath, tabs.activeTabId);
    if (result.success) {
      sessions.setShowWelcome(false);
      tabs.snapshotActiveTab();
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
    handleAbortTurn();
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    terminal.setPendingMemorySuggestion(null);
    await deleteCurrentSessionIfEmpty();
    projects.setActiveProject(p);
    sessions.setShowWelcome(false);
    // Clicking a project card always opens a chat scoped to *that* project — it never relinks
    // whatever chat you happened to have open (that used to silently reassign an existing
    // conversation's project, which is exactly how a chat titled like one project could end up
    // actually linked to another one — confusing and surprising either way). "New Chat" is the
    // only thing that starts a fresh, unlinked session; selecting a project is always a fresh
    // session tied to it from creation.
    const s = await sessions.createSession(p.id, p.name, tabs.activeTabId);
    tabs.setActiveTabSession(s?.id ?? null);
    tabs.setActiveTabProject(p.id);
    projects.handleSelectProject(p, tabs.activeTabId);
    setChatFocusSignal(n => n + 1);
  };

  const handleSelectProjectReuse = async (p: any) => {
    // Dashboard action buttons (Run/Stop/Push/Open chat) route through here instead of
    // handleSelectProject: a one-click card control must not swap the current chat into an
    // empty new session (audit 2026-08-17). Reuse the project's open chat when one exists,
    // create one otherwise — the selected-project-is-always-fresh rule stays for the sidebar
    // and BentoGrid, which call handleSelectProject.
    handleAbortTurn();
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    terminal.setPendingMemorySuggestion(null);
    await deleteCurrentSessionIfEmpty();
    projects.setActiveProject(p);
    sessions.setShowWelcome(false);
    const existing = sessions.sessions.find((s) => s.projectId === p.id);
    if (existing) {
      await sessions.switchSession(existing.id);
      tabs.setActiveTabSession(existing.id);
    } else {
      const s = await sessions.createSession(p.id, p.name, tabs.activeTabId);
      tabs.setActiveTabSession(s?.id ?? null);
    }
    tabs.setActiveTabProject(p.id);
    projects.handleSelectProject(p, tabs.activeTabId);
    setChatFocusSignal(n => n + 1);
  };

  const handleDirectCommand = useCallback((command: string) => {
    if (!wsHandler.wsRef.current || wsHandler.wsRef.current.readyState !== WebSocket.OPEN) return;
    sessions.setMessages(prev => [...prev, makeMessage('user', command)]);
    wsHandler.wsRef.current.send(JSON.stringify({
      type: 'execute_tool',
      payload: { tool: 'executeCommand', args: { command, risky: false } }
    }));
  }, [wsHandler.wsRef, sessions.setMessages]);

  // Phase T2 fix (2026-08-14): a chat may belong to ANOTHER tab's workspace (created while
  // that tab was active). Match the session's location (projectPath, or workspacePath for
  // General chats that have no project) against each tab's scan root — clicking a chat must
  // land on the folder + project it actually lives in. Returns the owning tab's id, or null
  // when the DEFAULT tab owns it / nothing owns it (caller disambiguates).
  const findTabForSession = useCallback((projectPath?: string | null, workspacePath?: string | null): string | null => {
    const path = projectPath || workspacePath;
    if (!path) return null;
    // The active tab's own workspace wins: a chat already visible under the current tab must
    // never redirect to a different tab that happens to share the same scan root (duplicated
    // tabs). Only fall through to other tabs when the active one doesn't contain this path.
    const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
    if (active && active.scanPath && pathInScanRoot(path, active.scanPath)) return active.id;
    for (const t of tabs.tabs) {
      if (t.id === active?.id || !t.scanPath) continue;
      if (pathInScanRoot(path, t.scanPath)) return t.id;
    }
    return null;
  }, [tabs.tabs, tabs.activeTabId]);

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    handleAbortTurn();
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    terminal.setPendingMemorySuggestion(null);
    // Leaving a brand-new chat that never got a single message should clean it up instead of
    // leaving an empty orphan in the sidebar (same rule as New Chat / project select). Skip
    // when re-clicking the already-active chat — that must never delete itself.
    if (sessionId !== sessions.activeSessionId) {
      await deleteCurrentSessionIfEmpty();
    }
    // Phase 15: clicking a chat from history while on Home must leave the Welcome screen —
    // every other path (New Chat / Quick Start / project select / scan) hides it, this one
    // didn't, so the loaded chat rendered behind the canvas forever.
    sessions.setShowWelcome(false);
    // Phase T2: find the owning tab BEFORE loading so a chat from another tab's workspace
    // switches tabs first (activateTab re-loads the clicked session via the preferred id).
    const meta = sessions.sessions.find((s) => s.id === sessionId);
    const ownerId = findTabForSession(meta?.projectPath, meta?.workspacePath);
    if (ownerId !== tabs.activeTabId) {
      // ownerId null is ambiguous: the DEFAULT tab owns it, or nothing does. Check the default
      // tab's scan root first, then fall back to recreating the chat's workspace in a fresh tab.
      if (ownerId !== null) {
        await tabs.activateTab(ownerId, sessionId);
        return;
      }
      const path = meta?.projectPath || meta?.workspacePath;
      const defaultTab = tabs.tabs.find((t) => t.id === null);
      if (path && defaultTab?.scanPath && pathInScanRoot(path, defaultTab.scanPath)) {
        await tabs.activateTab(null, sessionId);
        return;
      }
      if (meta?.workspacePath) {
        await tabs.openWorkspaceTab(meta.workspacePath, sessionId);
        return;
      }
      // No tab owns the location and there's no workspace to recreate (legacy project-only
      // session) — fall through and load the chat on the current tab as before.
    }
    const s = await sessions.switchSession(sessionId);
    if (s?.projectId) {
      tabs.setActiveTabSession(sessionId);
      tabs.setActiveTabProject(s.projectId);
      const project = projects.projects.find(p => p.id === s.projectId);
      if (project) {
        projects.setActiveProject(project);
        if (!project.codebaseIndex) {
          projects.handleSelectProject(project, tabs.activeTabId);
        }
      }
    }
    setChatFocusSignal(n => n + 1);
  }, [sessions, projects, terminal, handleAbortTurn, tabs, findTabForSession]);

  // Recovery action for the "Session is locked to X" error: the currently-loaded chat and its
  // messages are already correct — the only thing out of sync is *which project is active*, so
  // fix just that (no new session, nothing about the open chat needs to change).
  const handleSwitchToProject = useCallback((projectId: string) => {
    const project = projects.projects.find(p => p.id === projectId);
    if (project) {
      projects.setActiveProject(project);
      tabs.setActiveTabProject(projectId);
      if (!project.codebaseIndex) {
        projects.handleSelectProject(project, tabs.activeTabId);
      }
    } else {
      sessions.setMessages(prev => [...prev, makeMessage('error', 'Couldn\'t find that project in the current list — try rescanning.')]);
    }
  }, [projects, sessions, tabs]);

  // Phase T: the tab-activation session switcher. Switching tabs reloads that tab's chat
  // through the same path as clicking a chat in the sidebar (abort turn, clear pending,
  // reload messages). A tab with no open chat yet starts a fresh session for its project
  // (or the General workspace when it has no project).
  tabs.setSessionSwitcher(async (target) => {
    handleAbortTurn();
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    terminal.setPendingMemorySuggestion(null);
    sessions.setShowWelcome(false);
    // Phase T fix: clear the shared conversation buffer before resolving the target session so
    // a failed load/create below can never leave the previous tab's chat visible here.
    sessions.resetConversation();
    if (target.activeSessionId) {
      const s = await sessions.switchSession(target.activeSessionId);
      if (s?.projectId) {
        tabs.setActiveTabProject(s.projectId);
        // The arriving tab's project list was just fetched — resolve the session's project
        // against it (via the ref — this runs after an await) so the terminal header/commands
        // point at the right folder (a chat from another tab's workspace must not keep the
        // previous tab's project active).
        const p = projectsListRef.current.find((pr) => pr.id === s.projectId);
        if (p) projects.setActiveProject(p);
      }
    } else if (target.activeProjectId) {
      const p = projectsListRef.current.find((pr) => pr.id === target.activeProjectId);
      const s = await sessions.createSession(target.activeProjectId, p?.name, tabs.activeTabId);
      tabs.setActiveTabSession(s?.id ?? null);
    } else {
      const s = await sessions.createSession(undefined, undefined, tabs.activeTabId);
      tabs.setActiveTabSession(s?.id ?? null);
    }
    setChatFocusSignal(n => n + 1);
  });

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
