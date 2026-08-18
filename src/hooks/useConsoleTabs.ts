import { useCallback, useEffect, useRef, useState } from 'react';
import { Project } from '../types';
import { useProjects } from './useProjects';

// Phase T (2026-08-14): Chrome-style tab strip with per-tab scan roots. Each tab owns its own
// scan folder + project list + active project + open chat session; the server keeps per-tab
// workspaces (see state.js's tabWorkspaces) addressed via ?tab=<id> on REST calls, so two tabs
// can scan different folders without clobbering each other.
//
// Design: the tabs are UI metadata + a snapshot of per-tab state (scanPath, activeProjectId,
// activeSessionId). The LIVE project state stays in useProjects (the active tab's view); on
// tab switch the hook snapshots the leaving tab, restores the arriving tab's snapshot, and
// re-fetches /api/projects?tab=<id> so the list reflects that tab's server-side workspace.
// Sessions are global and server-persisted — each tab remembers which session was open, and a
// registered session-switch callback (provided by useConsole, which owns the sessions hook)
// reloads it on activation.
//
// The default tab (id null) IS the global workspace — the pre-tab behavior, so nothing breaks
// for CLI/legacy clients. Persistence: localStorage console.tabs (metadata only; the server
// workspaces are session-lifetime and recreated on reload by re-scanning each tab's stored
// root — restoreTabs runs on mount before any fetch).

export type TabView = 'chat' | 'dashboard' | 'tools' | 'commandRef';

export interface ConsoleTab {
  id: string | null;             // null = the default/global workspace tab
  scanPath: string;
  activeProjectId: string | null;
  activeSessionId: string | null;
  // Per-tab top-level view + which tool panel was open — restored on activation so a tab
  // returns to exactly where it was (Folder Explorer / Dashboard / chat), not the previous
  // tab's view. See the registered viewSync in App.tsx.
  view: TabView;
  activeToolPanel: string | null;
}

function defaultTab(): ConsoleTab {
  return { id: null, scanPath: '', activeProjectId: null, activeSessionId: null, view: 'chat', activeToolPanel: null };
}

const TABS_KEY = 'console.tabs';
const ACTIVE_TAB_KEY = 'console.activeTab';

function newTabId(): string {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadPersistedTabs(): ConsoleTab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const tabs = parsed
          .filter((t) => t && (t.id === null || typeof t.id === 'string'))
          .map((t) => ({
            id: t.id === null ? null : String(t.id),
            scanPath: typeof t.scanPath === 'string' ? t.scanPath : '',
            activeProjectId: typeof t.activeProjectId === 'string' ? t.activeProjectId : null,
            activeSessionId: typeof t.activeSessionId === 'string' ? t.activeSessionId : null,
            view: t.view === 'dashboard' || t.view === 'tools' || t.view === 'commandRef' ? t.view : 'chat',
            activeToolPanel: typeof t.activeToolPanel === 'string' ? t.activeToolPanel : null,
          }));
        // The default tab must always exist — a strip of only uuid tabs has no global workspace.
        if (!tabs.some((t) => t.id === null)) {
          tabs.unshift(defaultTab());
        }
        return tabs;
      }
    }
  } catch { /* corrupt storage — fall back to the single default tab */ }
  return [defaultTab()];
}

export function useConsoleTabs(projects: ReturnType<typeof useProjects>) {
  const [tabs, setTabs] = useState<ConsoleTab[]>(loadPersistedTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    const persisted = loadPersistedTabs();
    try {
      const stored = localStorage.getItem(ACTIVE_TAB_KEY);
      if (stored !== null) {
        const found = persisted.find((t) => t.id === stored);
        if (found) return found.id;
      }
    } catch {}
    return persisted[0]?.id ?? null;
  });
  const restoredRef = useRef(false);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  // Registered by useConsole once the sessions hook exists — switching a tab reloads that
  // tab's session (or starts a fresh one) through the same path as clicking a chat in the
  // sidebar, so confirm cards/pending state are cleared identically.
  const sessionSwitcherRef = useRef<(tab: ConsoleTab) => Promise<void>>(async () => {});
  // Registered by App (which owns the top-level view state). snapshot() derives the active
  // tab's current view + tool panel; restore() applies an arriving tab's saved view. The
  // view lives in App because several callers (header buttons, WS openPanel, tour events)
  // already set it there — this hook only snapshots/restores around tab switches.
  const viewSyncRef = useRef<{
    snapshot: () => { view: TabView; activeToolPanel: string | null };
    restore: (saved: { view: TabView; activeToolPanel: string | null }) => void;
  }>({
    snapshot: () => ({ view: 'chat', activeToolPanel: null }),
    restore: () => {},
  });
  // True while a tab switch is in flight — App's "General is tools-first" and per-project
  // tool-panel effects must not overwrite a restored tab's view during the switch.
  const isTabSwitchingRef = useRef(false);

  // Persist tab metadata (not the full project lists — those live server-side per tab).
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map((t) => ({
        id: t.id, scanPath: t.scanPath, activeProjectId: t.activeProjectId, activeSessionId: t.activeSessionId,
        view: t.view, activeToolPanel: t.activeToolPanel,
      }))));
    } catch {}
  }, [tabs]);
  useEffect(() => {
    if (activeTabId !== null) {
      try { localStorage.setItem(ACTIVE_TAB_KEY, activeTabId); } catch {}
    }
  }, [activeTabId]);

  const setSessionSwitcher = useCallback((fn: (tab: ConsoleTab) => Promise<void>) => {
    sessionSwitcherRef.current = fn;
  }, []);

  const registerViewSync = useCallback((fn: typeof viewSyncRef.current) => {
    viewSyncRef.current = fn;
  }, []);

  const getActiveTab = useCallback(() => {
    return tabs.find((t) => t.id === activeTabIdRef.current) || tabs[0] || defaultTab();
  }, [tabs]);

  // Snapshot the active tab's live state back into the tabs array (called before switching
  // away, so a tab never loses its folder/project/chat while it's inactive).
  const snapshotActiveTab = useCallback((overrides: Partial<ConsoleTab> = {}) => {
    const id = activeTabIdRef.current;
    const cur = tabs.find((t) => t.id === id);
    const live = viewSyncRef.current.snapshot();
    const snap: ConsoleTab = {
      id,
      scanPath: projects.scanPath || cur?.scanPath || '',
      activeProjectId: projects.activeProject?.id ?? cur?.activeProjectId ?? null,
      activeSessionId: cur?.activeSessionId ?? null,
      view: live.view,
      activeToolPanel: live.activeToolPanel,
      ...overrides,
    };
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return [...prev, snap];
      const next = [...prev];
      next[idx] = snap;
      return next;
    });
  }, [tabs, projects.scanPath, projects.activeProject]);

  // Restore persisted tabs on mount: re-create each non-default tab's server workspace by
  // re-scanning its stored root, then fetch the active tab's list. Returns when the active
  // tab's projects are loaded so the caller (useConsole's mount effect) can proceed.
  const restoreTabs = useCallback(async () => {
    const persisted = loadPersistedTabs();
    setTabs(persisted);
    const storedActive = (() => {
      try { return localStorage.getItem(ACTIVE_TAB_KEY); } catch { return null; }
    })();
    const targetId = storedActive !== null && persisted.some((t) => t.id === storedActive)
      ? storedActive
      : persisted[0]?.id ?? null;
    setActiveTabId(targetId);
    restoredRef.current = true;
    isTabSwitchingRef.current = true;
    try {
      // Phase 6 (2026-08-17): restore every persisted tab's workspace CONCURRENTLY — the
      // serial loop paid one full server scan per tab back to back (N tabs x heavy roots =
      // N scans). First learn the server's current scan root from the global workspace
      // (cheap: a cache hit after boot primes it), then any tab whose stored root equals
      // it skips the re-scan — its workspace resolves to the global root anyway. Tabs with
      // custom roots must each scan (per-tab workspaces are server-side per tab), so the
      // remaining calls run in parallel.
      const globalFetch = await projects.fetchProjects(null).catch(() => null);
      const serverRoot = globalFetch?.scanPath || '';
      const nonDefault = persisted.filter((t) => t.id !== null);
      await Promise.all(nonDefault.map(async (tab) => {
        if (!tab.scanPath || tab.scanPath === serverRoot) {
          await projects.fetchProjects(tab.id).catch(() => {});
        } else {
          await projects.scanNewPath(tab.scanPath, tab.id).catch(() => {});
        }
      }));
      await projects.fetchProjects(targetId);
      // Restore the persisted view for the active tab (a reloaded tab should land where it
      // was — e.g. back in the Folder Explorer), then clear the switch guard.
      const targetTab = persisted.find((t) => t.id === targetId);
      if (targetTab) {
        viewSyncRef.current.restore({ view: targetTab.view, activeToolPanel: targetTab.activeToolPanel });
      }
    } finally {
      isTabSwitchingRef.current = false;
    }
  }, [projects]);

  // Switch to another tab: snapshot the leaving tab, restore the arriving tab's snapshot,
  // fetch its project list from the server, then reload its session through the registered
  // switcher (which clears confirm cards and pending state like any chat switch).
  // `preferredSessionId` (Phase T2 fix, 2026-08-14): when switching tabs because a chat was
  // clicked in the sidebar and that chat belongs to ANOTHER tab's workspace, open the CLICKED
  // chat instead of the arriving tab's saved one — the switcher uses the preferred session
  // when given, else the tab's own activeSessionId.
  const activateTab = useCallback(async (tabId: string | null, preferredSessionId?: string | null) => {
    if (tabId === activeTabIdRef.current) {
      // Already on this tab, but the caller wants a specific chat open (sidebar click on a
      // session of the active tab's own workspace) — reload that session via the switcher.
      if (preferredSessionId) {
        await sessionSwitcherRef.current({ id: tabId, scanPath: '', activeProjectId: null, activeSessionId: preferredSessionId, view: 'chat', activeToolPanel: null });
      }
      return;
    }
    snapshotActiveTab();
    const tab = tabs.find((t) => t.id === tabId);
    const target = tab || { id: tabId, scanPath: '', activeProjectId: null, activeSessionId: null, view: 'chat', activeToolPanel: null };
    setActiveTabId(tabId);
    isTabSwitchingRef.current = true;
    try {
      const fetched = await projects.fetchProjects(tabId);
      if (target.scanPath) projects.setScanPath(target.scanPath);
      // Restore the arriving tab's project selection (re-derive from the freshly fetched list —
      // reading projects.projects here would be the pre-fetch stale state).
      if (target.activeProjectId && fetched) {
        const p = fetched.projects.find((pr: Project) => pr.id === target.activeProjectId);
        if (p) projects.setActiveProject(p);
      }
      // Restore the arriving tab's view (Folder Explorer / Dashboard / chat) now that its
      // project/scanPath are in place — the session reload below must not reset it.
      viewSyncRef.current.restore({ view: target.view, activeToolPanel: target.activeToolPanel });
      await sessionSwitcherRef.current({ ...target, activeSessionId: preferredSessionId ?? target.activeSessionId });
    } finally {
      isTabSwitchingRef.current = false;
    }
  }, [tabs, projects, snapshotActiveTab]);

  // "Duplicate tab": new tab starting from the CURRENT tab's scan folder, so the first tab
  // keeps its folder while the new one can scan somewhere else.
  const duplicateTab = useCallback(async () => {
    const cur = getActiveTab();
    snapshotActiveTab();
    const id = newTabId();
    // Inherit the source tab's scan folder AND its current view + panel — a duplicated tab
    // starts where the original was (e.g. both can open the Folder Explorer on the same
    // folder before one scans somewhere else).
    const live = viewSyncRef.current.snapshot();
    const tab: ConsoleTab = {
      id,
      scanPath: cur.scanPath || projects.scanPath || '',
      activeProjectId: null,
      activeSessionId: null,
      view: live.view,
      activeToolPanel: live.activeToolPanel,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    isTabSwitchingRef.current = true;
    try {
      if (tab.scanPath) {
        await projects.scanNewPath(tab.scanPath, id).catch(() => {});
      }
      await projects.fetchProjects(id);
      viewSyncRef.current.restore({ view: tab.view, activeToolPanel: tab.activeToolPanel });
      await sessionSwitcherRef.current(tab);
    } finally {
      isTabSwitchingRef.current = false;
    }
  }, [projects, getActiveTab, snapshotActiveTab]);

  // "Open workspace in a new tab" (Feature A, 2026-08-14): a chat remembers the scan root it
  // was created in (workspacePath). When the user taps such a chat and NO existing tab owns
  // that folder (the tab was closed, or the chat predates the current tab set), create a tab
  // for it, scan that folder, and open the clicked chat — so a chat from Downloads always
  // lands back in Downloads even if its original tab is gone.
  const openWorkspaceTab = useCallback(async (scanPath: string, preferredSessionId?: string | null) => {
    if (!scanPath) return;
    snapshotActiveTab();
    const id = newTabId();
    const tab: ConsoleTab = {
      id,
      scanPath,
      activeProjectId: null,
      activeSessionId: null,
      view: 'chat',
      activeToolPanel: null,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    isTabSwitchingRef.current = true;
    try {
      // A folder that no longer exists must not strand the user on a broken tab — the scan
      // error is swallowed (the chat still opens from its own session files either way).
      await projects.scanNewPath(scanPath, id).catch(() => {});
      await projects.fetchProjects(id);
      viewSyncRef.current.restore({ view: tab.view, activeToolPanel: tab.activeToolPanel });
      await sessionSwitcherRef.current({ ...tab, activeSessionId: preferredSessionId ?? null });
    } finally {
      isTabSwitchingRef.current = false;
    }
  }, [projects, snapshotActiveTab]);

  const closeTab = useCallback(async (tabId: string | null) => {
    // Every tab is closable — including the default/global one. The ≥1-tab invariant is
    // enforced below: closing the last remaining tab leaves a fresh default tab behind.
    const leavingActive = tabId === activeTabIdRef.current;
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      return next.length > 0 ? next : [defaultTab()];
    });
    if (leavingActive) {
      // Activate the tab to the LEFT of the closed one (Chrome/VS Code behavior). The index
      // must come from the PRE-close list — `remaining` already excludes the closed tab, so a
      // findIndex over it always returns -1 and Math.max(0, -2) jumped to the first tab
      // instead (audit 2026-08-17).
      const remaining = tabs.filter((t) => t.id !== tabId);
      const closedIndex = tabs.findIndex((t) => t.id === tabId);
      const left = tabs[closedIndex - 1];
      const right = tabs[closedIndex + 1];
      const next = left || right || remaining[0] || defaultTab();
      await activateTab(next.id);
    }
  }, [tabs, activateTab]);

  // Keep the active tab's session id fresh as chats open/close within it.
  const setActiveTabSession = useCallback((sessionId: string | null) => {
    const id = activeTabIdRef.current;
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, activeSessionId: sessionId } : t));
  }, []);
  // And its active project (after a project click / session-derived project change).
  const setActiveTabProject = useCallback((projectId: string | null) => {
    const id = activeTabIdRef.current;
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, activeProjectId: projectId } : t));
  }, []);

  return {
    tabs, activeTabId, restoreTabs, activateTab, duplicateTab, closeTab, openWorkspaceTab,
    setSessionSwitcher, registerViewSync, isTabSwitchingRef, setActiveTabSession, setActiveTabProject, snapshotActiveTab,
  };
}
