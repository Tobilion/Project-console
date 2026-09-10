import React, { useMemo, useState } from 'react';
import { ChatSession } from '../types';
import { GENERAL_PROJECT_ID } from '../types';
import { MessageSquare, Search, Plus, X, Pencil, Trash2, FolderGit2, MessagesSquare, Share2 } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { EmptyState } from './ui/EmptyState';
import { cn } from '../lib/utils';

// Feature B (2026-08-14): the full Chat History overlay. A General | Projects tab switcher
// over ALL chats (not just the active project's), each row showing its location (workspace
// folder for General chats, project name for project chats). Clicking a row goes through the
// normal chat-switch path, which routes to the chat's owning tab (see findTabForSession /
// openWorkspaceTab in useConsole.ts) — so a Downloads chat tapped from a Projects tab lands
// back in Downloads. The overlay is purely a listing UI: rename/delete/open all reuse the
// existing session flows, the terminal stays the single source of truth.

interface ChatHistoryOverlayProps {
  open: boolean;
  onClose: () => void;
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSwitchSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  /** Portal sharing (2026-09-10): present only when the server is login-armed (App
    passes these exactly then). Resolve to null on success or an error string. */
  onShareSession?: (id: string, username: string) => Promise<string | null>;
  onUnshareSession?: (id: string, username: string) => Promise<string | null>;
}

type HistoryTab = 'general' | 'projects';

function isGeneralChat(s: ChatSession): boolean {
  return !s.projectId || s.projectId === GENERAL_PROJECT_ID;
}

function folderLabel(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

function timeAgo(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ChatHistoryOverlay({
  open, onClose, sessions, activeSessionId,
  onSwitchSession, onNewChat, onDeleteSession, onRenameSession,
  onShareSession, onUnshareSession,
}: ChatHistoryOverlayProps) {
  const [tab, setTab] = useState<HistoryTab>('general');
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [shareName, setShareName] = useState('');
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  const submitShare = async (id: string) => {
    if (!onShareSession || !shareName.trim() || shareBusy) return;
    setShareBusy(true);
    setShareError(null);
    const err = await onShareSession(id, shareName.trim());
    setShareBusy(false);
    if (err) setShareError(err);
    else setShareName('');
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = tab === 'general'
      ? sessions.filter(isGeneralChat)
      : sessions.filter((s) => !isGeneralChat(s));
    if (!q) return base;
    return base.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, tab, query]);

  // Project chats group under their project's name; General chats stay a flat feed.
  const projectGroups = useMemo(() => {
    const groups = new Map<string, ChatSession[]>();
    for (const s of filtered) {
      const key = s.projectName || s.projectId || 'Unknown project';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    return [...groups.entries()].sort((a, b) =>
      (b[1][0]?.updatedAt || 0) - (a[1][0]?.updatedAt || 0));
  }, [filtered]);

  const commitRename = () => {
    if (draftTitle.trim() && editingId) {
      onRenameSession(editingId, draftTitle);
    }
    setEditingId(null);
  };

  const openChat = (id: string) => {
    onSwitchSession(id);
    onClose();
  };

  const Row = ({ s }: { s: ChatSession }) => {
    const sublabel = isGeneralChat(s)
      ? (s.workspacePath ? folderLabel(s.workspacePath) : 'General')
      : (s.projectName || 'Project chat');
    return (
      <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => openChat(s.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(s.id); }
        }}
        className={cn(
          'flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer text-xs transition-colors group',
          activeSessionId === s.id ? 'bg-accent-blue/15 text-accent-blue' : 'text-fg-subtle hover:bg-panel',
        )}
      >
        <MessageSquare size={14} className="flex-shrink-0" />
        <span className="truncate flex-1 flex flex-col min-w-0">
          {editingId === s.id ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditingId(null);
              }}
              onBlur={commitRename}
              maxLength={80}
              className="bg-scrim-faint rounded px-1 py-0.5 text-xs font-mono w-full min-w-0 outline-none border border-border-strong text-fg"
            />
          ) : (
            <span className="truncate">{s.title}</span>
          )}
          <span className="truncate text-[10px] text-fg-dim normal-case tracking-normal">
            {sublabel} · {s.messageCount} msg · {timeAgo(s.updatedAt)}
          </span>
        </span>
        {editingId !== s.id && (
          <button onClick={(e) => { e.stopPropagation(); setEditingId(s.id); setDraftTitle(s.title); }} className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-fg-dim hover:text-accent-blue transition-all flex-shrink-0" title="Rename chat">
            <Pencil size={12} />
          </button>
        )}
        {onShareSession && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSharingId(sharingId === s.id ? null : s.id);
              setShareName('');
              setShareError(null);
            }}
            className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-fg-dim hover:text-accent-green transition-all flex-shrink-0"
            title={s.sharedWith?.length ? `Shared with ${s.sharedWith.join(', ')} — manage sharing` : 'Share this chat with another user'}
          >
            <Share2 size={12} />
          </button>
        )}
        <button onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }} className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-fg-dim hover:text-accent-red transition-all flex-shrink-0" title="Delete chat">
          <Trash2 size={12} />
        </button>
      </div>
      {sharingId === s.id && onShareSession && (
        <div className="ml-7 mb-1 rounded-lg bg-panel-strong/60 border border-border-faint px-2.5 py-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {(s.sharedWith?.length ?? 0) > 0 ? (
            <div className="flex flex-wrap gap-1">
              {s.sharedWith!.map((u) => (
                <span key={u} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-accent-green/10 border border-accent-green/30 text-[10px] text-accent-green">
                  @{u}
                  {onUnshareSession && (
                    <button
                      type="button"
                      onClick={() => void onUnshareSession(s.id, u).then((err) => { if (err) setShareError(err); })}
                      className="hover:text-accent-red transition-colors"
                      title={`Stop sharing with @${u}`}
                    >
                      <X size={10} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-fg-dim">Only you can see this chat. Sharing lets another user read and chat in it (never rename, delete, or re-share).</p>
          )}
          <div className="flex gap-1.5">
            <input
              value={shareName}
              onChange={(e) => setShareName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitShare(s.id); }}
              placeholder="Username to share with…"
              autoComplete="off"
              className="flex-1 min-w-0 bg-surface border border-border-soft rounded-md px-2 py-1 text-[11px] text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent-blue transition-colors"
            />
            <button
              type="button"
              disabled={shareBusy || !shareName.trim()}
              onClick={() => void submitShare(s.id)}
              className="px-2 py-1 rounded-md text-[11px] font-bold bg-accent-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {shareBusy ? '…' : 'Share'}
            </button>
          </div>
          {shareError && <p className="text-[10px] text-accent-red">{shareError}</p>}
        </div>
      )}
    </>
    );
  };

  return (
    <ModalShell open={open} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex flex-col h-full">
        {/* Header: title + tabs + search + actions */}
        <div className="px-5 py-4 border-b border-border-soft shrink-0 space-y-3">
          <div className="flex items-center gap-3">
            <MessagesSquare size={16} className="text-accent-blue shrink-0" />
            <h2 className="text-sm font-semibold text-fg-strong tracking-wide uppercase">Chat History</h2>
            <div className="flex items-center gap-0.5 bg-panel-strong rounded-lg p-0.5 border border-border-soft">
              {(['general', 'projects'] as HistoryTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'px-3 py-1 rounded-md text-[11px] font-semibold capitalize transition-colors',
                    tab === t ? 'bg-accent-blue/15 text-accent-blue' : 'text-fg-dim hover:text-fg-strong',
                  )}
                >
                  {t} chats
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <button onClick={() => { onNewChat(); onClose(); }} className="flex items-center gap-1 px-2.5 py-1.5 bg-accent-blue/20 text-accent-blue rounded-lg text-[10px] font-bold tracking-wider uppercase hover:bg-accent-blue/30 transition-colors">
              <Plus size={12} /> New Chat
            </button>
            <button onClick={onClose} className="p-1.5 text-fg-dim hover:text-fg-strong rounded-lg transition-colors" title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Search size={13} className="text-fg-dim shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
              placeholder={`Search ${tab} chats…`}
              className="flex-1 min-w-0 text-xs bg-panel-strong border border-border-soft rounded-lg px-2.5 py-1.5 text-fg-strong focus:outline-none focus:border-accent-blue/50"
            />
            {query && (
              <span className="text-[10px] text-fg-dim whitespace-nowrap">{filtered.length} result{filtered.length === 1 ? '' : 's'}</span>
            )}
          </div>
        </div>

        {/* Body: grouped project chats or flat general feed */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
          {filtered.length === 0 && (
            <div className="h-full flex items-center justify-center">
              <EmptyState
                icon={<MessagesSquare size={18} />}
                title={query ? `No ${tab} chats match "${query}"` : `No ${tab} chats yet`}
                hint="Start a chat from the sidebar, and it will show up here."
              />
            </div>
          )}
          {tab === 'projects' ? (
            projectGroups.map(([name, list]) => (
              <div key={name} className="mb-2">
                <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] uppercase tracking-wider text-fg-dim font-bold">
                  <FolderGit2 size={11} className="text-accent-blue/70" />
                  <span className="truncate">{name}</span>
                  <span className="text-fg-faint">({list.length})</span>
                </div>
                <div className="space-y-0.5">
                  {list.map((s) => <Row key={s.id} s={s} />)}
                </div>
              </div>
            ))
          ) : (
            <div className="space-y-0.5">
              {filtered.map((s) => <Row key={s.id} s={s} />)}
            </div>
          )}
        </div>

        <div className="px-5 py-2 border-t border-border-faint shrink-0 text-[10px] text-fg-dim">
          {tab === 'general' ? filtered.length : projectGroups.reduce((n, [, l]) => n + l.length, 0)} chat{filtered.length === 1 ? '' : 's'} · tapping a chat opens it in its own workspace
        </div>
      </div>
    </ModalShell>
  );
}