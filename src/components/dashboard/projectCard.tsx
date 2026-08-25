// Dashboard project card (2026-08-24, split out of Dashboard.tsx): the collapsible card —
// git/worktree status columns, the general-mode placeholder, the expanded action row and
// the embedded HistoryPanel. Pure props; Dashboard owns expansion/copy state.

import { motion, AnimatePresence } from 'motion/react';
import { X, GitCommit, FileWarning, Globe, Terminal, FolderGit2, MessageSquare, UploadCloud, Copy, Play, Square } from 'lucide-react';
import { formatPath } from '../../utils/formatPath';
import { HistoryPanel } from '../HistoryPanel';

export interface DashboardEntry {
  id: string;
  name: string;
  path: string;
  workspaceType?: 'dev' | 'general';
  uncommitted: string[];
  recentCommits: string[];
  devUrl: string | null;
  running: boolean;
  runningCommand: string | null;
  isGitRepo: boolean;
  aheadCount: number;
  hasUpstream: boolean;
}

export interface DashboardProjectCardProps {
  entry: DashboardEntry;
  isGeneral: boolean;
  expanded: boolean;
  copiedId: boolean;
  needsPush: boolean;
  scanPath?: string;
  index: number;
  onToggleExpand: () => void;
  onOpenChat: () => void;
  onViewLogs: () => void;
  onRun: () => void;
  onStop: () => void;
  onPush: () => void;
  onCopyPath: () => void;
  onSendMessage: (content: string) => void;
}

export function DashboardProjectCard(props: DashboardProjectCardProps) {
  const {
    entry, isGeneral, expanded, copiedId, needsPush, scanPath, index,
    onToggleExpand, onOpenChat, onViewLogs, onRun, onStop, onPush, onCopyPath, onSendMessage,
  } = props;

  return (
    <motion.div
      key={entry.id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleExpand(); }
      }}
      className="bg-panel rounded-xl border border-border-soft p-4 cursor-pointer"
      onClick={onToggleExpand}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <FolderGit2 size={16} className="text-accent-teal flex-shrink-0" />
          <h3 className="text-sm font-bold text-fg-strong truncate">{entry.name}</h3>
          <span className="text-[10px] text-fg-dim font-mono truncate hidden lg:inline" title={entry.path}>
            {formatPath(entry.path, scanPath)}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!isGeneral && (
          <>
          {entry.uncommitted.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-accent-orange bg-accent-orange/10 px-1.5 py-0.5 rounded">
              <FileWarning size={12} />
              {entry.uncommitted.length}
            </span>
          )}
          {entry.aheadCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-accent-orange bg-accent-orange/10 px-1.5 py-0.5 rounded">
              <UploadCloud size={12} />
              {entry.aheadCount} unpushed
            </span>
          )}
          {entry.runningCommand && (
            <span className="flex items-center gap-1 text-[10px] text-accent-blue bg-accent-blue/10 px-1.5 py-0.5 rounded">
              <Terminal size={12} />
              running
            </span>
          )}
          {entry.devUrl && (
            <span className="flex items-center gap-1 text-[10px] text-accent-green bg-accent-green/10 px-1.5 py-0.5 rounded">
              <Globe size={12} />
              live
            </span>
          )}
          </>
          )}
        </div>
      </div>

      {isGeneral ? (
        <div className="text-xs text-fg-dim border border-dashed border-border-soft rounded-lg px-3 py-4">
          <span className="text-fg-muted">General workspace</span> — file tools, notes, and
          reminders arrive in later phases. Open it in chat to browse or edit files.
        </div>
      ) : (
      <div className="grid grid-cols-12 gap-3 text-xs">
        <div className="col-span-3">
          <span className="text-[10px] tracking-wider uppercase text-fg-dim font-bold">Uncommitted</span>
          {entry.uncommitted.length > 0 ? (
            <div className="mt-1 max-h-20 overflow-y-auto space-y-0.5 font-mono text-accent-orange/70">
              {entry.uncommitted.slice(0, 10).map((line) => (
                // git short-status lines are unique per path — content is the stable identity.
                <div key={line} className="truncate">{line}</div>
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
              {entry.recentCommits.map((line) => (
                // commit one-liners are unique (hash + message) — content is the stable identity.
                <div key={line} className="truncate">{line}</div>
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
              <div className="text-accent-blue truncate" title={entry.runningCommand}>
                <Terminal size={12} className="inline mr-1" />
                {entry.runningCommand}
              </div>
            ) : null}
            {entry.devUrl ? (
              <a
                href={entry.devUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-accent-green hover:text-accent-green/80 truncate block"
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
      )}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div
              className="flex items-center gap-2 pt-3 mt-3 border-t border-border-soft flex-wrap"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={onOpenChat}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-scrim-faint hover:bg-panel-strong text-fg-strong border border-border-soft transition-colors"
              >
                <MessageSquare size={12} />
                Open in chat
              </button>
              {!isGeneral && (entry.runningCommand || entry.devUrl) && (
                <button
                  onClick={onViewLogs}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-scrim-faint hover:bg-panel-strong text-fg-strong border border-border-soft transition-colors"
                >
                  <Terminal size={12} />
                  View logs
                </button>
              )}
              {!isGeneral && !entry.runningCommand && (
                <button
                  onClick={onRun}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-accent-teal/10 hover:bg-accent-teal/20 text-accent-teal border border-accent-teal/20 transition-colors"
                >
                  <Play size={12} />
                  Run
                </button>
              )}
              {!isGeneral && (entry.runningCommand || entry.devUrl) && (
                <button
                  onClick={onStop}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-accent-red/10 hover:bg-accent-red/20 text-accent-red border border-accent-red/20 transition-colors"
                >
                  <Square size={12} />
                  Stop
                </button>
              )}
              {!isGeneral && needsPush && (
                <button
                  onClick={onPush}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-accent/10 hover:bg-accent/20 text-accent border border-accent/20 transition-colors"
                >
                  <UploadCloud size={12} />
                  {entry.uncommitted.length > 0 ? 'Commit & push' : 'Push'}
                </button>
              )}
              {!isGeneral && entry.devUrl && (
                <a
                  href={entry.devUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-accent-green/10 hover:bg-accent-green/20 text-accent-green border border-accent-green/20 transition-colors"
                >
                  <Globe size={12} />
                  Open site
                </a>
              )}
              <button
                onClick={onCopyPath}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-scrim-faint hover:bg-panel-strong text-fg-dim border border-border-soft transition-colors"
              >
                <Copy size={12} />
                {copiedId ? 'Copied' : 'Copy path'}
              </button>
            </div>
            <div
              className="mt-3 pt-3 border-t border-border-soft"
              onClick={(e) => e.stopPropagation()}
            >
              <HistoryPanel
                projects={[{ id: entry.id, name: entry.name }]}
                activeProjectId={entry.id}
                onSendMessage={onSendMessage}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}