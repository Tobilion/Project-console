// The main top-level view switcher (2026-08-24, split out of App.tsx): Command Reference /
// Tools grid + panels / Dashboard / chat workspace, plus the project-tabs strip. Pure props.

import { ProjectTabs } from './ProjectTabs';
import { CommandReference } from './CommandReference';
import { ToolsPanel } from './ToolsPanel';
import { Dashboard } from './Dashboard';
import { ChatWorkspace } from './ChatWorkspace';
import type { ChatWorkspaceProps } from './ChatWorkspaceProps';

export interface AppMainViewProps {
  chatFullscreen: boolean;
  tabs: React.ComponentProps<typeof ProjectTabs>['tabs'];
  activeTabId: string | null;
  activeProjectName: string | null;
  activateTab: (id: string | null, preferredSessionId?: string | null) => void;
  duplicateTab: () => void;
  closeTab: (id: string | null) => void;
  showCommandRef: boolean;
  setShowCommandRef: (v: boolean) => void;
  toolsOpen: boolean;
  toolPanels: React.ComponentProps<typeof ToolsPanel>['panels'];
  toolPanelsError: string | null;
  fetchToolPanels: () => void;
  activeToolPanel: string | null;
  handleOpenToolPanel: (id: string) => void;
  handleCloseTools: () => void;
  activeProject: React.ComponentProps<typeof ToolsPanel>['project'];
  handleSendMessage: (t: string) => void;
  aiEnabled: boolean;
  showDashboard: boolean;
  setShowDashboard: (v: boolean) => void;
  dashboardUpdateSignal: number;
  projects: React.ComponentProps<typeof Dashboard>['projects'];
  workspaceTab: 'dev' | 'general';
  scanPath: string;
  handleSelectProject: (p: { id: string; name: string }) => void;
  handleSelectProjectReuse: (p: { id: string; name: string }) => void;
  handleViewLogs: (projectId: string) => void;
  chatWorkspace: ChatWorkspaceProps;
}

export function AppMainView(props: AppMainViewProps) {
  const {
    chatFullscreen, tabs, activeTabId, activeProjectName, activateTab, duplicateTab, closeTab,
    showCommandRef, setShowCommandRef, toolsOpen, toolPanels, toolPanelsError, fetchToolPanels,
    activeToolPanel, handleOpenToolPanel, handleCloseTools, activeProject, handleSendMessage,
    aiEnabled, showDashboard, setShowDashboard, dashboardUpdateSignal, projects, workspaceTab,
    scanPath, handleSelectProject, handleSelectProjectReuse, handleViewLogs, chatWorkspace,
  } = props;

  return (
    <>
      {/* Phase T: Chrome-style project tabs — each tab owns its own scan folder + project
          list + open chat. Always a full-width top bar (never a column in the side row);
          hidden only in chat fullscreen. */}
      {!chatFullscreen && (
        <ProjectTabs
          tabs={tabs}
          activeTabId={activeTabId}
          activeProjectName={activeProjectName}
          onActivate={activateTab}
          onDuplicate={duplicateTab}
          onClose={closeTab}
        />
      )}
      {showCommandRef ? (
        <div className="flex-1 min-h-0 p-6">
          <CommandReference onClose={() => setShowCommandRef(false)} />
        </div>
      ) : toolsOpen ? (
        <div className="flex-1 min-h-0 p-6">
          <ToolsPanel
            key={activeTabId ?? 'default'}
            panels={toolPanels}
            panelsError={toolPanelsError}
            onRetryPanels={fetchToolPanels}
            activePanel={activeToolPanel}
            onOpenPanel={handleOpenToolPanel}
            onClose={handleCloseTools}
            project={activeProject}
            onSendMessage={handleSendMessage}
            aiEnabled={aiEnabled}
            tabId={activeTabId}
          />
        </div>
      ) : showDashboard ? (
        <div className="flex-1 min-h-0 p-6">
          <Dashboard
            onClose={() => setShowDashboard(false)}
            refreshSignal={dashboardUpdateSignal}
            projects={projects}
            workspaceMode={workspaceTab}
            scanPath={scanPath}
            tabId={activeTabId}
            onSelectProject={handleSelectProject}
            onSelectProjectReuse={handleSelectProjectReuse}
            onSendMessage={handleSendMessage}
            onViewLogs={handleViewLogs}
          />
        </div>
      ) : (
        <ChatWorkspace {...chatWorkspace} />
      )}
    </>
  );
}