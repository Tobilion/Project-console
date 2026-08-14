import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';

// Phase 4 (2026-08-10): action-history view for the ProcessDock. Reads the per-project
// JSONL timeline (GET /api/projects/:id/action-history, most-recent-first) and offers a
// per-entry revert button that runs `revert action <id>` through the normal chat flow —
// file restores land on the standard confirm card, git/command entries get the answer-only
// git advice, so nothing here bypasses the existing safety gates.

interface HistoryAction {
  id: string;
  ts: number;
  type: string;
  description: string;
  path?: string;
}

interface HistoryPanelProps {
  projects: { id: string; name: string }[];
  activeProjectId: string | null;
  onSendMessage: (msg: string) => void;
}

const TYPE_LABELS: Record<string, { label: string; className: string }> = {
  file_write: { label: 'WRITE', className: 'bg-accent-teal/15 text-accent-teal' },
  file_edit: { label: 'EDIT', className: 'bg-accent-blue/15 text-accent-blue' },
  file_insert: { label: 'INSERT', className: 'bg-accent-blue/15 text-accent-blue' },
  file_append: { label: 'APPEND', className: 'bg-accent-blue/15 text-accent-blue' },
  command: { label: 'CMD', className: 'bg-accent-orange/15 text-accent-orange' },
  git: { label: 'GIT', className: 'bg-accent-orange/15 text-accent-orange' },
  revert: { label: 'REVERT', className: 'bg-fg-dim/10 text-fg-dim' },
};

export function HistoryPanel({ projects, activeProjectId, onSendMessage }: HistoryPanelProps) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [actions, setActions] = useState<HistoryAction[]>([]);
  const [loading, setLoading] = useState(false);

  // Default to the session's active project (fall back to the first discovered one).
  useEffect(() => {
    if (!projectId) {
      setProjectId(activeProjectId || projects[0]?.id || null);
    }
  }, [projectId, activeProjectId, projects]);

  const fetchActions = useCallback(async (id: string | null) => {
    if (!id) {
      setActions([]);
      return;
    }
    setLoading(true);
    const data = await apiFetchJson<{ actions: HistoryAction[] }>(
      `/api/projects/${encodeURIComponent(id)}/action-history?limit=30`,
    );
    if (data) setActions(data.actions || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchActions(projectId);
  }, [projectId, fetchActions]);

  return (
    <div className="flex flex-col max-h-64">
      <div className="flex items-center justify-between gap-2 px-4 pt-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] text-fg-dim uppercase flex-shrink-0">Action history</span>
          <select
            value={projectId || ''}
            onChange={(e) => setProjectId(e.target.value || null)}
            className="max-w-44 truncate text-[11px] bg-panel border border-border-soft rounded-lg px-1.5 py-0.5 text-fg-muted outline-none focus:border-border-strong"
            title="Project whose action history is shown"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => fetchActions(projectId)}
          className="text-[10px] text-fg-dim hover:text-fg-strong transition-colors flex-shrink-0"
          title="Refresh history"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <div className="overflow-y-auto p-3 space-y-1">
        {actions.length === 0 ? (
          <div className="text-xs text-fg-dim px-1">
            {loading ? 'Loading…' : 'No actions recorded yet — file writes and confirmed commands will show up here.'}
          </div>
        ) : (
          actions.map((a) => {
            const meta = TYPE_LABELS[a.type] || { label: a.type.toUpperCase(), className: 'bg-fg-dim/10 text-fg-dim' };
            return (
              <div
                key={a.id}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border-soft bg-panel text-xs"
              >
                <span className={`px-1.5 py-0.5 rounded-lg font-mono text-caption flex-shrink-0 ${meta.className}`}>{meta.label}</span>
                <span className="font-mono text-[10px] text-fg-dim flex-shrink-0">{a.id}</span>
                <span className="text-[10px] text-fg-dim flex-shrink-0">
                  {new Date(a.ts).toLocaleTimeString()}
                </span>
                <span className="truncate text-fg-muted min-w-0 flex-1" title={a.description}>{a.description}</span>
                <button
                  onClick={() => onSendMessage(`revert action ${a.id}`)}
                  className="text-fg-faint hover:text-accent-teal transition-colors flex-shrink-0"
                  title={`Revert action ${a.id}${a.type.startsWith('file_') ? ' (asks for confirmation)' : ' (answers with the git command)'}`}
                >
                  <RotateCcw size={11} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
