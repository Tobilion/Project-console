import React, { useEffect, useMemo, useRef } from 'react';
import { GlowOrbs } from './components/GlowOrbs';
import { TextScramble } from './components/TextScramble';
import { SidebarDrawer } from './components/SidebarDrawer';
import { Terminal } from './components/Terminal';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Dashboard } from './components/Dashboard';
import { CommandDeck } from './components/CommandDeck';
import { useConsole } from './hooks/useConsole';
import { useUserProfile } from './hooks/useUserProfile';
import { getRandomGreeting } from './utils/greetings';
import { Home, LayoutDashboard, Search, Settings, Loader2 } from 'lucide-react';
import { ThemeToggle } from './components/ui/ThemeToggle';
import { UserProfileModal } from './components/UserProfileModal';

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
  const { profile, updateProfile, getFormattedName } = useUserProfile();
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
    exportAsMarkdown, exportAsJson,
    handleDirectCommand, activeServers, knownDevUrls, dashboardUpdateSignal,
    workspaceProjects, addToWorkspace, removeFromWorkspace, clearWorkspace,
    processes, processLogs, selectedProcessId, setSelectedProcessId,
    dockExpanded, setDockExpanded, dockTab, setDockTab, handleStopProcess,
    handleDidYouMeanPick,
  } = useConsole();

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
          <button onClick={() => { setShowDashboard(false); setChatFullscreen(false); setShowWelcome(true); }} className="p-2 text-fg-dim hover:text-fg-strong transition-colors" title="Home">
            <Home size={18} />
          </button>
          <button onClick={() => setDeckOpen(v => !v)} className="p-2 text-fg-dim hover:text-fg-strong transition-colors" title="Command deck (Ctrl+K)">
            <Search size={18} />
          </button>
          <button onClick={() => setShowDashboard(v => !v)} className={`p-2 transition-colors ${showDashboard ? 'text-accent' : 'text-fg-dim hover:text-fg-strong'}`} title="Dashboard">
            <LayoutDashboard size={18} />
          </button>
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

      <main className={`relative z-10 flex-1 min-h-0 overflow-hidden ${showDashboard ? '' : chatFullscreen ? 'block' : 'flex flex-col lg:flex-row gap-6'}`}>
        {showDashboard ? (
          <div className="h-full p-4">
            <Dashboard onClose={() => setShowDashboard(false)} refreshSignal={dashboardUpdateSignal} />
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
        onHome={() => { setShowDashboard(false); setChatFullscreen(false); setShowWelcome(true); }}
        onToggleDashboard={() => setShowDashboard(v => !v)}
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
    </div>
  );
}

export default App;
