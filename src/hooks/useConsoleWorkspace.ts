import { useCallback, useState } from 'react';
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

  const addToWorkspace = useCallback((project: Project) => {
    setWorkspaceProjects(prev => {
      if (prev.some(p => p.id === project.id)) return prev;
      const updated = [...prev, project];
      wsRef.current?.send(JSON.stringify({
        type: 'workspace_set',
        payload: { projectIds: updated.map(p => p.id), activeProjectId: activeProject?.id }
      }));
      return updated;
    });
  }, [wsRef, activeProject]);

  const removeFromWorkspace = useCallback((projectId: string) => {
    setWorkspaceProjects(prev => {
      const updated = prev.filter(p => p.id !== projectId);
      wsRef.current?.send(JSON.stringify({
        type: 'workspace_set',
        payload: { projectIds: updated.map(p => p.id), activeProjectId: activeProject?.id }
      }));
      return updated;
    });
  }, [wsRef, activeProject]);

  const clearWorkspace = useCallback(() => {
    setWorkspaceProjects([]);
    wsRef.current?.send(JSON.stringify({
      type: 'workspace_set',
      payload: { projectIds: [], activeProjectId: activeProject?.id }
    }));
  }, [wsRef, activeProject]);

  return {
    workspaceProjects,
    setWorkspaceProjects,
    addToWorkspace,
    removeFromWorkspace,
    clearWorkspace,
  };
}
