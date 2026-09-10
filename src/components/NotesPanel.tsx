import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StickyNote, RefreshCw, Send, Search, FileText, Trash2, Bold, Italic, List, Code, Eye } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { apiFetchJson } from '../utils/apiFetch';
import { projectApi } from '../utils/projectApi';
import { usePanelPolling, useFlashMessage } from '../hooks/usePanelPolling';
import { PANEL_POLL_SLOW_MS } from '../constants';
import { cn } from '../lib/utils';
import { EmptyState } from './ui/EmptyState';
import { ReminderComposer } from './ReminderComposer';
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
  onSendMessage: (text: string, opts?: { source?: string; tool?: string }) => void;
  /** Phase T (2026-08-14): the tab whose workspace this panel's REST calls address. */
  tabId?: string | null;
}

const POLL_MS = PANEL_POLL_SLOW_MS;
const selKey = (projectId: string) => `console.notesSelection.${projectId}`;
const filterKey = (projectId: string) => `console.notesFilter.${projectId}`;

export function NotesPanel({ project, onSendMessage, tabId = null }: NotesPanelProps) {
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newInput, setNewInput] = useState('');
  const [filter, setFilter] = useState('');
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [lastSent, flashSent] = useFlashMessage();
  // Phase 5: in-place edit draft — the right-pane textarea was read-only with no way to
  // change a note. null = not editing; saves go through the normal `note:` trigger
  // (append path — the store's exact-dedupe makes an unchanged re-save a no-op, and an
  // edited text lands as a fresh note line, oldest copy kept).
  const [editDraft, setEditDraft] = useState<string | null>(null);
  // Reminder composer popup — opened from the "Set reminder" button with the note's first
  // line prefilled, so the date/time can be set before anything hits chat.
  const [composerOpen, setComposerOpen] = useState(false);
  // F-5(1): recycle bin — deleted notes move to notes.trash.md instead of vanishing.
  // The rail toggles between the live list and the trash; restores/empties go through
  // the same direct-REST endpoints the chat `system.notes.trash` handler uses.
  const [showTrash, setShowTrash] = useState(false);
  const [trash, setTrash] = useState<NoteInfo[]>([]);

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
    // Recycle state is per-project — never show another project's trash.
    setShowTrash(false);
    setTrash([]);
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

  usePanelPolling(fetchNotes, POLL_MS, !!project?.id);

  // D-7 (2026-09-08): create/delete now hit the direct REST endpoints in noteRoutes.js
  // instead of composing a chat trigger phrase — the panel no longer round-trips through
  // the WS/matcher pipeline or leaves a create/delete confirmation bubble in the chat
  // transcript. `flashSent` (shared hook, Phase B.2) drives the panel's own inline
  // confirmation (a small "Saved"/"Deleted" flash), decoupled from onSendMessage.

  // "Set reminder" (creating a schedule linked to this note) is not part of this pass —
  // reminder creation still goes through the chat pipeline (its own direct-REST migration,
  // if warranted, is separate scope from the notes create/delete work here).
  const sendChatPhrase = (text: string) => {
    onSendMessage(text, { source: 'panel', tool: 'notes' });
    setTimeout(fetchNotes, 1200);
  };

  const createNote = async (text: string) => {
    if (!project?.id) return;
    const result = await apiFetchJson<{ success: boolean; data?: string; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/notes`, tabId),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }
    );
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.success) { setError(result.error || 'Could not save the note.'); return; }
    setError(null);
    flashSent(result.data || 'Note saved.');
    fetchNotes();
  };

  const handleAdd = () => {
    const trimmed = newInput.trim();
    if (!trimmed) return;
    createNote(trimmed.replace(/^note\s*:\s*/i, ''));
    setNewInput('');
  };

  const handleDelete = async () => {
    if (!selected || !project?.id) return;
    const noteText = selected.text.split('\n')[0];
    const result = await apiFetchJson<{ success: boolean; data?: string; error?: string; removedReminders?: number; linkedKept?: number }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/notes`, tabId),
      { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: noteText }) }
    );
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.success) { setError(result.error || 'Could not delete the note.'); return; }
    setError(null);
    const linkedHint = result.removedReminders ? ` (and ${result.removedReminders} linked reminder${result.removedReminders > 1 ? 's' : ''})` : '';
    // F-5 (2026-09-09): with askBeforeDeleteLinkedNote on (the default) the REST delete keeps
    // linked reminders instead of auto-cancelling — say so, pointing at the Reminders panel.
    const keptHint = result.linkedKept ? ` (${result.linkedKept} linked reminder${result.linkedKept > 1 ? 's' : ''} kept — cancel in Reminders if unneeded)` : '';
    flashSent(`Deleted: ${result.data}${linkedHint}${keptHint} — kept in the recycle bin below.`);
    setSelectedText(null);
    fetchNotes();
    fetchTrash();
  };

  const fetchTrash = useCallback(async () => {
    if (!project?.id) return;
    const data = await apiFetchJson<{ trash: NoteInfo[] }>(projectApi(`/api/projects/${encodeURIComponent(project.id)}/notes/trash`, tabId));
    if (!data) return;
    setTrash(data.trash || []);
  }, [project?.id, tabId]);

  const handleRestore = async (note: NoteInfo) => {
    if (!project?.id) return;
    // Include the date when known so same-text twins restore unambiguously.
    const key = note.date ? `${note.text} (${note.date})` : note.text;
    const result = await apiFetchJson<{ success: boolean; data?: string; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/notes/restore`, tabId),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: key }) }
    );
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.success) { setError(result.error || 'Could not restore the note.'); return; }
    setError(null);
    flashSent(`Restored: ${result.data}`);
    fetchNotes();
    fetchTrash();
  };

  const handleEmptyTrash = async () => {
    if (!project?.id || trash.length === 0) return;
    const result = await apiFetchJson<{ success: boolean; count?: number }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/notes/trash/empty`, tabId),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
    );
    if (!result) { setError('Could not reach the server.'); return; }
    setError(null);
    flashSent(result.count ? `Emptied the recycle bin (${result.count} permanently deleted).` : 'The recycle bin is already empty.');
    fetchTrash();
  };

  // Phase 4: rich text toolbar — inserts markdown syntax at cursor position in the editor.
  const insertMarkdown = (prefix: string, suffix: string) => {
    const textarea = document.querySelector('.notes-panel textarea') as HTMLTextAreaElement | null;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = editDraft ?? selected?.text ?? '';
    const highlighted = text.slice(start, end);
    const newText = text.slice(0, start) + prefix + (highlighted || 'text') + suffix + text.slice(end);
    setEditDraft(newText);
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + (highlighted || 'text').length);
    }, 10);
  };

  // F-6: preview mode — the toolbar inserts markdown syntax, so the editor gets a
  // rendered preview alongside the raw textarea (same react-markdown + theme-token
  // .prose the terminal uses), making "Bold" visibly bold instead of bare asterisks.
  const [showPreview, setShowPreview] = useState(false);

  // Phase 5: save the edited note (blur or Cmd/Ctrl+Enter) as a true IN-PLACE replace
  // (PUT .../notes → replaceNoteText) — F-6: the old path appended the edited text as
  // a fresh line via createNote, orphaning the previous version. Unchanged text is a
  // server-side no-op; twin/duplicate collisions refuse with the reason shown.
  const saveEdit = async () => {
    if (editDraft === null || !selected || !project?.id) return;
    const trimmed = editDraft.trim();
    if (!trimmed || trimmed === selected.text) { setEditDraft(null); return; }
    const result = await apiFetchJson<{ success: boolean; data?: string; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/notes`, tabId),
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldText: selected.text, newText: trimmed }) }
    );
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.success) { setError(result.error || 'Could not save the note.'); return; }
    setError(null);
    setEditDraft(null);
    // Selection is keyed by text — follow the note to its new text.
    setSelectedText(trimmed);
    flashSent('Saved.');
    fetchNotes();
  };

  // Search is already a live client-side filter over the fetched list (see `filtered`
  // below) — there is no server round-trip to make here at all, chat-routed or REST. Enter
  // just blurs the input; the filter has already been applying as the user types.
  const handleSearch = () => {
    (document.activeElement as HTMLElement | null)?.blur();
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

  // J (notes parity): checklist + tag support is pure render over the plain-text store —
  // `- [ ]`/`- [x]` markers toggle through the existing in-place PUT (F-6), `#tag`
  // tokens filter through the existing substring filter. No store format change.
  const taskOf = (text: string) => text.match(/^\s*- \[([ xX])\]\s?([\s\S]*)$/);
  const toggleTaskText = (text: string) => {
    const m = taskOf(text);
    if (!m) return null;
    const done = m[1].toLowerCase() === 'x';
    return `- [${done ? ' ' : 'x'}] ${m[2]}`;
  };
  const tagsOf = (text: string) => {
    const out: string[] = [];
    for (const m of text.matchAll(/#([A-Za-z0-9_-]{2,32})/g)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
  };
  const allTags = useMemo(() => {
    const out: string[] = [];
    for (const n of notes) for (const t of tagsOf(n.text)) if (!out.includes(t)) out.push(t);
    return out.sort();
  }, [notes]);

  const handleToggleTask = async (note: NoteInfo) => {
    if (!project?.id) return;
    const next = toggleTaskText(note.text);
    if (!next) return;
    // Dated key when known (unambiguous for twins), same as restore.
    const key = note.date ? `${note.text} (${note.date})` : note.text;
    const result = await apiFetchJson<{ success: boolean; data?: string; error?: string }>(
      projectApi(`/api/projects/${encodeURIComponent(project.id)}/notes`, tabId),
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldText: key, newText: next }) }
    );
    if (!result) { setError('Could not reach the server.'); return; }
    if (!result.success) { setError(result.error || 'Could not update the checklist.'); return; }
    setError(null);
    setSelectedText(next);
    flashSent(result.data === 'No changes.' ? 'No changes.' : 'Updated.');
    fetchNotes();
  };

  // J: highlight the active filter term inside rail rows so a search visibly lands.
  const highlight = (text: string, term: string) => {
    const q = term.trim();
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-accent-blue/25 text-inherit rounded-sm px-px">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  return (
    <div className="notes-panel h-full flex flex-col glass glass-panel">
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
      {/* D-7: inline confirmation for a direct-REST create/delete — no chat bubble to check
          instead, so the panel needs to say what happened itself. */}
      {!error && lastSent && (
        <p className="text-xs px-4 py-1.5 text-accent-green">{lastSent}</p>
      )}

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
            {/* F-5(1): recycle bin toggle — deleted notes wait here until restored or
                the bin is emptied, instead of vanishing on delete. */}
            {/* J: tag chips — one tap filters to that tag (the filter is already a
                substring match, so `#tag` just works; tapping the active tag clears it). */}
            {!showTrash && allTags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 px-1">
                {allTags.map((t) => {
                  const active = filter.trim() === `#${t}`;
                  return (
                    <button
                      key={t}
                      onClick={() => setFilter(active ? '' : `#${t}`)}
                      className={cn(
                        'px-2 py-0.5 rounded-full text-[10px] transition-colors border',
                        active
                          ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/30 font-semibold'
                          : 'text-fg-dim border-border-faint hover:text-fg-strong hover:border-border-soft',
                      )}
                      title={active ? 'Clear tag filter' : `Filter to #${t}`}
                    >
                      #{t}
                    </button>
                  );
                })}
              </div>
            )}
            <button
              onClick={() => { const next = !showTrash; setShowTrash(next); if (next) fetchTrash(); }}
              className={cn(
                'mt-2 w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors border border-border-faint',
                showTrash ? 'bg-panel-strong text-fg-strong' : 'bg-panel text-fg-dim hover:text-fg-strong',
              )}
              title={showTrash ? 'Back to notes' : 'Show deleted notes'}
            >
              <Trash2 size={13} />
              <span className="flex-1 text-left">{showTrash ? 'Back to notes' : 'Recycle bin'}</span>
              {trash.length > 0 && (
                <span className="px-1.5 py-px rounded-full bg-scrim-faint text-[10px] font-bold">{trash.length}</span>
              )}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {showTrash ? (
              trash.length === 0 ? (
                <EmptyState
                  icon={<Trash2 size={18} />}
                  title="Recycle bin is empty"
                  hint="Deleted notes wait here until you restore or empty them."
                />
              ) : (
                <>
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-[11px] text-fg-dim">{trash.length} deleted note{trash.length === 1 ? '' : 's'}</span>
                    <button
                      onClick={handleEmptyTrash}
                      className="text-[11px] text-accent-red hover:text-fg-strong transition-colors px-2 py-1 rounded hover:bg-accent-red/10"
                      title="Permanently delete everything in the bin"
                    >
                      Empty trash
                    </button>
                  </div>
                  {trash.slice().reverse().map((n) => (
                    <div key={`${n.text}::${n.date ?? ''}`}>
                      <div className="w-full flex items-center gap-1 px-3 py-2.5 min-h-[48px]">
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-semibold leading-snug truncate text-fg-strong">
                            {titleOf(n)}
                          </div>
                          <div className="text-[11px] text-fg-muted truncate mt-0.5">
                            {previewOf(n) || n.date || ''}
                          </div>
                        </div>
                        <button
                          onClick={() => handleRestore(n)}
                          className="shrink-0 px-2 py-1 rounded-lg text-[11px] text-accent-blue hover:bg-accent-blue/10 transition-colors"
                          title="Move this note back to your notes"
                        >
                          Restore
                        </button>
                      </div>
                      <div className="border-b border-border-faint mx-3" />
                    </div>
                  ))}
                </>
              )
            ) : notes.length === 0 && !loading ? (
              <EmptyState
                icon={<StickyNote size={18} />}
                title="No notes yet"
                hint="Add one above, or type note: buy milk in chat."
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title={`No notes match "${filter.trim()}"`}
                hint="Try a shorter search term."
                className="py-8"
              />
            ) : (
              filtered.map((n, i) => (
                <div key={n.text}>
                  <button
                    onClick={() => setSelectedText(n.text)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 min-h-[48px] transition-colors flex items-start gap-2',
                      n.text === selected?.text ? 'bg-panel-strong' : 'hover:bg-panel-strong/60',
                    )}
                  >
                    {/* J: checklist toggle — stops the row-select click, flips the
                        marker through the in-place PUT, selection follows the text. */}
                    {taskOf(n.text) && (
                      <input
                        type="checkbox"
                        checked={taskOf(n.text)![1].toLowerCase() === 'x'}
                        onChange={() => void handleToggleTask(n)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 shrink-0 accent-accent-blue"
                        title="Toggle done"
                      />
                    )}
                    <span className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold leading-snug truncate text-fg-strong">
                        {highlight(titleOf(n), filter)}
                      </div>
                      <div className="text-[11px] text-fg-muted truncate mt-0.5">
                        {highlight(previewOf(n) || n.date || '', filter)}
                      </div>
                    </span>
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
                <div className="flex items-center gap-1.5 shrink-0">
                  {selected.date && (
                    <span className="text-[11px] text-fg-muted mt-1.5">{selected.date}</span>
                  )}
                  <button
                    onClick={handleDelete}
                    className="p-1.5 rounded-lg text-fg-dim hover:text-accent-red hover:bg-accent-red/10 transition-colors"
                    title="Delete this note"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {/* Rich text toolbar — markdown formatting buttons */}
              <div className="px-5 py-1.5 shrink-0 flex items-center gap-1 border-b border-border-faint">
                <button onClick={() => insertMarkdown('**', '**')} className="p-1.5 rounded text-fg-dim hover:text-fg-strong hover:bg-scrim-faint transition-colors" title="Bold (Ctrl+B)">
                  <Bold size={13} />
                </button>
                <button onClick={() => insertMarkdown('_', '_')} className="p-1.5 rounded text-fg-dim hover:text-fg-strong hover:bg-scrim-faint transition-colors" title="Italic (Ctrl+I)">
                  <Italic size={13} />
                </button>
                <button onClick={() => insertMarkdown('\n- ', '')} className="p-1.5 rounded text-fg-dim hover:text-fg-strong hover:bg-scrim-faint transition-colors" title="List">
                  <List size={13} />
                </button>
                <button onClick={() => insertMarkdown('`', '`')} className="p-1.5 rounded text-fg-dim hover:text-fg-strong hover:bg-scrim-faint transition-colors" title="Code">
                  <Code size={13} />
                </button>
                <span className="text-[9px] text-fg-dim ml-2">Markdown formatting</span>
                <button
                  onClick={() => setShowPreview((v) => !v)}
                  className={cn('ml-auto flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors', showPreview ? 'text-accent-blue bg-accent-blue/10' : 'text-fg-dim hover:text-fg-strong hover:bg-scrim-faint')}
                  title={showPreview ? 'Back to editing' : 'Preview rendered formatting'}
                >
                  <Eye size={12} /> {showPreview ? 'Edit' : 'Preview'}
                </button>
              </div>
              {showPreview ? (
                <div className="flex-1 overflow-y-auto px-5 py-3">
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown>{editDraft ?? selected.text}</ReactMarkdown>
                  </div>
                </div>
              ) : (
              <textarea
                value={editDraft ?? selected.text}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={() => void saveEdit()}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    saveEdit();
                  }
                  // Keyboard shortcuts for bold/italic
                  if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
                    e.preventDefault();
                    insertMarkdown('**', '**');
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
                    e.preventDefault();
                    insertMarkdown('_', '_');
                  }
                }}
                className="flex-1 w-full bg-transparent border-none outline-none resize-none px-5 py-3 text-[13px] leading-[18px] text-fg-subtle"
                spellCheck={false}
              />
              )}
              <div className="px-5 pb-3 shrink-0 flex items-center justify-between text-[10px] text-fg-dim">
                <span>Editable — changes save on blur (or Cmd/Ctrl+Enter). Use the toolbar for formatting.</span>
                <button
                  onClick={() => setComposerOpen(true)}
                  className="text-accent-blue hover:text-fg-strong transition-colors px-2 py-1 rounded hover:bg-accent-blue/10"
                  title="Create a reminder linked to this note"
                >
                  Set reminder
                </button>
              </div>
              <ReminderComposer
                open={composerOpen}
                initialText={`see the note: ${selected.text.split('\n')[0].slice(0, 60)}`}
                onClose={() => setComposerOpen(false)}
                onSave={(phrase) => { setComposerOpen(false); sendChatPhrase(phrase); }}
              />
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
