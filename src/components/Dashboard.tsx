import React, { useEffect, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import { X, GitCommit, FileWarning, Globe, Terminal, FolderGit2 } from 'lucide-react';
import { formatPath } from '../utils/formatPath';
import { apiFetchJson } from '../utils/apiFetch';

interface DashboardEntry {
  id: string;
  name: string;
  path: string;
  uncommitted: string[];
  recentCommits: string[];
  devUrl: string | null;
  runningCommand: string | null;
}

interface DashboardProps {
  onClose: () => void;
  refreshSignal?: number;
}

export const Dashboard = ({ onClose, refreshSignal = 0 }: DashboardProps) => {
  const [entries, setEntries] = useState<DashboardEntry[]>([]);

  const fetchDashboard = useCallback(async () => {
    const data = await apiFetchJson<DashboardEntry[]>('/api/dashboard');
    if (data) setEntries(data);
  }, []);

  useEffect(() => {
    fetchDashboard();
    const id = setInterval(fetchDashboard, 5000);
    return () => clearInterval(id);
  }, [fetchDashboard]);

  // Re-fetch immediately when the server signals a state change via WebSocket
  useEffect(() => {
    if (refreshSignal > 0) fetchDashboard();
  }, [refreshSignal, fetchDashboard]);

  const totalUncommitted = entries.reduce((sum, e) => sum + e.uncommitted.length, 0);
  const totalRunning = entries.filter(e => e.runningCommand || e.devUrl).length;

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-fg-strong">Dashboard</h2>
          <span className="text-xs text-fg-dim">
            {entries.length} projects
          </span>
          {totalUncommitted > 0 && (
            <span className="text-xs text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded">
              {totalUncommitted} uncommitted
            </span>
          )}
          {totalRunning > 0 && (
            <span className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded">
              {totalRunning} running
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-1 text-fg-dim hover:text-fg-muted transition-colors">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1">
        {entries.map((entry, i) => (
          <motion.div
            key={entry.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="bg-panel rounded-xl border border-border-soft p-4"
          >
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <FolderGit2 size={16} className="text-[#00d4a3] flex-shrink-0" />
                <h3 className="text-sm font-bold text-fg-strong truncate">{entry.name}</h3>
               <span className="text-[10px] text-fg-dim font-mono truncate hidden lg:inline" title={entry.path}>
                   {formatPath(entry.path)}
                 </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {entry.uncommitted.length > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded">
                    <FileWarning size={12} />
                    {entry.uncommitted.length}
                  </span>
                )}
                {entry.runningCommand && (
                  <span className="flex items-center gap-1 text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">
                    <Terminal size={12} />
                    running
                  </span>
                )}
                {entry.devUrl && (
                  <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">
                    <Globe size={12} />
                    live
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-12 gap-3 text-xs">
              <div className="col-span-3">
                <span className="text-[10px] tracking-wider uppercase text-fg-dim font-bold">Uncommitted</span>
                {entry.uncommitted.length > 0 ? (
                  <div className="mt-1 max-h-20 overflow-y-auto space-y-0.5 font-mono text-yellow-300/70">
                    {entry.uncommitted.slice(0, 10).map((line, j) => (
                      <div key={j} className="truncate">{line}</div>
                    ))}
                    {entry.uncommitted.length > 10 && (
                      <div className="text-fg-dim italic">+{entry.uncommitted.length - 10} more</div>
                    )}
                  </div>
                ) : (
                  <div className="mt-1 text-fg-dim italic">Clean</div>
                )}
              </div>

              <div className="col-span-7">
                <span className="text-[10px] tracking-wider uppercase text-fg-dim font-bold flex items-center gap-1">
                  <GitCommit size={12} />
                  Recent commits
                </span>
                {entry.recentCommits.length > 0 ? (
                  <div className="mt-1 space-y-0.5 font-mono text-fg-subtle">
                    {entry.recentCommits.map((line, j) => (
                      <div key={j} className="truncate">{line}</div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-fg-dim italic">No commits</div>
                )}
              </div>

              <div className="col-span-2">
                <span className="text-[10px] tracking-wider uppercase text-fg-dim font-bold">Status</span>
                <div className="mt-1 space-y-1 font-mono">
                  {entry.runningCommand ? (
                    <div className="text-blue-400 truncate" title={entry.runningCommand}>
                      <Terminal size={12} className="inline mr-1" />
                      {entry.runningCommand}
                    </div>
                  ) : null}
                  {entry.devUrl ? (
                    <a
                      href={entry.devUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-green-400 hover:text-green-300 truncate block"
                    >
                      <Globe size={12} className="inline mr-1" />
                      {entry.devUrl}
                    </a>
                  ) : null}
                  {!entry.runningCommand && !entry.devUrl ? (
                    <div className="text-fg-dim italic">Idle</div>
                  ) : null}
                </div>
              </div>
            </div>
          </motion.div>
        ))}

        {entries.length === 0 && (
          <div className="text-sm text-fg-dim italic text-center py-12">
            No projects loaded — scan a directory to get started.
          </div>
        )}
      </div>
    </div>
  );
};
