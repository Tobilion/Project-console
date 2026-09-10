import { useCallback, useMemo, useState } from 'react';
import { ListChecks, RefreshCw, Plus, Check, Send, Clock, SlidersHorizontal, Pencil, Trash2 } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { usePanelPolling, useFlashMessage } from '../hooks/usePanelPolling';
import { PANEL_POLL_SLOW_MS } from '../constants';
import { cn } from '../lib/utils';
import { EmptyState } from './ui/EmptyState';
import { addToast, reminderToastDuration } from './ui/toastStore';
import { ReminderComposer } from './ReminderComposer';
import type { Project } from '../types';
import { END_OF_TODAY, isOverdue, nextFireAt } from './reminders/schedule';
import type { ReminderInfo, ReminderView } from './reminders/schedule';
import './RemindersPanel.css';

// Phase 4 (UPGRADE-ROADMAP.md, 2026-08-12): the Reminders panel — Apple Reminders reference
// with concrete design tokens from the Design Tokens Appendix. Every mutation (create /
// complete-as-cancel) goes through the normal WS trigger-command path so the terminal stays
// the single source of truth for answers and confirmations.
//
// 2026-08-12 audit: (a) dateless TODOs — typing "call the dentist" (no time at all) creates
// a `type: 'todo'` reminder that lives in the No Date view and never fires; (b) the views
// (Today / Upcoming / All / No Date) are now genuinely separate switchable sections per the
// Apple Reminders/Todoist pattern — no item repeats across views.

interface RemindersPanelProps {
  project: Project | null;
  onSendMessage: (text: string, opts?: { source?: string; tool?: string }) => void;
}

const POLL_MS = PANEL_POLL_SLOW_MS;

export function RemindersPanel({ project, onSendMessage }: RemindersPanelProps) {
  const [reminders, setReminders] = useState<ReminderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newInput, setNewInput] = useState('');
  const [view, setView] = useState<ReminderView>('all');
  const [lastSent, flashSent] = useFlashMessage();
  const [completing, setCompleting] = useState<Set<string>>(new Set());
  // Reminder composer popup state — prefilled text + the id being edited (null = new).
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [composerEditingId, setComposerEditingId] = useState<string | null>(null);
  // Phase 5: completing a reminder is destructive — the shared toast store's 8s Undo re-creates
  // it (see handleComplete). The old bespoke snackbar was consolidated into the Toaster 2026-08-24.

  const fetchReminders = useCallback(async () => {
    setLoading(true);
    const data = await apiFetchJson<{ reminders: ReminderInfo[] }>('/api/reminders');
    setLoading(false);
    if (!data) {
      setError('Could not load reminders — check that the server is up.');
      return;
    }
    setError(null);
    setReminders(data.reminders || []);
    // Phase 5: prune "completing" rows the server has resolved — without this a row
    // stays greyed out forever. Completed rows stay live on the server now (F-4: complete
    // flags instead of deleting), so prune ids that are completed OR gone.
    setCompleting((prev) => {
      if (prev.size === 0) return prev;
      const byId = new Map((data.reminders || []).map((r) => [r.id, r]));
      const next = new Set([...prev].filter((id) => {
        const live = byId.get(id);
        return live && !live.completed;
      }));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  usePanelPolling(fetchReminders, POLL_MS);

  // D-7 (2026-09-08): create/cancel now hit direct REST endpoints (reminderRoutes.js)
  // instead of composing a chat trigger phrase. builtinReminders.js's handlers were never
  // confirm-gated or journaled to begin with (plain scheduleStore.js calls), so there was
  // no safety contract to preserve beyond calling the exact same parseReminderInput /
  // addSchedule / removeScheduleById functions, which the REST endpoints do directly.

  const createReminder = async (phrase: string): Promise<boolean> => {
    const result = await apiFetchJson<{ ok: boolean; error?: string; schedule?: { id: string; text: string; label?: string; type: string } }>(
      '/api/reminders',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phrase, projectId: project?.id }) }
    );
    if (!result) { setError('Could not reach the server.'); return false; }
    if (!result.ok) { setError(result.error || 'Could not create the reminder.'); return false; }
    setError(null);
    const s = result.schedule;
    flashSent(s?.type === 'todo'
      ? `Added to your list \u{1F4CB} \u2014 ${s.id}: "${s.text}"`
      : `Reminder set \u{1F514} \u2014 ${s?.id}: ${s?.label ?? ''} \u2192 "${s?.text}"`);
    fetchReminders();
    return true;
  };

  const cancelReminder = async (id: string): Promise<boolean> => {
    const result = await apiFetchJson<{ ok: boolean; error?: string; removed?: { id: string; text: string } }>(
      `/api/reminders/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
    if (!result) { setError('Could not reach the server.'); return false; }
    if (!result.ok) { setError(result.error || 'Could not cancel the reminder.'); return false; }
    setError(null);
    flashSent(`Cancelled ${result.removed?.id ?? id}.`);
    fetchReminders();
    return true;
  };

  // Quick-add supports both forms: a full trigger phrase ("remind me tomorrow at 9am to call
  // the dentist") OR bare text ("call the dentist") — bare text becomes a dateless TODO via
  // the server's no-time path. The time is genuinely optional, not a required field.
  const handleAdd = () => {
    const trimmed = newInput.trim();
    if (!trimmed) return;
    const phrase = /^(remind\s+me\b|set\s+a\s+reminder\b)/i.test(trimmed)
      ? trimmed
      : `remind me ${trimmed}`;
    createReminder(phrase);
    setNewInput('');
  };

  const handleComplete = (id: string) => {
    const r = reminders.find((x) => x.id === id);
    if (!r || r.completed) return;
    setCompleting((prev) => new Set(prev).add(id));
    // F-4: completing sets the persisted flag (POST /api/reminders/:id/complete) and moves
    // the row to the Completed section — it no longer deletes. Undo reopens the same
    // record instead of re-creating a copy. Duration is the profile's
    // reminderToastDurationMs (Settings), not a hardcoded 8s (B.3, 2026-09-09).
    completeReminder(id, true).then((ok) => {
      if (!ok) setCompleting((prev) => { const next = new Set(prev); next.delete(id); return next; });
    });
    addToast({
      title: 'Reminder completed',
      description: r.text,
      actionLabel: 'Undo',
      duration: reminderToastDuration(),
      onAction: () => { void completeReminder(id, false); },
    });
  };

  const completeReminder = async (id: string, completed: boolean): Promise<boolean> => {
    const result = await apiFetchJson<{ ok: boolean; error?: string }>(
      `/api/reminders/${encodeURIComponent(id)}/complete`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed }) }
    );
    if (!result) { setError('Could not reach the server.'); return false; }
    if (!result.ok) { setError(result.error || 'Could not update the reminder.'); return false; }
    setError(null);
    fetchReminders();
    return true;
  };

  const handleDelete = (id: string) => {
    // F-4: explicit hard-delete, distinct from complete — removes the record outright.
    void cancelReminder(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd();
  };

  const { today, upcoming, all, nodate, completed } = useMemo(() => {
    const t: ReminderInfo[] = [];
    const u: ReminderInfo[] = [];
    const n: ReminderInfo[] = [];
    const a: ReminderInfo[] = [];
    const c: ReminderInfo[] = [];
    const todayEnd = END_OF_TODAY();
    for (const r of reminders) {
      // F-4: explicitly completed reminders live in Completed, ahead of every date rule.
      if (r.completed) {
        c.push(r);
        continue;
      }
      // Phase 5.2: reminders that have already fired (oneshot with fireAt in the past) go
      // into the Completed section — they're still listed for reference until the user
      // cancels them (they auto-remove on next scheduler tick, but remain visible until then).
      if (r.type === 'oneshot' && r.fireAt !== null && r.fireAt < Date.now()) {
        c.push(r);
        continue;
      }
      if (r.type === 'todo' || r.fireAt === null) {
        n.push(r);
        continue;
      }
      const next = nextFireAt(r);
      if (next !== null && next <= todayEnd) {
        t.push({ ...r, fireAt: next });
      } else if (next !== null) {
        u.push({ ...r, fireAt: next });
      }
      a.push(r);
    }
    t.sort((x, y) => (x.fireAt || 0) - (y.fireAt || 0));
    u.sort((x, y) => (x.fireAt || 0) - (y.fireAt || 0));
    a.sort((x, y) => (x.fireAt || 0) - (y.fireAt || 0));
    n.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    c.sort((x, y) => (y.fireAt || 0) - (x.fireAt || 0));
    return { today: t, upcoming: u, all: a, nodate: n, completed: c };
  }, [reminders]);

  const viewItems: Record<ReminderView, ReminderInfo[]> = {
    today, upcoming, all, nodate, completed,
  };
  const shown = viewItems[view];

  const SectionHeader = ({ title, count }: { title: string; count: number }) => (
    <h3 className="text-[13px] font-semibold uppercase tracking-[0.05em] flex items-center gap-2 pb-1.5 pt-4 first:pt-0"
      style={{ color: 'var(--rm-label2)' }}>
      {title}
      <span className="font-normal normal-case text-[12px] opacity-80">{count}</span>
    </h3>
  );

  const Row = ({ reminder }: { reminder: ReminderInfo }) => {
    const completingThis = completing.has(reminder.id);
    const overdue = reminder.type === 'oneshot' && reminder.fireAt !== null && isOverdue(reminder.fireAt);
    const isTodo = reminder.type === 'todo' || reminder.fireAt === null;
    const done = reminder.completed === true;
    return (
      <div
        className={cn(
          'group flex items-center gap-3 px-2 py-2 min-h-[44px] transition-colors',
          completingThis ? 'opacity-50' : '',
        )}
      >
        <button
          onClick={() => handleComplete(reminder.id)}
          disabled={completingThis || done}
          className="shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all"
          style={{
            borderColor: 'var(--rm-gray4)',
            minWidth: '20px',
            minHeight: '20px',
          }}
          title={done ? 'Completed' : 'Complete (moves to the Completed section)'}
        >
          {(completingThis || done) ? (
            <Check size={12} color="var(--rm-blue)" strokeWidth={3} />
          ) : null}
        </button>
        <div className="flex-1 min-w-0">
          <div className={cn('text-[13px] font-semibold leading-snug truncate transition-all', (completingThis || done) && 'line-through')}
            style={{ color: 'var(--rm-label)' }}>
            {reminder.text}
          </div>
          <div className="text-[11px] mt-0.5"
            style={{ color: overdue ? 'var(--rm-red)' : 'var(--color-accent-orange)' }}>
            {isTodo ? 'No date' : reminder.label}
            {reminder.projectId !== project?.id && reminder.projectName && (
              <span className="opacity-70"> · {reminder.projectName}</span>
            )}
            {reminder.linkedNoteText && (
              <button
                onClick={() => onSendMessage(`show my notes`)}
                className="ml-1.5 text-accent-blue hover:text-fg-strong transition-colors inline-flex items-center gap-0.5"
                title={`Linked note: ${reminder.linkedNoteText.split('\n')[0]}`}
              >
                📝 {reminder.linkedNoteText.split('\n')[0].slice(0, 30)}{reminder.linkedNoteText.length > 30 ? '…' : ''}
              </button>
            )}
          </div>
        </div>
        <button
          onClick={() => openComposer(reminder.text, reminder.id)}
          disabled={completingThis}
          className="shrink-0 p-1.5 rounded-lg opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-scrim-faint transition-all disabled:opacity-0"
          style={{ color: 'var(--rm-label2)' }}
          title="Edit details (date, time, repeat)"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={() => handleDelete(reminder.id)}
          className="shrink-0 p-1.5 rounded-lg opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-scrim-faint transition-all text-fg-dim hover:!text-accent-red"
          title="Delete this reminder permanently"
        >
          <Trash2 size={13} />
        </button>
      </div>
    );
  };

  const SendButton = () => (
    <button
      onClick={handleAdd}
      disabled={!newInput.trim()}
      className="shrink-0 p-2 rounded-lg opacity-70 hover:opacity-100 disabled:opacity-30 transition-opacity"
      style={{ color: 'var(--rm-blue)' }}
      title="Add reminder"
    >
      <Send size={16} />
    </button>
  );

  // Composer popup: opens with the quick-add draft (or a row's text when editing) so the
  // date/time/repeat can be set before anything hits chat. Saving sends the composed
  // trigger phrase; editing additionally cancels the old reminder (both queue cleanly).
  const openComposer = (text: string, editingId: string | null = null) => {
    setComposerText(text);
    setComposerEditingId(editingId);
    setComposerOpen(true);
  };
  const handleComposerSave = async (phrase: string) => {
    setComposerOpen(false);
    if (composerEditingId) await cancelReminder(composerEditingId);
    await createReminder(phrase);
    if (!composerEditingId) setNewInput('');
  };

  const inputCls = 'flex-1 bg-transparent text-[17px] outline-none placeholder:opacity-40';
  const sectionSep = (style: React.CSSProperties = {}) => (
    <div className="border-b mx-2" style={{ borderColor: 'var(--rm-sep)', ...style }} />
  );

  const tabBtn = (v: ReminderView, label: string, count: number) => (
    <button
      onClick={() => setView(v)}
      className={cn(
        'flex flex-col items-start gap-1.5 p-3 rounded-xl border text-left transition-all',
        view === v
          ? 'bg-panel border-accent-blue/60'
          : 'bg-panel border-border-faint opacity-70 hover:opacity-100',
      )}
    >
      <span className="text-[12px] font-semibold text-fg-muted">{label}</span>
      <span className="px-1.5 py-0.5 rounded-full bg-accent-blue/15 text-accent-blue text-[11px] font-bold">
        {count}
      </span>
    </button>
  );

  return (
    <div className="reminders-panel h-full overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--rm-blue)', opacity: 0.15, color: 'var(--rm-blue)' }}>
              <ListChecks size={16} />
            </div>
            <h2 className="text-sm font-semibold tracking-wide uppercase" style={{ color: 'var(--rm-label)' }}>
              Reminders
            </h2>
          </div>
          <button onClick={fetchReminders} className="p-1.5 rounded-lg hover:opacity-70 transition-opacity" title="Refresh" style={{ color: 'var(--rm-label2)' }}>
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {error && (
          <p className="text-xs mb-3" style={{ color: 'var(--rm-red)' }}>{error}</p>
        )}

        {/* New reminder input row — time is optional: bare text becomes a dateless todo */}
        <div className="flex items-center gap-2 px-2 py-1 min-h-[44px] rounded-lg mb-2"
          style={{ backgroundColor: 'var(--rm-group-bg)' }}>
          <Plus size={18} style={{ color: 'var(--rm-blue)', opacity: 0.5, marginLeft: 2 }} />
          <input
            value={newInput}
            onChange={(e) => setNewInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="New reminder — e.g. call the dentist, or tomorrow at 9am to call the dentist"
            className={inputCls}
            style={{ color: 'var(--rm-label)' }}
          />
          {newInput.trim() && <SendButton />}
          <button
            onClick={() => openComposer(newInput.trim())}
            className="shrink-0 p-2 rounded-lg opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: 'var(--rm-blue)' }}
            title="Set details (date, time, repeat) before adding"
          >
            <SlidersHorizontal size={15} />
          </button>
        </div>

        {lastSent && (
          <div className="mb-3 text-[12px] px-2" style={{ color: 'var(--color-accent-green)' }}>
            {lastSent}
          </div>
        )}

        {/* Summary cards — each is a real switchable view; no item repeats across views */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
          {tabBtn('today', 'Today', today.length)}
          {tabBtn('upcoming', 'Upcoming', upcoming.length)}
          {tabBtn('all', 'All', all.length)}
          {tabBtn('completed', 'Completed', completed.length)}
          {tabBtn('nodate', 'No Date', nodate.length)}
        </div>

        {reminders.length === 0 && !loading ? (
          <EmptyState
            icon={<Clock size={18} />}
            title="No reminders yet"
            hint="Add one above, or type remind me tomorrow at 9am to renew my license in chat."
          />
        ) : shown.length === 0 ? (
          <div className="text-center py-8 text-[14px]" style={{ color: 'var(--rm-label2)' }}>
            Nothing in {view === 'nodate' ? 'No Date' : view[0].toUpperCase() + view.slice(1)}.
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ backgroundColor: 'var(--rm-group-bg)' }}>
            <div className="px-3">
              <SectionHeader title={view === 'nodate' ? 'No Date' : view[0].toUpperCase() + view.slice(1)} count={shown.length} />
            </div>
            {shown.map((r, i) => (
              <div key={r.id}>
                <Row reminder={r} />
                {i < shown.length - 1 && sectionSep()}
              </div>
            ))}
          </div>
        )}

        {loading && reminders.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm" style={{ color: 'var(--rm-label2)' }}>
            <Clock size={14} className="animate-spin" /> Loading…
          </div>
        )}

        <ReminderComposer
          open={composerOpen}
          initialText={composerText}
          editingId={composerEditingId}
          onClose={() => setComposerOpen(false)}
          onSave={handleComposerSave}
        />
      </div>
    </div>
  );
}
