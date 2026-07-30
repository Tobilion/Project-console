import React, { useRef } from 'react';
import { GlowOrbs } from './components/GlowOrbs';
import { TextScramble } from './components/TextScramble';
import { BentoGrid } from './components/BentoGrid';
import { Terminal } from './components/Terminal';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Dashboard } from './components/Dashboard';
import { useConsole } from './hooks/useConsole';
import { FolderSearch, Plus, MessageSquare, Trash2, Home, LayoutDashboard } from 'lucide-react';

function App() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Claude/ChatGPT-style scoping: when a project is active, the sidebar shows only that
  // project's chats by default (matches "each project has its own chat history"). The toggle
  // is a deliberate escape hatch, not a redesign away from per-project scoping — sometimes you
  // do want to see everything at once (e.g. hunting for a chat you can't remember the project
  // for).
  const [showAllChats, setShowAllChats] = React.useState(false);
  // Requested directly — the chat panel always shared the screen with the sessions sidebar and
  // the project grid, with no way to just focus on the conversation. Purely a layout toggle: it
  // doesn't touch any chat state, so switching in and out of it never loses anything.
  const [chatFullscreen, setChatFullscreen] = React.useState(false);
  const [showDashboard, setShowDashboard] = React.useState(false);

  const {
    projects, activeProject, scanPath, setScanPath, messages,
    pendingConfirm, sessions, activeSessionId, showSessions, setShowSessions,
    aiEnabled, ollamaStatus, aiThinking, aiThinkingText, commandPending, indexingProjectId,
    aiModel, aiMode, showWelcome, setShowWelcome, pendingToolConfirm,
    pendingMemorySuggestion, handleMemorySuggestionRespond,
    handleSendMessage, handleCancel, handleConfirm, handleToolConfirm, handleAIToggle,
    handleSetModel, handleSetMode, handleSelectProject,
    handleSearch, handleDeepResearch, handleNewChat, handleQuickStart, handleScan,
    createSession, switchSession, deleteSession, handleSwitchToProject,
    toolHistory, showToolHistory, setShowToolHistory, rerunToolCall,
    exportAsMarkdown, exportAsJson,
    handleDirectCommand, activeServers, dashboardUpdateSignal,
    workspaceProjects, addToWorkspace, removeFromWorkspace, clearWorkspace,
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

  if (showWelcome && !activeProject) {
    return (
      <div className="h-screen relative flex flex-col p-6">
        <header className="relative z-10 flex-shrink-0 flex items-center justify-end gap-4 mb-4">
          {indexingProjectId && (
            <span className="text-xs text-yellow-400 font-mono animate-pulse">⏳ Indexing project...</span>
          )}
          <form onSubmit={handleScan} className="flex items-center gap-2 bg-white/5 p-1.5 rounded-xl border border-white/10">
            <button type="button" onClick={handleBrowseFolder} className="p-1 text-gray-400 hover:text-gray-200 transition-colors" title="Browse for a folder near your current scan directory (for any other location, paste the full path instead)">
              <FolderSearch size={16} />
            </button>
            <input type="text" value={scanPath} onChange={(e) => setScanPath(e.target.value)} placeholder="C:\Users\...\Projects" className="bg-transparent border-none outline-none text-xs font-mono w-48 text-gray-400 px-2" />
            <button type="submit" className="px-3 py-1.5 bg-[#00d4a3]/20 text-[#00d4a3] rounded-lg text-[10px] font-bold tracking-wider uppercase hover:bg-[#00d4a3]/30 transition-colors">Scan</button>
          </form>
        </header>
        <WelcomeScreen projects={projects} ollamaStatus={ollamaStatus} aiEnabled={aiEnabled} onAIToggle={handleAIToggle} onSelectProject={handleSelectProject} onNewChat={handleNewChat} onQuickStart={handleQuickStart} />
      </div>
    );
  }

  return (
    <div className={`h-screen relative flex flex-col ${chatFullscreen ? '' : 'p-6'}`}>
      <GlowOrbs />

      {!chatFullscreen && (
      <header className="relative z-10 flex-shrink-0 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-serif italic text-white mb-2">
            <TextScramble text="V4 Knowledge Engine" />
          </h1>
          <p className="text-xs tracking-[0.2em] uppercase text-gray-500 font-bold">
            Project Console & Analytics
          </p>
          {indexingProjectId && (
            <p className="text-xs text-yellow-400 font-mono mt-1 animate-pulse">
              ⏳ Indexing project...
            </p>
          )}
        </div>
        <form onSubmit={handleScan} className="flex items-center gap-3 bg-surface/50 p-2 rounded-xl border border-white/10 backdrop-blur-sm">
          <button type="button" onClick={handleBrowseFolder} className="flex items-center gap-2 px-3 text-gray-400 hover:text-gray-200 transition-colors" title="Browse for a folder near your current scan directory (for any other location, paste the full path instead)">
            <FolderSearch size={18} />
          </button>
          <input
            type="text"
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            placeholder="C:\Users\...\Projects"
            className="bg-transparent border-none outline-none text-sm font-mono w-64 text-gray-200"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-[#00d4a3]/20 text-[#00d4a3] rounded-lg text-xs font-bold tracking-wider uppercase hover:bg-[#00d4a3]/30 transition-colors"
          >
            Scan
          </button>
          <button onClick={() => setShowWelcome(true)} className="p-2 text-gray-500 hover:text-gray-300 transition-colors" title="Home">
            <Home size={18} />
          </button>
          {activeServers.length > 0 && (
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-green-400 font-mono bg-green-500/10 rounded-lg border border-green-500/20 whitespace-nowrap flex-shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block animate-pulse" />
              {activeServers.length} running
            </span>
          )}
          <button onClick={() => setShowDashboard(v => !v)} className={`p-2 transition-colors ${showDashboard ? 'text-[#00d4a3]' : 'text-gray-500 hover:text-gray-300'}`} title="Dashboard">
            <LayoutDashboard size={18} />
          </button>
        </form>
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

      <main className={`relative z-10 flex-1 min-h-0 overflow-hidden ${showDashboard ? '' : `grid grid-cols-1 gap-6 ${chatFullscreen ? '' : 'lg:grid-cols-12'}`}`}>
        {showDashboard ? (
          <div className="h-full p-4">
            <Dashboard onClose={() => setShowDashboard(false)} refreshSignal={dashboardUpdateSignal} />
          </div>
        ) : (<>
        {!chatFullscreen && showSessions && (() => {
          const visibleSessions = (showAllChats || !activeProject)
            ? sessions
            : sessions.filter(s => s.projectId === activeProject.id);
          return (
          <div className="lg:col-span-2 flex flex-col gap-2 overflow-y-auto min-h-0 bg-white/5 rounded-2xl border border-white/10 p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs tracking-[0.2em] uppercase text-gray-500 font-bold">Chats</span>
              <button onClick={() => createSession(activeProject?.id, activeProject?.name)} className="p-1 text-gray-400 hover:text-teal-400 transition-colors">
                <Plus size={16} />
              </button>
            </div>
            {activeProject && (
              <button
                onClick={() => setShowAllChats(v => !v)}
                className="text-[10px] text-gray-500 hover:text-gray-300 font-mono text-left mb-1 transition-colors"
              >
                {showAllChats ? `Showing all projects — show only "${activeProject.name}"` : 'Show chats from all projects'}
              </button>
            )}
            {visibleSessions.length === 0 && (
              <button onClick={() => createSession(activeProject?.id, activeProject?.name)} className="text-xs text-gray-500 font-mono italic text-left py-2 px-2 rounded-lg hover:bg-white/5 transition-colors">
                {activeProject && !showAllChats ? `No chats yet for "${activeProject.name}" — create one` : 'No chats yet — create one'}
              </button>
            )}
            {visibleSessions.map(s => (
              <div
                key={s.id}
                onClick={() => switchSession(s.id)}
                className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-xs transition-colors group ${
                  activeSessionId === s.id ? 'bg-teal-500/15 text-teal-300' : 'text-gray-400 hover:bg-white/5'
                }`}
              >
                <MessageSquare size={14} className="flex-shrink-0" />
                <span className="truncate flex-1 flex flex-col">
                  <span className="truncate">{s.title}</span>
                  {s.projectName && (
                    <span className="truncate text-[10px] text-gray-500 normal-case tracking-normal">{s.projectName}</span>
                  )}
                </span>
                <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }} className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-all">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          );
        })()}
        {!chatFullscreen && (
          <div className={`flex flex-col gap-6 overflow-y-auto pr-2 pb-6 min-h-0 ${showSessions ? 'lg:col-span-4' : 'lg:col-span-5'}`}>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => setShowSessions(!showSessions)} className="p-1 text-gray-500 hover:text-gray-300 transition-colors">
                <MessageSquare size={16} />
              </button>
              <h2 className="text-xs tracking-[0.2em] uppercase text-gray-500 font-bold">
                Discovered Projects
              </h2>
            </div>
            {projects.length === 0 ? (
               <div className="text-sm text-gray-500 font-mono italic">No projects found. Try scanning a different path.</div>
            ) : (
                <BentoGrid
                  projects={projects}
                  activeProject={activeProject}
                  onSelect={handleSelectProject}
                  workspaceProjects={workspaceProjects}
                  addToWorkspace={addToWorkspace}
                  removeFromWorkspace={removeFromWorkspace}
                />
            )}
          </div>
        )}

        <div className={`${chatFullscreen ? 'h-full lg:col-span-12' : `h-[calc(100vh-140px)] ${showSessions ? 'lg:col-span-6' : 'lg:col-span-7'}`}`}>
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
            workspaceProjects={workspaceProjects}
            addToWorkspace={addToWorkspace}
            removeFromWorkspace={removeFromWorkspace}
            clearWorkspace={clearWorkspace}
            onSwitchToProject={handleSwitchToProject}
          />
        </div>
        </>)}
      </main>
    </div>
  );
}

export default App;
