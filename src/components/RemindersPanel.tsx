import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListChecks, RefreshCw, Plus, Check, Send, Clock } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import { cn } from '../lib/utils';
import type { Project } from '../types';
import './RemindersPanel.css';

// Phase 4 (UPGRADE-ROADMAP.md, 2026-08-12): the Reminders panel — Apple Reminders reference
// with concrete design tokens from the Design Tokens Appendix. Every mutation (create /
// complete-as-cancel) goes through the normal WS trigger-command path so the terminal stays
// the single source of truth for answers and confirmations.

interface ReminderInfo {
  id: string;
  text: string;
  label: string;
  type: string;
  fireAt: number | null;
  weekday: number | null;
  hour: number | null;
  minute: number | null;
  everyMs: number | null;
  projectName: string;
  projectId: string;
  lastFiredAt: number | null;
  createdAt: number | null;
}

interface RemindersPanelProps {
  project: Project | null;
  onSendMessage: (text: string) => void;
}

const POLL_MS = 15000;
const REFETCH_AFTER_SEND_MS = 1400;
const END_OF_TODAY = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};

function isOverdue(fireAt: number): boolean {
  return fireAt < Date.now();
}

export function RemindersPanel({ project, onSendMessage }: RemindersPanelProps) {
  const [reminders, setReminders] = useState<ReminderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newInput, setNewInput] = useState('');
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Set<string>>(new Set());
  const lastSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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
  }, []);

  useEffect(() => {
    fetchReminders();
    pollTimer.current = setInterval(fetchReminders, POLL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [fetchReminders]);

  const send = (text: string) => {
    onSendMessage(text);
    setLastSent(text);
    if (lastSentTimer.current) clearTimeout(lastSentTimer.current);
    lastSentTimer.current = setTimeout(() => setLastSent(null), 8000);
    setTimeout(fetchReminders, REFETCH_AFTER_SEND_MS);
  };

  const handleAdd = () => {
    const trimmed = newInput.trim();
    if (!trimmed) return;
    const phrase = /^(remind\s+me\b|set\s+a\s+reminder\b)/i.test(trimmed)
      ? trimmed
      : `remind me ${trimmed}`;
    send(phrase);
    setNewInput('');
  };

  const handleComplete = (id: string) => {
    setCompleting((prev) => new Set(prev).add(id));
    send(`cancel reminder ${id}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd();
  };

  const { today, upcoming, all } = useMemo(() => {
    const t: ReminderInfo[] = [];
    const u: ReminderInfo[] = [];
    const a: ReminderInfo[] = [];
    const todayEnd = END_OF_TODAY();
    const now = Date.now();
    for (const r of reminders) {
      if (r.type === 'oneshot' && r.fireAt !== null) {
        if (r.fireAt <= todayEnd) t.push(r);
        else u.push(r);
      }
      a.push(r);
    }
    t.sort((a, b) => (a.fireAt || 0) - (b.fireAt || 0));
    u.sort((a, b) => (a.fireAt || 0) - (b.fireAt || 0));
    a.sort((a, b) => {
      const ad = a.type === 'oneshot' && a.fireAt ? a.fireAt : Infinity;
      const bd = b.type === 'oneshot' && b.fireAt ? b.fireAt : Infinity;
      return ad - bd;
    });
    return { today: t, upcoming: u, all: a };
  }, [reminders]);

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
    return (
      <div
        className={cn(
          'flex items-center gap-3 px-2 py-2 min-h-[48px] rounded-[10px] transition-colors',
          completingThis ? 'opacity-40' : '',
        )}
      >
        <button
          onClick={() => handleComplete(reminder.id)}
          disabled={completingThis}
          className="shrink-0 w-[24px] h-[24px] rounded-full border-2 flex items-center justify-center transition-all"
          style={{
            borderColor: 'var(--rm-gray4)',
            minWidth: '24px',
            minHeight: '24px',
          }}
          title="Complete (removes the reminder)"
        >
          {completingThis ? (
            <Check size={14} color="var(--rm-blue)" strokeWidth={3} />
          ) : null}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[17px] font-semibold leading-snug truncate"
            style={{ color: 'var(--rm-label)' }}>
            {reminder.text}
          </div>
          <div className="text-[13px] mt-0.5"
            style={{ color: overdue ? 'var(--rm-red)' : 'var(--rm-label2)' }}>
            {reminder.label}
            {reminder.projectId !== project?.id && reminder.projectName && (
              <span className="opacity-70"> · {reminder.projectName}</span>
            )}
          </div>
        </div>
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

  const inputCls = 'flex-1 bg-transparent text-[17px] outline-none placeholder:opacity-40';
  const sectionSep = (style: React.CSSProperties = {}) => (
    <div className="border-b mx-2" style={{ borderColor: 'var(--rm-sep)', ...style }} />
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
          <button onClick={fetchReminders} className="p-1.5 rounded-md hover:opacity-70 transition-opacity" title="Refresh" style={{ color: 'var(--rm-label2)' }}>
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {error && (
          <p className="text-xs mb-3" style={{ color: 'var(--rm-red)' }}>{error}</p>
        )}

        {/* New reminder input row */}
        <div className="flex items-center gap-2 px-2 py-1 min-h-[44px] rounded-[10px] mb-2"
          style={{ backgroundColor: 'var(--rm-group-bg)' }}>
          <Plus size={18} style={{ color: 'var(--rm-blue)', opacity: 0.5, marginLeft: 2 }} />
          <input
            value={newInput}
            onChange={(e) => setNewInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="New reminder — e.g. tomorrow at 9am to call the dentist"
            className={inputCls}
            style={{ color: 'var(--rm-label)' }}
          />
          {newInput.trim() && <SendButton />}
        </div>

        {lastSent && (
          <div className="mb-3 text-[12px] px-2" style={{ color: 'var(--rm-blue)' }}>
            Sent: <code className="font-mono text-[11px]">{lastSent}</code> — follow the result in chat below.
          </div>
        )}

        {/* Sectioned list */}
        {reminders.length === 0 && !loading ? (
          <div className="text-center py-10 text-[15px]" style={{ color: 'var(--rm-label2)' }}>
            No reminders yet. Add one above or type <code className="text-[13px]" style={{ color: 'var(--rm-blue)' }}>remind me tomorrow at 9am to renew my license</code> in chat.
          </div>
        ) : (
          <div className="rounded-[12px] overflow-hidden" style={{ backgroundColor: 'var(--rm-group-bg)' }}>
            {today.length > 0 && (
              <>
                <div className="px-3">
                  <SectionHeader title="Today" count={today.length} />
                </div>
                {today.map((r) => (
                  <div key={r.id}>
                    <Row reminder={r} />
                    {sectionSep()}
                  </div>
                ))}
              </>
            )}
            {upcoming.length > 0 && (
              <>
                <div className="px-3">
                  <SectionHeader title="Upcoming" count={upcoming.length} />
                </div>
                {upcoming.map((r) => (
                  <div key={r.id}>
                    <Row reminder={r} />
                    {sectionSep()}
                  </div>
                ))}
              </>
            )}
            {all.length > 0 && (
              <>
                <div className="px-3">
                  <SectionHeader title="All" count={all.length} />
                </div>
                {all.map((r, i) => (
                  <div key={r.id}>
                    <Row reminder={r} />
                    {i < all.length - 1 && sectionSep()}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {loading && reminders.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm" style={{ color: 'var(--rm-label2)' }}>
            <Clock size={14} className="animate-spin" /> Loading…
          </div>
        )}
      </div>
    </div>
  );
}
