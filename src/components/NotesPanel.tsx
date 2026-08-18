import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StickyNote, RefreshCw, Send, Search, FileText } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { projectApi } from '../utils/projectApi';
import { cn } from '../lib/utils';
import type { Project } from '../types';
import './NotesPanel.css';

// Phase 5 (UPGRADE-ROADMAP.md, 2026-08-12): the Notes panel — Apple Notes reference (flat
// list, no per-row card borders; each row = semibold first line, muted preview, timestamp).
// Add/Search go through the normal WS trigger-command path so the terminal stays the single
// source of truth.
//
// 2026-08-12 Stage C: true 2-column split — left list rail (240px, --overlay, flat rows on
// --border-faint separators), right editor surface (--panel, borderless full-text view).
// Selection + filter persist per project ID via localStorage so switching projects restores
// each project's own view.

interface NoteInfo {
  text: string;
  date: string | null;
}

interface NotesPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
  /** Phase T (2026-08-14): the tab whose workspace this panel's REST calls address. */
  tabId?: string | null;
}

const POLL_MS = 15000;
const selKey = (projectId: string) => `console.notesSelection.${projectId}`;
const filterKey = (projectId: string) => `console.notesFilter.${projectId}`;

export function NotesPanel({ project, onSendMessage, tabId = null }: NotesPanelProps) {
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newInput, setNewInput] = useState('');
  const [filter, setFilter] = useState('');
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  // Phase 5: in-place edit draft — the right-pane textarea was read-only with no way to
  // change a note. null = not editing; saves go through the normal `note:` trigger
  // (append path — the store's exact-dedupe makes an unchanged re-save a no-op, and an
  // edited text lands as a fresh note line, oldest copy kept).
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the pending "last sent" timer on unmount so its delayed setState can't fire on a
  // dead panel (and hold the panel's closure alive after it unmounted).
  useEffect(() => () => { if (lastSentTimer.current) clearTimeout(lastSentTimer.current); }, []);

  // Switching the selected note resets the draft so it never shows another note's text.
  const selectedTextRef = useRef<string | null>(null);
  const prevSelectedText = selectedText;
  useEffect(() => {
    if (prevSelectedText !== selectedTextRef.current) {
      selectedTextRef.current = prevSelectedText;
      setEditDraft(null);
    }
  }, [prevSelectedText]);

  // Persist selection + filter per project ID. Selection is stored by note text (the note's
  // stable identity) — an index would silently point at a different note after a filter or
  // refetch changed the list order.
  useEffect(() => {
    if (!project?.id) return;
    setSelectedText((() => {
      const raw = localStorage.getItem(selKey(project.id));
      return raw === null || raw === '' ? null : raw;
    })());
    setFilter(localStorage.getItem(filterKey(project.id)) ?? '');
  }, [project?.id]);

  useEffect(() => {
    if (!project?.id) return;
    if (selectedText !== null) localStorage.setItem(selKey(project.id), selectedText);
    else localStorage.removeItem(selKey(project.id));
    localStorage.setItem(filterKey(project.id), filter);
  }, [project?.id, selectedText, filter]);

  const fetchNotes = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    const data = await apiFetchJson<{ notes: NoteInfo[] }>(projectApi(`/api/projects/${encodeURIComponent(project.id)}/notes`, tabId));
    setLoading(false);
    if (!data) { setError('Could not load notes.'); return; }
    setError(null);
    setNotes(data.notes || []);
  }, [project?.id, tabId]);

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

  // Phase 5: save the edited note (blur or Cmd/Ctrl+Enter) through the same trigger path —
  // unchanged text is a no-op server-side (exact dedupe), so this only fires on real edits.
  const saveEdit = () => {
    if (editDraft === null) return;
    const trimmed = editDraft.trim();
    setEditDraft(null);
    if (!trimmed || trimmed === selected?.text) return;
    send(`note: ${trimmed}`);
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

  // Clamp the persisted selection into the current (possibly refetched) list — by text, so a
  // filter change can never silently select a different note.
  const selected = filtered.find((n) => n.text === selectedText) ?? filtered[0] ?? null;

  const titleOf = (n: NoteInfo) => n.text.split('\n')[0];
  const previewOf = (n: NoteInfo) => n.text.split('\n').slice(1).join(' ');

  return (
    <div className="notes-panel h-full flex flex-col">
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-faint shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-accent-blue/15 text-accent-blue">
            <StickyNote size={16} />
          </div>
          <h2 className="text-sm font-semibold tracking-wide uppercase text-fg-strong">
            Notes
          </h2>
          {project && (
            <span className="text-xs font-normal normal-case text-fg-muted">— {project.name}</span>
          )}
        </div>
        <button onClick={fetchNotes} className="p-1.5 rounded-lg text-fg-muted hover:text-fg-strong transition-colors" title="Refresh">
          <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {error && <p className="text-xs px-4 py-1.5 text-accent-red">{error}</p>}

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        {/* Left list rail — 240px, --overlay, flat rows on --border-faint separators */}
        <div className="sm:w-[240px] shrink-0 sm:border-r border-b sm:border-b-0 border-border-faint bg-overlay flex flex-col min-h-0">
          <div className="p-2 shrink-0">
            <div className="flex items-center gap-2 px-2 py-1 min-h-[44px] rounded-xl bg-panel border border-border-faint">
              <StickyNote size={15} className="text-accent-blue/60 ml-1 shrink-0" />
              <input
                value={newInput}
                onChange={(e) => setNewInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                placeholder="New note — e.g. buy milk"
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-dim text-fg-strong min-w-0"
              />
              <button
                onClick={handleAdd}
                disabled={!newInput.trim()}
                className="shrink-0 p-1.5 rounded-lg text-accent-blue opacity-80 hover:opacity-100 disabled:opacity-30 transition-opacity"
                title="Add note"
              >
                <Send size={15} />
              </button>
            </div>
            <div className="flex items-center gap-2 px-2 py-1 min-h-[40px] mt-2 rounded-xl bg-panel border border-border-faint">
              <Search size={14} className="text-fg-muted ml-1 shrink-0" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                placeholder="Filter notes…"
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-dim text-fg-strong min-w-0"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {notes.length === 0 && !loading ? (
              <div className="text-center py-8 px-3 text-[13px] text-fg-muted">
                No notes yet. Add one above or type{' '}
                <code className="text-[11px] text-accent-blue">note: buy milk</code> in chat.
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-8 px-3 text-[13px] text-fg-muted">
                No notes match "{filter.trim()}".
              </div>
            ) : (
              filtered.map((n, i) => (
                <div key={n.text}>
                  <button
                    onClick={() => setSelectedText(n.text)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 min-h-[48px] transition-colors',
                      n.text === selected?.text ? 'bg-panel-strong' : 'hover:bg-panel-strong/60',
                    )}
                  >
                    <div className="text-[13px] font-semibold leading-snug truncate text-fg-strong">
                      {titleOf(n)}
                    </div>
                    <div className="text-[11px] text-fg-muted truncate mt-0.5">
                      {previewOf(n) || n.date || ''}
                    </div>
                  </button>
                  {i < filtered.length - 1 && (
                    <div className="border-b border-border-faint mx-3" />
                  )}
                </div>
              ))
            )}
            {loading && notes.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
                <RefreshCw size={14} className="animate-spin" /> Loading…
              </div>
            )}
          </div>
        </div>

        {/* Right editor surface — --panel, borderless full-text view */}
        <div className="flex-1 min-h-0 bg-panel flex flex-col">
          {selected ? (
            <>
              <div className="px-5 pt-4 shrink-0 flex items-start justify-between gap-3">
                <div className="text-[18px] font-bold text-fg-strong break-words min-w-0">{titleOf(selected)}</div>
                {selected.date && (
                  <span className="text-[11px] text-fg-muted shrink-0 mt-1.5">{selected.date}</span>
                )}
              </div>
              <textarea
                value={editDraft ?? selected.text}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={saveEdit}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    saveEdit();
                  }
                }}
                className="flex-1 w-full bg-transparent border-none outline-none resize-none px-5 py-3 text-[13px] leading-[18px] text-fg-subtle"
                spellCheck={false}
              />
              <div className="px-5 pb-3 shrink-0 text-[10px] text-fg-dim">
                Editable — changes save on blur (or Cmd/Ctrl+Enter) through the chat trigger; new notes go through the terminal (single source of truth).
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-fg-muted">
              <FileText size={28} className="opacity-40" />
              <p className="text-[13px]">Select a note to read it here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
