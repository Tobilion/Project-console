import React, { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { GlowOrbs } from './components/GlowOrbs';
import { AppHeader } from './components/AppHeader';
import { AppMainView } from './components/AppMainView';
import { AppOverlays } from './components/AppOverlays';
import { useConsole } from './hooks/useConsole';
import { useUserProfile } from './hooks/useUserProfile';
import { useTheme } from './hooks/useTheme';
import { useAppGlobalListeners } from './hooks/useAppGlobalListeners';
import { useAppViewState } from './hooks/useAppViewState';
import { getRandomGreeting } from './utils/greetings';
import { readWorkspaceTabs, readToolPanels, WORKSPACE_TAB_KEY, TOOL_PANEL_KEY } from './utils/appStorage';
import type { TourSection } from './tours';
import { GENERAL_PROJECT_ID } from './types';
import type { Project } from './types';

// 2026-08-12: client-side mirror of the server's General pseudo-workspace — passed to the
// Tools panels when no real project is selected, so panel REST calls hit /api/projects/
// __general__/... which the server resolves to its own synthetic project.
const GENERAL_PROJECT: Project = {
  id: GENERAL_PROJECT_ID,
  folderName: 'General',
  name: 'General',
  path: '',
  config: { projectName: 'General', entries: [] },
  contextFiles: [],
  parsedKnowledge: {},
  codebaseIndex: { languages: [], keyFiles: {}, entryPoints: [] },
} as Project;

function App() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Requested directly — the chat panel always shared the screen with the sessions sidebar and
  // the project grid, with no way to just focus on the conversation. Purely a layout toggle: it
  // doesn't touch any chat state, so switching in and out of it never loses anything.
  const [chatFullscreen, setChatFullscreen] = React.useState(false);
  const [showDashboard, setShowDashboard] = React.useState(false);
  const [showCommandRef, setShowCommandRef] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [deckOpen, setDeckOpen] = React.useState(false);
  // "?" keyboard-shortcuts overlay (2026-08-24) — shortcuts should be discoverable, not memory.
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [profileOpen, setProfileOpen] = React.useState(false);
  // Feature B (2026-08-14): the full Chat History overlay (General/Projects tabs), opened
  // from the sidebar's Chats header or the chat's top bar.
  const [chatHistoryOpen, setChatHistoryOpen] = React.useState(false);
  // Phase T2 (2026-08-14): the tour system — an active section (overlay open) or the
  // section picker. Guided steps dispatch 'lpc:tour-view' to switch the main view; the
  // settings modal dispatches 'lpc:launch-tour' to start a section.
  const [tourSection, setTourSection] = React.useState<TourSection | null>(null);
  const [tourPickerOpen, setTourPickerOpen] = React.useState(false);
  const [tourMode, setTourMode] = React.useState<'card' | 'guided'>('guided');
  // Phase 1 workspaceType (UPGRADE-ROADMAP.md, 2026-08-11): per-project Developer/General
  // tab. Restored from localStorage per project (same inline-localStorage style as the pinned
  // projects rail in SidebarDrawer — deliberately NOT global, a user may keep both kinds of
  // workspace open across sessions), falling back to the server's scan-time classification,
  // then 'dev'. 2026-08-12: with no active project the default is 'general' — the General
  // workspace (chat + Tools grid) is the landing surface before any project is picked.
  const [workspaceTab, setWorkspaceTab] = React.useState<'dev' | 'general'>('dev');
  const { profile, updateProfile, getFormattedName, loaded: profileLoaded } = useUserProfile();
  // 2026-08-13: the Ctrl+K deck owns a theme toggle too (shared store with the header
  // ThemeToggle via useTheme's module-level pub/sub, so both stay in sync).
  const { theme, toggleTheme } = useTheme();
  // Gate on `loaded` too, not just `!profile.setupComplete` — the hook's DEFAULT_PROFILE (used
  // before the /api/profile fetch resolves) also has setupComplete: false, so without this the
  // wizard would flash open for every returning user for one render before their real,
  // already-completed profile loads in.
  const showFirstRunSetup = profileLoaded && !profile.setupComplete;
  // Re-rolls the hero greeting only when the profile itself changes (load or save) —
  // not on every render, and not on every keystroke.
  const heroGreeting = useMemo(() => getRandomGreeting(getFormattedName()), [profile]);

  // Stage H: accent-color override. An inline --color-accent-blue on the root element beats
  // the theme stylesheet's :root / :root[data-theme] values. 'auto' removes the override so
  // the cascade re-links to whatever the current theme defines (works across theme toggles
  // with no extra wiring); a hex applies identically in both themes. Lives here rather than
  // in useTheme — ThemeToggle owns the theme state but has no profile access.
  useEffect(() => {
    const root = document.documentElement;
    const accent = profile.accentColor;
    if (!accent || accent === 'auto' || !/^#[0-9A-Fa-f]{6}$/.test(accent)) {
      root.style.removeProperty('--color-accent-blue');
    } else {
      root.style.setProperty('--color-accent-blue', accent);
    }
  }, [profile.accentColor]);

  const {
    projects, activeProject, scanPath, setScanPath, messages,
    pendingConfirm, sessions, activeSessionId,
    aiEnabled, ollamaStatus, aiThinking, aiThinkingText, commandPending, indexingProjectId,
    aiModel, aiMode, showWelcome, setShowWelcome, pendingToolConfirm, chatFocusSignal,
    pendingMemorySuggestion, handleMemorySuggestionRespond,
    handleSendMessage, handleCancel, handleConfirm, handleToolConfirm, handleApproveTask, handleAIToggle,
    handleSetModel, handleSetMode, handleSelectProject, handleSelectProjectReuse, setDisplayName,
    handleSearch, handleDeepResearch, handleNewChat, handleQuickStart, handleScan,
    createSession, switchSession, deleteSession, renameSession, handleSwitchToProject,
    toolHistory, showToolHistory, setShowToolHistory, rerunToolCall,
    exportAsMarkdown, exportAsJson, exportAsPdf, exportProjectChatLog,
    handleDirectCommand, activeServers, knownDevUrls, dashboardUpdateSignal,
    historyTotal, loadedHistory, loadEarlierMessages,
    workspaceProjects, addToWorkspace, removeFromWorkspace, clearWorkspace,
    processes, processLogs, logLoading, selectedProcessId, setSelectedProcessId,
    dockExpanded, setDockExpanded, dockTab, setDockTab, handleStopProcess,
    handleDidYouMeanPick, connected,
    updateNotice, onDismissUpdate,
    toolsOpen, setToolsOpen, activeToolPanel, setActiveToolPanel,
    toolPanels, toolPanelsError, fetchToolPanels,
    tabs, activeTabId, activateTab, duplicateTab, closeTab,
    registerViewSync, isTabSwitchingRef,
  } = useConsole();

  // Phase 9 (2026-08-24 split): global keyboard + tour CustomEvent listeners.
  useAppGlobalListeners({ setDeckOpen, setShortcutsOpen, setShowDashboard, setShowCommandRef, setToolsOpen, setTourPickerOpen, setTourSection });

  // Phase 9 (2026-08-24 split): view-restore effects (per-tab view sync, workspace tab,
  // tool panel, tools fetch, General-tools-first landing).
  useAppViewState({
    registerViewSync, showCommandRef, setShowCommandRef, toolsOpen, setToolsOpen,
    showDashboard, setShowDashboard, activeToolPanel, setActiveToolPanel,
    isTabSwitchingRef, workspaceTab, setWorkspaceTab, activeProject,
    defaultWorkspaceType: profile.defaultWorkspaceType,
    fetchToolPanels, chatFullscreen,
  });

  // Phase 5: dashboard "View logs" jumps to the chat view with the dock open on that
  // project's log tab (the dock's selection IS its filter).
  const handleViewLogs = (projectId: string) => {
    setShowDashboard(false);
    setToolsOpen(false);
    setShowCommandRef(false);
    setDockExpanded(true);
    setDockTab('logs');
    setSelectedProcessId(projectId);
  };

  const handleWorkspaceTabChange = (mode: 'dev' | 'general') => {
    setWorkspaceTab(mode);
    setShowCommandRef(false);
    // 2026-08-12: the General tab is tools-first — landing on the Tools card grid (chat stays
    // reachable via the grid's close/back or the header Tools button). Developer stays chat.
    // 2026-08-14: without an active project the General workspace lands on chat instead, so a
    // user can talk before picking a project; tools-first only kicks in once one is selected.
    if (mode === 'general') {
      setShowDashboard(false);
      if (activeProject?.id) setToolsOpen(true);
      else setToolsOpen(false);
    } else {
      setToolsOpen(false);
    }
    if (!activeProject?.id) return;
    const tabs = readWorkspaceTabs();
    tabs[activeProject.id] = mode;
    try {
      localStorage.setItem(WORKSPACE_TAB_KEY, JSON.stringify(tabs));
    } catch {}
    // Sync the server so its suggestion/help filtering matches immediately — the same
    // pre-matcher admin command as typing "switch to developer mode" in chat (which is also
    // what the CLI users type; it shows up as a normal message in the terminal, and the
    // server's answer confirms the change).
    handleSendMessage(mode === 'dev' ? 'switch to developer mode' : 'switch to general mode');
  };

  // Phase 19 (2026-08-12): LAN display-name attribution — when the server is bound to
  // 0.0.0.0 (HOST env), claim the profile name so action-history/notes/reminders attribute
  // to this person. Single-user 127.0.0.1 installs never trigger this (lanBound is false) —
  // everything stays "local", zero behavior change.
  useEffect(() => {
    let cancelled = false;
    let cancelDisplayName: (() => void) | null = null;
    fetch('/api/connected-users')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.lanBound) return;
        if (profile.name?.trim()) cancelDisplayName = setDisplayName(profile.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      cancelDisplayName?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.name, setDisplayName]);

  const handleOpenToolPanel = (id: string) => {
    setActiveToolPanel(id === '' ? null : id);
    setToolsOpen(true);
    if (!activeProject?.id) return;
    const panels = readToolPanels();
    panels[activeProject.id] = id;
    try {
      localStorage.setItem(TOOL_PANEL_KEY, JSON.stringify(panels));
    } catch {}
  };

  const handleCloseTools = () => {
    setToolsOpen(false);
    setActiveToolPanel(null);
    if (!activeProject?.id) return;
    const panels = readToolPanels();
    panels[activeProject.id] = '';
    try {
      localStorage.setItem(TOOL_PANEL_KEY, JSON.stringify(panels));
    } catch {}
  };

  // `showDirectoryPicker()` opens Chromium's actual native "Select Folder" dialog — distinct
  // from the file-upload chooser that `<input type="file" webkitdirectory>` shows (same picker
  // UI browsers use for "choose files to upload", which is why it read as an upload dialog).
  // It's not supported everywhere (Firefox/Safari lack it), so this falls back to the hidden
  // file input below when unavailable. Either way, the browser still only ever exposes a folder
  // *name*, never an absolute path — that part is a hard File API security limit, not something
  // either picker can work around.
  const handleBrowseFolder = async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker({ mode: 'read' });
        setScanPath(handle.name);
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') return; // user cancelled — not an error
        // Fall through to the legacy picker if the native one errors for some other reason.
      }
    }
    folderInputRef.current?.click();
  };

  const handleFolderPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // `files[0].path` only exists in Electron's Chromium fork, never in a plain browser tab (this
    // app has no Electron/Tauri wrapper) — so in practice this is always undefined here, and we
    // fall through to `webkitRelativePath`, which the File API deliberately keeps *relative*
    // (e.g. "tobi-portfolio/src/App.tsx") for security: a web page can never learn a folder's
    // real absolute location this way, no matter which browser is used.
    const relPath = (files[0] as any).path || files[0].webkitRelativePath;
    if (relPath) {
      // Only the top-level folder name survives being sent to the server — the server then
      // searches its known roots (current scan directory + its parent) for a matching folder
      // name. This won't find a folder on an arbitrary, unrelated drive, but it does cover the
      // common case of picking a sibling folder next to wherever you're already scanning.
      const folderName = relPath.split(/[\\/]/)[0];
      setScanPath(folderName);
    }
    // Reset so re-selecting the same folder triggers onChange again
    e.target.value = '';
  };

  // The chat (Terminal) is the active view only when no other top-level view is open.
  // When it is, confirm cards render inline in the thread; the fixed overlay below
  // exists solely for the non-chat views where this thread is unmounted.
  const chatViewActive = !showCommandRef && !toolsOpen && !showDashboard && !(showWelcome && !chatFullscreen);

  return (
    <div className="h-screen relative flex flex-col">
      <GlowOrbs />

      {!chatFullscreen && (
        <AppHeader
          workspaceTab={workspaceTab}
          onWorkspaceTabChange={handleWorkspaceTabChange}
          activeServersCount={activeServers.length}
          indexingProjectId={indexingProjectId}
          showCommandRef={showCommandRef}
          toolsOpen={toolsOpen}
          showDashboard={showDashboard}
          onHome={() => { setShowDashboard(false); setToolsOpen(false); setChatFullscreen(false); setShowCommandRef(false); setShowWelcome(true); }}
          onToggleDeck={() => setDeckOpen(v => !v)}
          onToggleCommandRef={() => { setShowDashboard(false); setToolsOpen(false); setShowCommandRef(v => !v); }}
          onToggleDashboard={() => { setToolsOpen(false); setShowDashboard(v => !v); }}
          onToggleTools={() => { setShowDashboard(false); setShowCommandRef(false); setToolsOpen(v => !v); }}
          onOpenProfile={() => setProfileOpen(true)}
          onOpenTourPicker={() => setTourPickerOpen(true)}
          folderInputRef={folderInputRef}
          onFolderPick={handleFolderPick}
        />
      )}

      {updateNotice && (
        <div className="relative z-10 flex-shrink-0 mb-3 flex items-center gap-3 px-4 py-2 text-xs text-fg-strong bg-accent/10 border border-accent/20 rounded-lg">
          <span>
            Update available: <span className="font-mono">{updateNotice.current}</span> → <span className="font-mono">{updateNotice.latest}</span>. Type <span className="font-mono">"update console"</span> in chat to install it.
          </span>
          <button onClick={onDismissUpdate} className="ml-auto p-2 text-fg-dim hover:text-fg-strong transition-colors" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <main className="relative z-10 flex-1 min-h-0 overflow-hidden flex flex-col">
        {/* Phase 9 (2026-08-24 split): project tabs + the top-level view switcher
            (Command Reference / Tools / Dashboard / chat). */}
        <AppMainView
          chatFullscreen={chatFullscreen}
          tabs={tabs}
          activeTabId={activeTabId}
          activeProjectName={activeProject?.name ?? null}
          activateTab={activateTab}
          duplicateTab={duplicateTab}
          closeTab={closeTab}
          showCommandRef={showCommandRef}
          setShowCommandRef={setShowCommandRef}
          toolsOpen={toolsOpen}
          toolPanels={toolPanels}
          toolPanelsError={toolPanelsError}
          fetchToolPanels={fetchToolPanels}
          activeToolPanel={activeToolPanel}
          handleOpenToolPanel={handleOpenToolPanel}
          handleCloseTools={handleCloseTools}
          activeProject={activeProject ?? GENERAL_PROJECT}
          handleSendMessage={handleSendMessage}
          aiEnabled={aiEnabled}
          showDashboard={showDashboard}
          setShowDashboard={setShowDashboard}
          dashboardUpdateSignal={dashboardUpdateSignal}
          projects={projects}
          workspaceTab={workspaceTab}
          scanPath={scanPath}
          handleSelectProject={handleSelectProject}
          handleSelectProjectReuse={handleSelectProjectReuse}
          handleViewLogs={handleViewLogs}
          chatWorkspace={{
            chatFullscreen,
            onToggleFullscreen: () => setChatFullscreen(v => !v),
            showWelcome,
            onOpenChatHistory: () => setChatHistoryOpen(true),
            onOpenTourPicker: () => setTourPickerOpen(true),
            sidebar: {
              projects,
              activeProject,
              sessions,
              activeSessionId,
              scanPath,
              setScanPath,
              handleScan,
              handleBrowseFolder,
              createSession,
              switchSession,
              deleteSession,
              renameSession,
              handleSelectProject,
              workspaceProjects,
              addToWorkspace,
              removeFromWorkspace,
              aiEnabled,
              aiModel,
              activeServersCount: activeServers.length,
              collapsed: sidebarCollapsed,
              onSetCollapsed: setSidebarCollapsed,
            },
            welcome: {
              projects,
              activeProject,
              ollamaStatus,
              aiEnabled,
              greeting: heroGreeting,
              onAIToggle: handleAIToggle,
              onSelectProject: handleSelectProject,
              onNewChat: handleNewChat,
              onQuickStart: handleQuickStart,
              workspaceProjects,
              addToWorkspace,
              removeFromWorkspace,
            },
            terminal: {
              messages,
              onSendMessage: handleSendMessage,
              onSearch: handleSearch,
              onDeepResearch: handleDeepResearch,
              activeProject,
              tabId: activeTabId,
              pendingConfirm,
              onConfirm: handleConfirm,
              pendingToolConfirm,
              onToolConfirm: handleToolConfirm,
              onApproveTask: handleApproveTask,
              pendingMemorySuggestion,
              onMemorySuggestionRespond: handleMemorySuggestionRespond,
              aiEnabled,
              aiThinking,
              aiThinkingText,
              commandPending,
              focusSignal: chatFocusSignal,
              onCancel: handleCancel,
              ollamaStatus,
              aiModel,
              aiMode,
              onAIToggle: handleAIToggle,
              onSetModel: handleSetModel,
              onSetMode: handleSetMode,
              toolHistory,
              showToolHistory,
              onToggleToolHistory: () => setShowToolHistory(v => !v),
              onRerunToolCall: rerunToolCall,
              onExportMarkdown: exportAsMarkdown,
              onExportJson: exportAsJson,
              onExportPdf: exportAsPdf,
              onExportProjectChatLog: exportProjectChatLog,
              onDirectCommand: handleDirectCommand,
              onDidYouMeanPick: handleDidYouMeanPick,
              workspaceProjects,
              addToWorkspace,
              removeFromWorkspace,
              clearWorkspace,
              onSwitchToProject: handleSwitchToProject,
              processes,
              processLogs,
              logLoading,
              selectedProcessId,
              onSelectProcess: setSelectedProcessId,
              onStopProcess: handleStopProcess,
              dockExpanded,
              onToggleDock: () => setDockExpanded(v => !v),
              dockTab,
              onSetDockTab: setDockTab,
              projects,
              knownDevUrls,
              userName: profile.name,
              connected,
              historyHasMore: loadedHistory > 0 && loadedHistory < historyTotal,
              onLoadEarlier: loadEarlierMessages,
            },
          }}
        />
      </main>

      {/* 2026-08-24 split: every fixed overlay (confirm cards, deck, modals, tours,
          shortcuts, toasts) lives in AppOverlays. */}
      <AppOverlays
        chatViewActive={chatViewActive}
        pendingConfirm={pendingConfirm}
        handleConfirm={handleConfirm}
        pendingToolConfirm={pendingToolConfirm}
        handleToolConfirm={handleToolConfirm}
        handleApproveTask={handleApproveTask}
        pendingMemorySuggestion={pendingMemorySuggestion}
        handleMemorySuggestionRespond={handleMemorySuggestionRespond}
        deckOpen={deckOpen}
        setDeckOpen={setDeckOpen}
        deck={{
          projects,
          activeProject,
          sessions,
          onSelectProject: handleSelectProject,
          onSwitchSession: switchSession,
          onDirectCommand: handleDirectCommand,
          onSendMessage: handleSendMessage,
          onHome: () => { setShowDashboard(false); setToolsOpen(false); setChatFullscreen(false); setShowCommandRef(false); setShowWelcome(true); },
          onToggleDashboard: () => { setToolsOpen(false); setShowDashboard(v => !v); },
          onOpenCommandRef: () => { setShowDashboard(false); setToolsOpen(false); setShowCommandRef(true); },
          onNewChat: handleNewChat,
          sidebarCollapsed,
          onSetSidebarCollapsed: setSidebarCollapsed,
          theme,
          onToggleTheme: toggleTheme,
          onOpenProfile: () => setProfileOpen(true),
          chatFullscreen,
          onToggleFullscreen: () => setChatFullscreen(v => !v),
          onOpenTools: () => { setShowDashboard(false); setShowCommandRef(false); setToolsOpen(true); },
          onOpenPanel: handleOpenToolPanel,
          toolPanels,
          workspaceTab,
          onSetWorkspaceTab: handleWorkspaceTabChange,
          aiEnabled,
          onToggleAI: handleAIToggle,
          onExportMarkdown: exportAsMarkdown,
          onExportJson: exportAsJson,
          onExportPdf: exportAsPdf,
          onExportProjectChatLog: exportProjectChatLog,
          dockExpanded,
          onToggleDock: () => setDockExpanded(v => !v),
          dockTab,
          onSetDockTab: setDockTab,
          showToolHistory,
          onToggleToolHistory: () => setShowToolHistory(v => !v),
          onOpenTourPicker: () => setTourPickerOpen(true),
        }}
        chatHistoryOpen={chatHistoryOpen}
        setChatHistoryOpen={setChatHistoryOpen}
        history={{
          sessions,
          activeSessionId,
          onSwitchSession: switchSession,
          onNewChat: handleNewChat,
          onDeleteSession: deleteSession,
          onRenameSession: renameSession,
        }}
        profileOpen={profileOpen}
        setProfileOpen={setProfileOpen}
        profile={profile}
        updateProfile={updateProfile}
        firstRun={{
          open: showFirstRunSetup,
          scanPath,
          setScanPath,
          handleScan,
          onFinish: updateProfile,
        }}
        tourPickerOpen={tourPickerOpen}
        setTourPickerOpen={setTourPickerOpen}
        tourSection={tourSection}
        setTourSection={setTourSection}
        tourMode={tourMode}
        setTourMode={setTourMode}
        shortcutsOpen={shortcutsOpen}
        setShortcutsOpen={setShortcutsOpen}
      />
    </div>
  );
}

export default App;