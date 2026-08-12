import React, { useEffect, useMemo, useRef } from 'react';
import { GlowOrbs } from './components/GlowOrbs';
import { TextScramble } from './components/TextScramble';
import { SidebarDrawer } from './components/SidebarDrawer';
import { Terminal } from './components/Terminal';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Dashboard } from './components/Dashboard';
import { ToolsPanel } from './components/ToolsPanel';
import { CommandDeck } from './components/CommandDeck';
import { useConsole } from './hooks/useConsole';
import { useUserProfile } from './hooks/useUserProfile';
import { getRandomGreeting } from './utils/greetings';
import { Home, LayoutDashboard, LayoutGrid, Search, Settings, Loader2, X } from 'lucide-react';
import { ThemeToggle } from './components/ui/ThemeToggle';
import { UserProfileModal } from './components/UserProfileModal';
import { FirstRunSetup } from './components/FirstRunSetup';
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

// Phase 1 per-project workspace tab persistence — key + helpers live next to the component
// that owns them (same convention as the pinned-projects rail's inline localStorage usage in
// SidebarDrawer). A plain JSON map of projectId -> 'dev' | 'general'; malformed/stale entries
// are ignored and simply re-derived from the project's server-side workspaceType.
const WORKSPACE_TAB_KEY = 'console.workspaceTabByProject';
function readWorkspaceTabs(): Record<string, 'dev' | 'general'> {
  try {
    const raw = localStorage.getItem(WORKSPACE_TAB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}

// Phase 1.5 per-project last-open tool panel — same inline-localStorage style as the
// workspace tab above. A plain JSON map of projectId -> tool panel id ('' = grid). Restored
// into the Tools surface's selection when the project changes; the Tools view itself only
// opens on an explicit gesture (header button or the chat's `openPanel` instruction).
const TOOL_PANEL_KEY = 'console.toolPanelByProject';
function readToolPanels(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TOOL_PANEL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return {};
}

function App() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Requested directly — the chat panel always shared the screen with the sessions sidebar and
  // the project grid, with no way to just focus on the conversation. Purely a layout toggle: it
  // doesn't touch any chat state, so switching in and out of it never loses anything.
  const [chatFullscreen, setChatFullscreen] = React.useState(false);
  const [showDashboard, setShowDashboard] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [deckOpen, setDeckOpen] = React.useState(false);
  const [profileOpen, setProfileOpen] = React.useState(false);
  // Phase 1 workspaceType (UPGRADE-ROADMAP.md, 2026-08-11): per-project Developer/General
  // tab. Restored from localStorage per project (same inline-localStorage style as the pinned
  // projects rail in SidebarDrawer — deliberately NOT global, a user may keep both kinds of
  // workspace open across sessions), falling back to the server's scan-time classification,
  // then 'dev'. 2026-08-12: with no active project the default is 'general' — the General
  // workspace (chat + Tools grid) is the landing surface before any project is picked.
  const [workspaceTab, setWorkspaceTab] = React.useState<'dev' | 'general'>('dev');
  const { profile, updateProfile, getFormattedName, loaded: profileLoaded } = useUserProfile();
  // Gate on `loaded` too, not just `!profile.setupComplete` — the hook's DEFAULT_PROFILE (used
  // before the /api/profile fetch resolves) also has setupComplete: false, so without this the
  // wizard would flash open for every returning user for one render before their real,
  // already-completed profile loads in.
  const showFirstRunSetup = profileLoaded && !profile.setupComplete;
  // Re-rolls the hero greeting only when the profile itself changes (load or save) —
  // not on every render, and not on every keystroke.
  const heroGreeting = useMemo(() => getRandomGreeting(getFormattedName()), [profile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setDeckOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const {
    projects, activeProject, scanPath, setScanPath, messages,
    pendingConfirm, sessions, activeSessionId,
    aiEnabled, ollamaStatus, aiThinking, aiThinkingText, commandPending, indexingProjectId,
    aiModel, aiMode, showWelcome, setShowWelcome, pendingToolConfirm,
    pendingMemorySuggestion, handleMemorySuggestionRespond,
    handleSendMessage, handleCancel, handleConfirm, handleToolConfirm, handleApproveTask, handleAIToggle,
    handleSetModel, handleSetMode, handleSelectProject,
    handleSearch, handleDeepResearch, handleNewChat, handleQuickStart, handleScan,
    createSession, switchSession, deleteSession, renameSession, handleSwitchToProject,
    toolHistory, showToolHistory, setShowToolHistory, rerunToolCall,
    exportAsMarkdown, exportAsJson, exportAsPdf, exportProjectChatLog,
    handleDirectCommand, activeServers, knownDevUrls, dashboardUpdateSignal,
    workspaceProjects, addToWorkspace, removeFromWorkspace, clearWorkspace,
    processes, processLogs, selectedProcessId, setSelectedProcessId,
     dockExpanded, setDockExpanded, dockTab, setDockTab, handleStopProcess,
     handleDidYouMeanPick, connected,
     updateNotice, onDismissUpdate,
     toolsOpen, setToolsOpen, activeToolPanel, setActiveToolPanel,
     toolPanels, fetchToolPanels,
   } = useConsole();

  // Phase 1: restore the active project's last-selected tab. Runs only when the active
  // project changes (never on a tab switch — that path writes, it doesn't read back).
  // 2026-08-12: no active project -> 'general' (the General workspace is the landing surface
  // before a project is picked; per-project tabs still win once one is active).
  useEffect(() => {
    const tabs = readWorkspaceTabs();
    const saved = activeProject?.id ? tabs[activeProject.id] : undefined;
    setWorkspaceTab(saved ?? activeProject?.workspaceType ?? 'general');
  }, [activeProject?.id, activeProject?.workspaceType]);

  const handleWorkspaceTabChange = (mode: 'dev' | 'general') => {
    setWorkspaceTab(mode);
    // 2026-08-12: the General tab is tools-first — landing on the Tools card grid (chat stays
    // reachable via the grid's close/back or the header Tools button). Developer stays chat.
    if (mode === 'general') {
      setShowDashboard(false);
      setToolsOpen(true);
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

  // 2026-08-12: General is tools-first — whenever the General tab is active and nothing else
  // has claimed the main view (dashboard off, no explicit tool panel pick yet), land on the
  // Tools card grid so a non-technical user immediately sees the panels. Chat stays reachable
  // through the grid's close/back and the header Tools toggle.
  useEffect(() => {
    if (workspaceTab === 'general' && !showDashboard && !activeToolPanel && !chatFullscreen) {
      setToolsOpen(true);
    }
  }, [workspaceTab, showDashboard, activeToolPanel, chatFullscreen]);

  // Phase 1.5: the Tools surface (shared interactive tool panels). Clicking a card opens that
  // tool's dedicated panel in the same top-level view space Terminal/Dashboard use; the
  // "back" button returns to the card grid ('' keeps the Tools view open, just unpicked).
  // The per-project last-open panel persists via console.toolPanelByProject (restore effect
  // below), mirroring Phase 1's workspace-tab persistence.
  useEffect(() => {
    const saved = activeProject?.id ? readToolPanels()[activeProject.id] : undefined;
    setActiveToolPanel(saved ?? null);
  }, [activeProject?.id]);

  // The registry is fetched lazily the first time the Tools view opens — server-driven so a
  // later phase can report per-tool availability without a client restructure.
  useEffect(() => {
    if (toolsOpen) fetchToolPanels();
  }, [toolsOpen, fetchToolPanels]);

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

  return (
    <div className={`h-screen relative flex flex-col ${chatFullscreen ? '' : 'p-6'}`}>
      <GlowOrbs />

      {!chatFullscreen && (
      <header className="relative z-10 flex-shrink-0 flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-semibold italic text-fg-strong whitespace-nowrap">
            <TextScramble text="Project Console" />
          </h1>
          <p className="text-[10px] tracking-[0.2em] uppercase text-fg-dim font-bold hidden sm:inline">
            Local Project Engine
          </p>
          {indexingProjectId && (
            <span className="text-xs text-yellow-400 animate-pulse"><Loader2 size={12} className="inline-block mr-1 animate-spin" />Indexing...</span>
          )}
        </div>
        <div className="flex items-center gap-2 ml-auto flex-shrink-0">
          <div className="flex items-center gap-1 bg-scrim-faint rounded-lg p-0.5 border border-border-soft">
            <button
              onClick={() => handleWorkspaceTabChange('dev')}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${workspaceTab === 'dev' ? 'bg-panel-strong text-fg-strong' : 'text-fg-dim hover:text-fg-muted'}`}
              title="Developer workspace — git/npm/run/diagnostics suggestions"
            >
              Developer
            </button>
            <button
              onClick={() => handleWorkspaceTabChange('general')}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${workspaceTab === 'general' ? 'bg-panel-strong text-fg-strong' : 'text-fg-dim hover:text-fg-muted'}`}
              title="General workspace — file tools, notes, reminders, PDF tools"
            >
              General
            </button>
          </div>
          {activeServers.length > 0 && (
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-green-400 bg-green-500/10 rounded-lg border border-green-500/20 whitespace-nowrap flex-shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block animate-pulse" />
              {activeServers.length} running
            </span>
          )}
          {window.location.port && (
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg-strong font-mono bg-scrim-faint rounded-lg border border-border-soft whitespace-nowrap flex-shrink-0"
              title={`Console running at http://${window.location.hostname}:${window.location.port}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block animate-pulse" />
              :{window.location.port}
            </span>
          )}
          <button onClick={() => { setShowDashboard(false); setToolsOpen(false); setChatFullscreen(false); setShowWelcome(true); }} className="p-2 text-fg-dim hover:text-fg-strong transition-colors" title="Home">
            <Home size={18} />
          </button>
          <button onClick={() => setDeckOpen(v => !v)} className="p-2 text-fg-dim hover:text-fg-strong transition-colors" title="Command deck (Ctrl+K)">
            <Search size={18} />
          </button>
          <button onClick={() => { setToolsOpen(false); setShowDashboard(v => !v); }} className={`p-2 transition-colors ${showDashboard ? 'text-accent' : 'text-fg-dim hover:text-fg-strong'}`} title="Dashboard">
            <LayoutDashboard size={18} />
          </button>
          {workspaceTab === 'general' && (
            <button onClick={() => { setShowDashboard(false); setToolsOpen(v => !v); }} className={`p-2 transition-colors ${toolsOpen ? 'text-accent' : 'text-fg-dim hover:text-fg-strong'}`} title="Interactive tools (General workspace)">
              <LayoutGrid size={18} />
            </button>
          )}
          <button onClick={() => setProfileOpen(true)} className="p-2 text-fg-dim hover:text-fg-strong transition-colors" title="User profile">
            <Settings size={18} />
          </button>
          <ThemeToggle />
        </div>
        <input
          ref={folderInputRef}
          type="file"
          onChange={handleFolderPick}
          className="hidden"
          /* @ts-ignore */
          webkitdirectory=""
          directory=""
        />
      </header>
      )}

      {updateNotice && (
        <div className="relative z-10 flex-shrink-0 mb-3 flex items-center gap-3 px-4 py-2 text-xs text-fg-strong bg-accent/10 border border-accent/20 rounded-lg">
          <span>
            Update available: <span className="font-mono">{updateNotice.current}</span> → <span className="font-mono">{updateNotice.latest}</span>. Type <span className="font-mono">"update console"</span> in chat to install it.
          </span>
          <button onClick={onDismissUpdate} className="ml-auto p-1 text-fg-dim hover:text-fg-strong transition-colors" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <main className={`relative z-10 flex-1 min-h-0 overflow-hidden ${showDashboard || toolsOpen ? '' : chatFullscreen ? 'block' : 'flex flex-col lg:flex-row gap-6'}`}>
        {toolsOpen ? (
          <div className="h-full p-4">
            <ToolsPanel
              panels={toolPanels}
              activePanel={activeToolPanel}
              onOpenPanel={handleOpenToolPanel}
              onClose={handleCloseTools}
              project={activeProject ?? GENERAL_PROJECT}
              onSendMessage={handleSendMessage}
            />
          </div>
        ) : showDashboard ? (
          <div className="h-full p-4">
            <Dashboard
              onClose={() => setShowDashboard(false)}
              refreshSignal={dashboardUpdateSignal}
              projects={projects}
              workspaceMode={workspaceTab}
              onSelectProject={handleSelectProject}
              onSendMessage={handleSendMessage}
            />
          </div>
        ) : (<>
        {!chatFullscreen && (
          <SidebarDrawer
            projects={projects}
            activeProject={activeProject}
            sessions={sessions}
            activeSessionId={activeSessionId}
            scanPath={scanPath}
            setScanPath={setScanPath}
            handleScan={handleScan}
            handleBrowseFolder={handleBrowseFolder}
            createSession={createSession}
            switchSession={switchSession}
            deleteSession={deleteSession}
            renameSession={renameSession}
            handleSelectProject={handleSelectProject}
            workspaceProjects={workspaceProjects}
            addToWorkspace={addToWorkspace}
            removeFromWorkspace={removeFromWorkspace}
            aiEnabled={aiEnabled}
            aiModel={aiModel}
            activeServersCount={activeServers.length}
            collapsed={sidebarCollapsed}
            onSetCollapsed={setSidebarCollapsed}
          />
        )}

        <div className={chatFullscreen ? 'h-full w-full' : 'flex-1 min-h-0 min-w-0'}>
          <div className={`h-full w-full ${chatFullscreen ? '' : 'max-w-4xl mx-auto'}`}>
            {showWelcome && !chatFullscreen ? (
            <WelcomeScreen
              projects={projects}
              activeProject={activeProject}
              ollamaStatus={ollamaStatus}
              aiEnabled={aiEnabled}
              greeting={heroGreeting}
              onAIToggle={handleAIToggle}
              onSelectProject={handleSelectProject}
              onNewChat={handleNewChat}
              onQuickStart={handleQuickStart}
              workspaceProjects={workspaceProjects}
              addToWorkspace={addToWorkspace}
              removeFromWorkspace={removeFromWorkspace}
            />
            ) : (
            <Terminal
              isFullscreen={chatFullscreen}
              onToggleFullscreen={() => setChatFullscreen(v => !v)}
              messages={messages}
              onSendMessage={handleSendMessage}
              onSearch={handleSearch}
              onDeepResearch={handleDeepResearch}
              activeProject={activeProject}
              pendingConfirm={pendingConfirm}
              onConfirm={handleConfirm}
              pendingToolConfirm={pendingToolConfirm}
              onToolConfirm={handleToolConfirm}
              onApproveTask={handleApproveTask}
              pendingMemorySuggestion={pendingMemorySuggestion}
              onMemorySuggestionRespond={handleMemorySuggestionRespond}
              aiEnabled={aiEnabled}
              aiThinking={aiThinking}
              aiThinkingText={aiThinkingText}
              commandPending={commandPending}
              onCancel={handleCancel}
              ollamaStatus={ollamaStatus}
              aiModel={aiModel}
              aiMode={aiMode}
              onAIToggle={handleAIToggle}
              onSetModel={handleSetModel}
              onSetMode={handleSetMode}
              toolHistory={toolHistory}
              showToolHistory={showToolHistory}
              onToggleToolHistory={() => setShowToolHistory(v => !v)}
              onRerunToolCall={rerunToolCall}
              onExportMarkdown={exportAsMarkdown}
              onExportJson={exportAsJson}
              onExportPdf={exportAsPdf}
              onExportProjectChatLog={exportProjectChatLog}
              onDirectCommand={handleDirectCommand}
              onDidYouMeanPick={handleDidYouMeanPick}
              workspaceProjects={workspaceProjects}
              addToWorkspace={addToWorkspace}
              removeFromWorkspace={removeFromWorkspace}
              clearWorkspace={clearWorkspace}
              onSwitchToProject={handleSwitchToProject}
              processes={processes}
              processLogs={processLogs}
              selectedProcessId={selectedProcessId}
              onSelectProcess={setSelectedProcessId}
              onStopProcess={handleStopProcess}
              dockExpanded={dockExpanded}
              onToggleDock={() => setDockExpanded(v => !v)}
              dockTab={dockTab}
              onSetDockTab={setDockTab}
              projects={projects}
              knownDevUrls={knownDevUrls}
               userName={profile.name}
               connected={connected}
             />
            )}
          </div>
        </div>
        </>)}
      </main>

      <CommandDeck
        open={deckOpen}
        onClose={() => setDeckOpen(false)}
        projects={projects}
        activeProject={activeProject}
        onSelectProject={handleSelectProject}
        onDirectCommand={handleDirectCommand}
        onSendMessage={handleSendMessage}
        onHome={() => { setShowDashboard(false); setToolsOpen(false); setChatFullscreen(false); setShowWelcome(true); }}
        onToggleDashboard={() => { setToolsOpen(false); setShowDashboard(v => !v); }}
        onNewChat={handleNewChat}
        sidebarCollapsed={sidebarCollapsed}
        onSetSidebarCollapsed={setSidebarCollapsed}
      />

      <UserProfileModal
        open={profileOpen}
        profile={profile}
        onClose={() => setProfileOpen(false)}
        onSave={updateProfile}
      />

      <FirstRunSetup
        open={showFirstRunSetup}
        scanPath={scanPath}
        setScanPath={setScanPath}
        handleScan={handleScan}
        onFinish={updateProfile}
      />
    </div>
  );
}

export default App;
