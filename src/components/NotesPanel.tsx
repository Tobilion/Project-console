import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StickyNote, RefreshCw, Send, CheckCircle2, Search } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';
import './NotesPanel.css';

// Phase 5 (UPGRADE-ROADMAP.md, 2026-08-12): the Notes panel — Apple Notes reference (flat
// list, no per-row card borders; each row = semibold first line, muted preview, timestamp).
// Add/Search go through the normal WS trigger-command path so the terminal stays the single
// source of truth.

interface NoteInfo {
  text: string;
  date: string | null;
}

interface NotesPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
}

const POLL_MS = 15000;

export function NotesPanel({ project, onSendMessage }: NotesPanelProps) {
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newInput, setNewInput] = useState('');
  const [filter, setFilter] = useState('');
  const [lastSent, setLastSent] = useState<string | null>(null);
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNotes = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    const data = await apiFetchJson<{ notes: NoteInfo[] }>(`/api/projects/${encodeURIComponent(project.id)}/notes`);
    setLoading(false);
    if (!data) { setError('Could not load notes.'); return; }
    setError(null);
    setNotes(data.notes || []);
  }, [project?.id]);

  useEffect(() => {
    if (project?.id) {
      fetchNotes();
      const t = setInterval(fetchNotes, POLL_MS);
      return () => clearInterval(t);
    }
  }, [project?.id, fetchNotes]);

  const send = (text: string) => {
    onSendMessage(text);
    setLastSent(text);
    if (lastSentTimer.current) clearTimeout(lastSentTimer.current);
    lastSentTimer.current = setTimeout(() => setLastSent(null), 8000);
    setTimeout(fetchNotes, 1200);
  };

  const handleAdd = () => {
    const trimmed = newInput.trim();
    if (!trimmed) return;
    send(/^note\s*:/i.test(trimmed) ? trimmed : `note: ${trimmed}`);
    setNewInput('');
  };

  const handleSearch = () => {
    const q = filter.trim();
    if (!q) return;
    send(`search my notes for ${q}`);
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : notes;
    return base.slice().reverse();
  }, [notes, filter]);

  const inputCls = 'flex-1 bg-transparent text-[17px] outline-none placeholder:opacity-40';
  const labelCls = 'text-[13px]';

  return (
    <div className="notes-panel h-full overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--rm-blue)', opacity: 0.15, color: 'var(--rm-blue)' }}>
              <StickyNote size={16} />
            </div>
            <h2 className="text-sm font-semibold tracking-wide uppercase" style={{ color: 'var(--rm-label)' }}>
              Notes
            </h2>
            {project && (
              <span className="text-xs font-normal normal-case" style={{ color: 'var(--rm-label2)' }}>— {project.name}</span>
            )}
          </div>
          <button onClick={fetchNotes} className="p-1.5 rounded-md hover:opacity-70 transition-opacity" title="Refresh" style={{ color: 'var(--rm-label2)' }}>
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {error && <p className="text-xs mb-3" style={{ color: '#FF453A' }}>{error}</p>}

        {/* Add-note input row */}
        <div className="flex items-center gap-2 px-2 py-1 min-h-[44px] rounded-[10px] mb-2"
          style={{ backgroundColor: 'var(--rm-group-bg)' }}>
          <StickyNote size={16} style={{ color: 'var(--rm-blue)', opacity: 0.5, marginLeft: 2 }} />
          <input
            value={newInput}
            onChange={(e) => setNewInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="New note — e.g. buy milk"
            className={inputCls}
            style={{ color: 'var(--rm-label)' }}
          />
          <button
            onClick={handleAdd}
            disabled={!newInput.trim()}
            className="shrink-0 p-2 rounded-lg opacity-70 hover:opacity-100 disabled:opacity-30 transition-opacity"
            style={{ color: 'var(--rm-blue)' }}
            title="Add note"
          >
            <Send size={16} />
          </button>
        </div>

        {/* Live search filter */}
        <div className="flex items-center gap-2 px-2 py-1 min-h-[44px] rounded-[10px] mb-3"
          style={{ backgroundColor: 'var(--rm-group-bg)' }}>
          <Search size={15} style={{ color: 'var(--rm-label2)', marginLeft: 2 }} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
            placeholder="Filter notes instantly… (Enter searches in chat)"
            className={inputCls}
            style={{ color: 'var(--rm-label)' }}
          />
        </div>

        {lastSent && (
          <div className="mb-3 text-[12px] px-2" style={{ color: 'var(--rm-blue)' }}>
            Sent: <code className="font-mono text-[11px]">{lastSent}</code> — follow the result in chat below.
          </div>
        )}

        {/* Flat note feed, most-recent-first */}
        {notes.length === 0 && !loading ? (
          <div className="text-center py-10 text-[15px]" style={{ color: 'var(--rm-label2)' }}>
            No notes yet. Add one above or type <code className="text-[13px]" style={{ color: 'var(--rm-blue)' }}>note: buy milk</code> in chat.
          </div>
        ) : (
          <div className="rounded-[12px] overflow-hidden" style={{ backgroundColor: 'var(--rm-group-bg)' }}>
            {filtered.length === 0 ? (
              <div className="text-center py-8 text-[14px]" style={{ color: 'var(--rm-label2)' }}>
                No notes match "{filter.trim()}".
              </div>
            ) : (
              filtered.map((n, i) => (
                <div key={i}>
                  <div className="flex items-start gap-3 px-3 py-2 min-h-[44px]">
                    <div className="flex-1 min-w-0">
                      <div className="text-[17px] font-semibold leading-snug truncate" style={{ color: 'var(--rm-label)' }}>
                        {n.text.split('\n')[0]}
                      </div>
                      {n.text.split('\n').length > 1 && (
                        <div className={labelCls} style={{ color: 'var(--rm-label2)' }}>
                          {n.text.split('\n').slice(1).join(' ')}
                        </div>
                      )}
                    </div>
                    {n.date && (
                      <span className={cn(labelCls, 'shrink-0 mt-0.5')} style={{ color: 'var(--rm-label2)', opacity: 0.7 }}>
                        {n.date}
                      </span>
                    )}
                  </div>
                  {i < filtered.length - 1 && (
                    <div className="border-b mx-2" style={{ borderColor: 'var(--rm-sep)' }} />
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {loading && notes.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm" style={{ color: 'var(--rm-label2)' }}>
            <RefreshCw size={14} className="animate-spin" /> Loading…
          </div>
        )}

        {filtered.length > 0 && notes.length > 20 && (
          <p className="text-[12px] mt-3 px-2" style={{ color: 'var(--rm-label2)' }}>
            Showing {filtered.length} of {notes.length} notes.
          </p>
        )}
      </div>
    </div>
  );
}
