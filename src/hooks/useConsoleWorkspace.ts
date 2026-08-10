import { useCallback, useState, useEffect } from 'react';
import type { Project } from '../types';

/**
 * The workspace-project set (the "active workspace" the server scopes sessions to), extracted
 * from useConsole.ts. Every mutation sends the same 'workspace_set' message as the original —
 * the server owns the authoritative workspace, this state is the optimistic mirror.
 */
export function useConsoleWorkspace(
  wsRef: React.MutableRefObject<WebSocket | null>,
  activeProject: Project | null,
) {
  const [workspaceProjects, setWorkspaceProjects] = useState<Project[]>([]);

  const sendWorkspaceSet = useCallback((projectIds: string[]) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current?.send(JSON.stringify({
      type: 'workspace_set',
      payload: { projectIds, activeProjectId: activeProject?.id },
    }));
  }, [wsRef, activeProject]);

  const addToWorkspace = useCallback((project: Project) => {
    // M20: the setState updater must stay pure — React.StrictMode double-invokes it, and
    // emitting a side effect (the workspace_set WS message) inside it produced duplicate
    // messages on every add under fast-refresh. Derive the post-add list, then send outside.
    setWorkspaceProjects(prev =>
      prev.some(p => p.id === project.id) ? prev : [...prev, project]
    );
    if (!workspaceProjects.some(p => p.id === project.id)) {
      sendWorkspaceSet([...workspaceProjects.map(p => p.id), project.id]);
    }
  }, [workspaceProjects, sendWorkspaceSet]);

  const removeFromWorkspace = useCallback((projectId: string) => {
    setWorkspaceProjects(prev => prev.filter(p => p.id !== projectId));
    // Send the post-remove list (mirrors the original `updated` value the updater sent).
    sendWorkspaceSet(workspaceProjects.filter(p => p.id !== projectId).map(p => p.id));
  }, [workspaceProjects, sendWorkspaceSet]);

  const clearWorkspace = useCallback(() => {
    setWorkspaceProjects([]);
    sendWorkspaceSet([]);
  }, [sendWorkspaceSet]);

  // Sync the optimistic workspace to the server whenever the project focus changes, so a
  // switch to a project already in the workspace doesn't silently orphan the server's
  // active-project view. (Best-effort, non-blocking.)
  useEffect(() => {
    if (workspaceProjects.length > 0 && activeProject) {
      sendWorkspaceSet(workspaceProjects.map(p => p.id));
    }
  }, [activeProject, workspaceProjects, sendWorkspaceSet]);

  return {
    workspaceProjects,
    setWorkspaceProjects,
    addToWorkspace,
    removeFromWorkspace,
    clearWorkspace,
  };
}
