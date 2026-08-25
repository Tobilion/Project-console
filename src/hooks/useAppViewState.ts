// View-restore effects (2026-08-24, split out of App.tsx): everything that re-derives the
// top-level view from persisted/tab/server state — per-tab view snapshots, the per-project
// workspace tab, the per-project last-open tool panel, the lazy Tools registry fetch, and
// the General-tools-first landing. All effects are pure setters over the passed-in state.

import { useEffect } from 'react';
import { readWorkspaceTabs, readToolPanels } from '../utils/appStorage';

export interface UseAppViewStateDeps {
  registerViewSync: (sync: { snapshot: () => { view: 'chat' | 'dashboard' | 'tools' | 'commandRef'; activeToolPanel: string | null }; restore: (saved: { view: string; activeToolPanel?: string | null }) => void }) => void;
  showCommandRef: boolean;
  setShowCommandRef: React.Dispatch<React.SetStateAction<boolean>>;
  toolsOpen: boolean;
  setToolsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  showDashboard: boolean;
  setShowDashboard: React.Dispatch<React.SetStateAction<boolean>>;
  activeToolPanel: string | null;
  setActiveToolPanel: React.Dispatch<React.SetStateAction<string | null>>;
  isTabSwitchingRef: React.MutableRefObject<boolean>;
  workspaceTab: 'dev' | 'general';
  setWorkspaceTab: React.Dispatch<React.SetStateAction<'dev' | 'general'>>;
  activeProject: { id: string; workspaceType?: string } | null;
  defaultWorkspaceType: 'dev' | 'general' | undefined;
  fetchToolPanels: () => void;
  chatFullscreen: boolean;
}

export function useAppViewState(deps: UseAppViewStateDeps) {
  const {
    registerViewSync, showCommandRef, setShowCommandRef, toolsOpen, setToolsOpen,
    showDashboard, setShowDashboard, activeToolPanel, setActiveToolPanel,
    isTabSwitchingRef, workspaceTab, setWorkspaceTab, activeProject,
    defaultWorkspaceType, fetchToolPanels, chatFullscreen,
  } = deps;

  // Per-tab view restoration (Phase T fix, 2026-08-14): the top-level view (chat / dashboard /
  // tools / command reference) and the open tool panel used to be purely global state, so a
  // tab that was in the Folder Explorer came back on the previous tab's chat/dashboard view.
  // The tabs hook snapshots this before switching away and calls restore() after switching to
  // the arriving tab — re-registered whenever the view state changes so snapshot() always
  // reads the current (leaving) tab's view.
  useEffect(() => {
    registerViewSync({
      snapshot: () => {
        const view = showCommandRef ? 'commandRef' : toolsOpen ? 'tools' : showDashboard ? 'dashboard' : 'chat';
        return { view, activeToolPanel };
      },
      restore: (saved) => {
        setShowCommandRef(saved.view === 'commandRef');
        setToolsOpen(saved.view === 'tools');
        setShowDashboard(saved.view === 'dashboard');
        setActiveToolPanel(saved.activeToolPanel ?? null);
      },
    });
  }, [registerViewSync, showCommandRef, toolsOpen, showDashboard, activeToolPanel, setToolsOpen, setActiveToolPanel, setShowCommandRef, setShowDashboard]);

  // Phase 1: restore the active project's last-selected tab. Runs only when the active
  // project changes (never on a tab switch — that path writes, it doesn't read back).
  // 2026-08-12: no active project -> 'general' (the General workspace is the landing surface
  // before a project is picked; per-project tabs still win once one is active). Phase 13: the
  // profile's first-run defaultWorkspaceType is the fallback when a project isn't classified.
  useEffect(() => {
    const tabs = readWorkspaceTabs();
    const saved = activeProject?.id ? tabs[activeProject.id] : undefined;
    // workspaceType is the server's scan-time classification — sanitized to the union here
    // (the profile default and 'general' fallback keep the same precedence as before).
    const wsType = activeProject?.workspaceType === 'dev' || activeProject?.workspaceType === 'general'
      ? activeProject.workspaceType
      : undefined;
    setWorkspaceTab(saved ?? wsType ?? defaultWorkspaceType ?? 'general');
  }, [activeProject?.id, activeProject?.workspaceType, defaultWorkspaceType, setWorkspaceTab]);

  // 2026-08-12: General is tools-first — whenever the General tab is active and nothing else
  // has claimed the main view (dashboard off, no explicit tool panel pick yet), land on the
  // Tools card grid so a non-technical user immediately sees the panels. Chat stays reachable
  // through the grid's close/back and the header Tools toggle.
  // 2026-08-14: only when a project is active. With no project picked the General workspace is
  // chat-first (the user can talk before choosing a project), so the tools grid is not forced.
  useEffect(() => {
    // A tab switch restores the arriving tab's own view — never force the tools grid open
    // while that restore is in flight (the user chose "tab's saved view wins").
    if (isTabSwitchingRef.current) return;
    if (workspaceTab === 'general' && activeProject?.id && !showDashboard && !activeToolPanel && !chatFullscreen) {
      setToolsOpen(true);
    }
  }, [workspaceTab, activeProject?.id, showDashboard, activeToolPanel, chatFullscreen, isTabSwitchingRef, setToolsOpen]);

  // Phase 1.5: the Tools surface (shared interactive tool panels). The per-project last-open
  // panel persists via console.toolPanelByProject (restore effect below), mirroring Phase 1's
  // workspace-tab persistence.
  useEffect(() => {
    // Skip during a tab switch — the tabs hook restores the arriving tab's own panel (via
    // viewSync.restore) and that must not be overwritten by this project-keyed persistence.
    if (isTabSwitchingRef.current) return;
    const saved = activeProject?.id ? readToolPanels()[activeProject.id] : undefined;
    setActiveToolPanel(saved ?? null);
  }, [activeProject?.id, isTabSwitchingRef, setActiveToolPanel]);

  // The registry is fetched lazily the first time the Tools view opens — server-driven so a
  // later phase can report per-tool availability without a client restructure.
  useEffect(() => {
    if (toolsOpen) fetchToolPanels();
  }, [toolsOpen, fetchToolPanels]);
}