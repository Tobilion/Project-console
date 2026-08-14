import { useState } from 'react';
import { Project } from '../types';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [scanPath, setScanPath] = useState('');
  const [indexingProjectId, setIndexingProjectId] = useState<string | null>(null);

  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (data.projects) {
        setProjects(data.projects);
        setScanPath(data.scanPath || '');
      }
    } catch {}
  };

  const scanNewPath = async (newPath: string): Promise<{ success: boolean; error?: string }> => {
    if (!newPath.trim()) return { success: false, error: 'No path given.' };
    try {
      const res = await fetch('/api/scan-path', {
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

  const handleSelectProject = async (p: Project) => {
    setActiveProject(p);
    if (!p.codebaseIndex) {
      setIndexingProjectId(p.id);
      try {
        const res = await fetch(`/api/projects/${p.id}/index`, { method: 'POST' });
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
