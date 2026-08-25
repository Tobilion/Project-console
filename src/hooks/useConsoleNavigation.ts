// Chat/project/tab transition handlers (2026-08-24, split out of useConsole.ts): every
// "leave the current chat for something else" path — New Chat, project select, session
// switch, tab activation, scan, quick start. They share one invariant: abort the AI turn,
// clear every pending card, drop an empty un-committed session, then land on the target
// chat. The terminal (chat input) stays the single entry point for everything else.

import { useCallback } from 'react';
import type { TerminalMessage } from '../types';
import { GENERAL_PROJECT_ID } from '../types';
import { makeMessage } from '../utils/makeMessage';
import { findTabForSession, pathInScanRoot } from '../utils/sessionLocation';
import type { ConsoleTab } from './useConsoleTabs';
import type { UseConsoleWsActionsDeps } from './useConsoleWsActions';

export interface UseConsoleNavigationDeps {
  wsActions: ReturnType<typeof import('./useConsoleWsActions').useConsoleWsActions>;
  terminal: {
    setPendingConfirm: (v: { token: string; command: string } | null) => void;
    setPendingToolConfirm: (v: unknown) => void;
    setPendingMemorySuggestion: (v: unknown) => void;
  };
  sessions: {
    activeSessionId: string | null;
    messages: TerminalMessage[];
    sessions: Array<{ id: string; projectId?: string | null; projectPath?: string | null; workspacePath?: string | null }>;
    setMessages: React.Dispatch<React.SetStateAction<TerminalMessage[]>>;
    setShowWelcome: React.Dispatch<React.SetStateAction<boolean>>;
    createSession: (projectId?: string, projectName?: string, tabId?: string | null) => Promise<{ id: string } | null>;
    deleteSession: (id: string) => Promise<void>;
    switchSession: (id: string) => Promise<{ projectId?: string } | null>;
    resetConversation: () => void;
  };
  projects: {
    projects: Array<{ id: string; name: string; codebaseIndex?: unknown }>;
    activeProject: { id: string; name: string } | null;
    scanPath: string;
    scanNewPath: (path: string, tabId?: string | null) => Promise<{ success: boolean; error?: string }>;
    setActiveProject: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
    handleSelectProject: (p: unknown, tabId?: string | null) => void;
  };
  tabs: {
    tabs: ConsoleTab[];
    activeTabId: string | null;
    setActiveTabSession: (id: string | null) => void;
    setActiveTabProject: (id: string) => void;
    activateTab: (id: string | null, preferredSessionId?: string | null) => Promise<void>;
    openWorkspaceTab: (path: string, sessionId?: string | null) => Promise<void>;
    setSessionSwitcher: (fn: (target: { activeSessionId?: string | null; activeProjectId?: string | null }) => Promise<void>) => void;
    snapshotActiveTab: () => void;
  };
  setChatFocusSignal: React.Dispatch<React.SetStateAction<number>>;
  /** Resolves a project against the LIVE projects list (via ref — the switcher runs after an
   *  await, so a closure-captured list would be stale) and makes it active. */
  resolveProjectById: (id: string) => { id: string; name: string; codebaseIndex?: unknown } | null;
}

export function useConsoleNavigation({
  wsActions,
  terminal,
  sessions,
  projects,
  tabs,
  setChatFocusSignal,
  resolveProjectById,
}: UseConsoleNavigationDeps) {
  const { handleAbortTurn } = wsActions;

  // A brand-new chat with zero messages sent isn't "committed" to anything yet — deleting it
  // when the user navigates away (new chat / picks a different project) avoids piling up empty
  // orphaned sessions every time someone opens "New Chat" and then changes their mind before
  // typing anything. Only ever touches the *current* session, and only when it's genuinely empty.
  const deleteCurrentSessionIfEmpty = useCallback(async () => {
    if (sessions.activeSessionId && sessions.messages.length === 0) {
      await sessions.deleteSession(sessions.activeSessionId);
    }
  }, [sessions]);

  const clearPendingCards = useCallback(() => {
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    terminal.setPendingMemorySuggestion(null);
  }, [terminal]);

  const handleNewChat = async () => {
    try {
      handleAbortTurn();
      clearPendingCards();
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
    clearPendingCards();
    sessions.setShowWelcome(false);
    if (!sessions.activeSessionId) {
      sessions.createSession();
    }
    sessions.setMessages(prev => [...prev, makeMessage('system', QUICK_START_TEXT)]);
  }, [sessions, clearPendingCards]);

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

  const handleSelectProject = async (p: { id: string; name: string }) => {
    // Mirror handleSwitchSession: a pending confirmation/tool-confirm from whatever project was
    // active before is misleading (and stale) once the user has jumped to a different project.
    handleAbortTurn();
    clearPendingCards();
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

  const handleSelectProjectReuse = async (p: { id: string; name: string }) => {
    // Dashboard action buttons (Run/Stop/Push/Open chat) route through here instead of
    // handleSelectProject: a one-click card control must not swap the current chat into an
    // empty new session (audit 2026-08-17). Reuse the project's open chat when one exists,
    // create one otherwise — the selected-project-is-always-fresh rule stays for the sidebar
    // and BentoGrid, which call handleSelectProject.
    handleAbortTurn();
    clearPendingCards();
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

  // Phase T2 fix (2026-08-14): a chat may belong to ANOTHER tab's workspace (created while
  // that tab was active). Match the session's location (projectPath, or workspacePath for
  // General chats that have no project) against each tab's scan root — clicking a chat must
  // land on the folder + project it actually lives in. Returns the owning tab's id, or null
  // when the DEFAULT tab owns it / nothing owns it (caller disambiguates).
  const findTabFor = useCallback((projectPath?: string | null, workspacePath?: string | null): string | null =>
    findTabForSession(tabs.tabs, tabs.activeTabId, projectPath, workspacePath),
  [tabs.tabs, tabs.activeTabId]);

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    handleAbortTurn();
    clearPendingCards();
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
    const ownerId = findTabFor(meta?.projectPath, meta?.workspacePath);
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
  }, [sessions, projects, tabs, findTabFor, handleAbortTurn, clearPendingCards, deleteCurrentSessionIfEmpty, setChatFocusSignal]);

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
    clearPendingCards();
    sessions.setShowWelcome(false);
    // Phase T fix: clear the shared conversation buffer before resolving the target session so
    // a failed load/create below can never leave the previous tab's chat visible here.
    sessions.resetConversation();
    if (target.activeSessionId) {
      const s = await sessions.switchSession(target.activeSessionId);
      if (s?.projectId) {
        tabs.setActiveTabProject(s.projectId);
        // The arriving tab's project list was just fetched — resolve the session's project
        // against it (live list via the resolver — this runs after an await) so the terminal
        // header/commands point at the right folder (a chat from another tab's workspace must
        // not keep the previous tab's project active).
        const p = resolveProjectById(s.projectId);
        if (p) projects.setActiveProject(p);
      }
    } else if (target.activeProjectId) {
      const p = resolveProjectById(target.activeProjectId);
      const s = await sessions.createSession(target.activeProjectId, p?.name, tabs.activeTabId);
      tabs.setActiveTabSession(s?.id ?? null);
    } else {
      const s = await sessions.createSession(undefined, undefined, tabs.activeTabId);
      tabs.setActiveTabSession(s?.id ?? null);
    }
    setChatFocusSignal(n => n + 1);
  });

  return {
    handleNewChat,
    handleQuickStart,
    handleScan,
    handleSelectProject,
    handleSelectProjectReuse,
    handleSwitchSession,
    handleSwitchToProject,
  };
}