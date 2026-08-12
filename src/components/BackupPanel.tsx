import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, RefreshCw, Send, CheckCircle2, Download, FolderOpen } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';

// Phase 9 (UPGRADE-ROADMAP.md, 2026-08-12): the Backup panel — Time Machine's chronological
// list idea without the 3D visual: reverse-chronological rows (timestamp + size + Open/
// Reveal hover actions). Backup Now sends the exact same "backup this folder" trigger command
// over WS; the list reads from GET /api/projects/:id/backups.

interface BackupInfo {
  file: string;
  name: string;
  size: number;
  mtime: number;
}

interface BackupPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
}

const POLL_MS = 15000;

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

export function BackupPanel({ project, onSendMessage }: BackupPanelProps) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [subFolder, setSubFolder] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBackups = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    const data = await apiFetchJson<{ backups: BackupInfo[] }>(`/api/projects/${encodeURIComponent(project.id)}/backups`);
    setLoading(false);
    if (!data) { setError('Could not load backups.'); return; }
    setError(null);
    setBackups(data.backups || []);
  }, [project?.id]);

  useEffect(() => {
    if (project?.id) {
      fetchBackups();
      const t = setInterval(fetchBackups, POLL_MS);
      return () => clearInterval(t);
    }
  }, [project?.id, fetchBackups]);

  // Phase 9 audit: subfolder picker — backend backupStore.js already supports subPath, the
  // panel just never exposed it. Populate the picker from the project's one-level dirs.
  const fetchFolders = useCallback(async () => {
    if (!project?.id) return;
    const data = await apiFetchJson<{ folders: string[] }>(`/api/projects/${encodeURIComponent(project.id)}/folders`);
    if (data) setFolders(data.folders || []);
  }, [project?.id]);

  useEffect(() => {
    if (project?.id) {
      fetchFolders();
      setSubFolder('');
    }
  }, [project?.id, fetchFolders]);

  const send = (text: string) => {
    onSendMessage(text);
    setLastSent(text);
    if (lastSentTimer.current) clearTimeout(lastSentTimer.current);
    lastSentTimer.current = setTimeout(() => setLastSent(null), 8000);
    setTimeout(fetchBackups, 2000);
  };

  const downloadUrl = (name: string) =>
    `/api/projects/${encodeURIComponent(project?.id || '')}/backup-file?name=${encodeURIComponent(name)}`;

  const reveal = async (name: string) => {
    try {
      await fetch(`/api/projects/${encodeURIComponent(project?.id || '')}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `backups/${name}` }),
      });
    } catch {
      // Best-effort convenience — a failed reveal never blocks the panel.
    }
  };

  const cardCls = 'bg-panel rounded-xl border border-border-soft p-4';

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-accent-teal/15 text-accent-teal">
              <Archive size={16} />
            </div>
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Backup</h2>
            {project && <span className="text-xs text-fg-dim font-normal normal-case">— {project.name}</span>}
          </div>
          <button onClick={fetchBackups} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-md transition-colors" title="Refresh">
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        {!project ? (
          <div className={cn(cardCls, 'text-sm text-fg-muted')}>Select a project to back up.</div>
        ) : (
          <>
            <div className="flex gap-2 mb-4">
              <select
                value={subFolder}
                onChange={(e) => setSubFolder(e.target.value)}
                className="flex-1 text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-2 text-fg-strong focus:outline-none focus:border-accent-blue/50"
                title="Subfolder to back up (defaults to the whole project)"
              >
                <option value="">Whole project</option>
                {folders.map((f) => <option key={f} value={f}>{f}/</option>)}
              </select>
              <button
                onClick={() => send(subFolder ? `backup the ${subFolder} folder` : 'backup this folder')}
                className="flex items-center justify-center gap-1.5 text-xs font-bold min-h-11 rounded-xl px-5 bg-accent-blue text-white hover:opacity-90 transition-opacity"
              >
                <Send size={12} /> Backup now{subFolder ? ` (${subFolder}/)` : ''}
              </button>
            </div>

            {lastSent && (
              <div className="mb-3 flex items-start gap-2 text-[11px] text-fg-muted bg-scrim-faint border border-border-soft rounded-lg p-2.5">
                <CheckCircle2 size={13} className="text-accent mt-0.5 shrink-0" />
                <span>Sent <code className="font-mono text-accent">{lastSent}</code> — the zip path and download link appear in the chat below.</span>
              </div>
            )}

            <div>
              <h3 className="text-xs font-semibold text-fg-strong mb-2.5 px-1">Previous backups</h3>
              {backups.length === 0 ? (
                <p className="text-xs text-fg-dim italic px-1">
                  No backups yet. Hit "Backup now" above, or type <code className="font-mono text-accent-teal">backup this folder</code> in chat.
                </p>
              ) : (
                <div className="space-y-2">
                  {backups.map((b) => (
                    <div key={b.name} className="bg-panel rounded-xl border border-border-faint p-3 flex items-center gap-3">
                      <Archive size={15} className="text-accent-teal shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-fg-strong truncate font-mono text-xs" title={b.name}>{b.name}</span>
                          <span className="px-2 py-0.5 rounded-full bg-panel-strong text-fg-muted text-[10px] shrink-0">
                            {formatSize(b.size)}
                          </span>
                        </div>
                        <div className="text-[11px] text-fg-dim mt-0.5">
                          {new Date(b.mtime).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <a href={downloadUrl(b.name)} download={b.name} className="p-1.5 text-fg-dim hover:text-accent-blue rounded transition-colors" title="Download">
                          <Download size={14} />
                        </a>
                        <button onClick={() => reveal(b.name)} className="p-1.5 text-fg-dim hover:text-accent-blue rounded transition-colors" title="Show in folder">
                          <FolderOpen size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p className="text-[11px] text-fg-faint px-1">
              Backups are read-only against the project (nothing is modified or deleted) and live in the
              console's own <code className="font-mono">data/backups/</code> folder. Each zip shows in
              "recent actions", so <code className="font-mono">revert action &lt;id&gt;</code> deletes it.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
