import { useState } from 'react';
import { Project } from '../types';

// Phase T (2026-08-14): project state for the ACTIVE tab only. Every server call takes an
// explicit `tabId` (null = the global/no-tab workspace) so the hook never captures a stale
// tab in a closure — the tabs hook (useConsoleTabs) passes the active tab's id at call time.
function tabQuery(tabId: string | null): string {
  return tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [scanPath, setScanPath] = useState('');
  const [indexingProjectId, setIndexingProjectId] = useState<string | null>(null);

  const fetchProjects = async (tabId: string | null = null) => {
    try {
      const res = await fetch(`/api/projects${tabQuery(tabId)}`);
      const data = await res.json();
      if (data.projects) {
        setProjects(data.projects);
        setScanPath(data.scanPath || '');
        return { projects: data.projects as Project[], scanPath: data.scanPath as string };
      }
    } catch (err) {
      // Keep the previous (possibly stale) list — but don't fail silently: a dead server
      // otherwise looks like "no projects" with zero signal (audit 2026-08-17).
      // eslint-disable-next-line no-console
      console.error('fetchProjects failed:', err);
    }
    return null;
  };

  const scanNewPath = async (newPath: string, tabId: string | null = null): Promise<{ success: boolean; error?: string }> => {
    if (!newPath.trim()) return { success: false, error: 'No path given.' };
    try {
      const res = await fetch(`/api/scan-path${tabQuery(tabId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath.trim() })
      });
      const data = await res.json();
      if (data.success) {
        setProjects(data.projects || []);
        setScanPath(data.scanPath || newPath);
        setActiveProject(null);
        return { success: true };
      }
      // Previously swallowed silently — the server's error (e.g. "couldn't find that folder,
      // paste the full path instead") never reached the user, so a failed scan looked like
      // nothing happened at all.
      return { success: false, error: data.error || 'Scan failed for an unknown reason.' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Could not reach the server.' };
    }
  };

  const handleSelectProject = async (p: Project, tabId: string | null = null) => {
    setActiveProject(p);
    if (!p.codebaseIndex) {
      setIndexingProjectId(p.id);
      try {
        const res = await fetch(`/api/projects/${p.id}/index${tabQuery(tabId)}`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          p.codebaseIndex = data.codebaseIndex;
          setProjects(prev => prev.map(pr => pr.id === p.id ? { ...pr, codebaseIndex: data.codebaseIndex } : pr));
        }
      } catch {}
      setIndexingProjectId(prev => prev === p.id ? null : prev);
    }
  };

  return {
    projects, setProjects, activeProject, setActiveProject,
    scanPath, setScanPath, indexingProjectId, setIndexingProjectId,
    fetchProjects, scanNewPath, handleSelectProject,
  };
}
