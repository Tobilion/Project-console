import { useEffect, useState } from 'react';
import { X, Bell } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { cn } from '../lib/utils';

// Reminder composer popup (2026-09-07): the "Set reminder" buttons in the Reminders and
// Notes panels used to fire a bare `remind me <text>` straight into chat with no chance to
// set a date/time — every tweak meant another chat round trip. This modal collects the
// details up front and composes the exact trigger phrase the chat path already understands,
// so confirm flow, journaling and the terminal stay the single source of truth. No new WS
// type, no protocol change; the CLI is unaffected.

interface ReminderComposerProps {
  open: boolean;
  /** Prefilled reminder text (e.g. the note's first line, or the quick-add draft). */
  initialText: string;
  /** When editing an existing reminder, its id — the caller cancels it after saving. */
  editingId?: string | null;
  onClose: () => void;
  /** Receives the composed trigger phrase (e.g. `remind me tomorrow at 9am to X`). */
  onSave: (phrase: string) => void;
}

type DateMode = 'none' | 'today' | 'tomorrow' | 'date';
type Repeat = 'never' | 'daily' | 'weekly';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ReminderComposer({ open, initialText, editingId, onClose, onSave }: ReminderComposerProps) {
  const [text, setText] = useState(initialText);
  const [dateMode, setDateMode] = useState<DateMode>('tomorrow');
  const [date, setDate] = useState(todayYmd());
  const [time, setTime] = useState('09:00');
  const [repeat, setRepeat] = useState<Repeat>('never');

  useEffect(() => {
    if (open) {
      setText(initialText);
      setDateMode('tomorrow');
      setDate(todayYmd());
      setTime('09:00');
      setRepeat('never');
    }
  }, [open, initialText]);

  const timePart = time ? `at ${to12h(time)}` : '';

  const preview = (() => {
    const t = text.trim() || '…';
    if (repeat === 'daily') return `remind me daily ${timePart} to ${t}`;
    if (repeat === 'weekly') {
      const base = dateMode === 'date' && date ? new Date(`${date}T12:00:00`) : new Date();
      return `remind me every ${WEEKDAYS[base.getDay()]} ${timePart} to ${t}`;
    }
    if (dateMode === 'none') return `remind me ${t}`;
    if (dateMode === 'today') return `remind me today ${timePart} to ${t}`;
    if (dateMode === 'tomorrow') return `remind me tomorrow ${timePart} to ${t}`;
    return `remind me on ${date} ${timePart} to ${t}`;
  })().replace(/\s+/g, ' ').trim();

  const canSave = text.trim().length > 0;

  const segBtn = (active: boolean) =>
    cn(
      'px-2.5 py-1.5 rounded-lg border text-[11px] text-center transition-colors',
      active
        ? 'border-accent-blue bg-accent-blue/10 text-accent-blue font-bold'
        : 'border-border-soft bg-surface text-fg-muted hover:border-border-strong',
    );

  return (
    <ModalShell open={open} onClose={onClose} maxWidth="max-w-sm">
      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-accent-orange/15 text-accent-orange">
              <Bell size={15} />
            </div>
            <h3 className="text-sm font-bold text-fg-strong">
              {editingId ? 'Edit reminder' : 'New reminder'}
            </h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-fg-dim hover:text-fg-strong transition-colors" title="Close">
            <X size={15} />
          </button>
        </div>

        <label className="block text-[11px] font-semibold text-fg-dim mb-1">What</label>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. see the note: shopping list"
          className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-blue transition-colors mb-3"
        />

        <label className="block text-[11px] font-semibold text-fg-dim mb-1">Date</label>
        <div className="grid grid-cols-4 gap-1.5 mb-2">
          {(['none', 'today', 'tomorrow', 'date'] as DateMode[]).map((m) => (
            <button key={m} type="button" onClick={() => setDateMode(m)} className={segBtn(dateMode === m)}>
              {m === 'none' ? 'No date' : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        {dateMode === 'date' && (
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-blue transition-colors mb-2"
          />
        )}

        {dateMode !== 'none' && (
          <>
            <label className="block text-[11px] font-semibold text-fg-dim mb-1 mt-1">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full bg-surface border border-border-soft rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent-blue transition-colors mb-2"
            />
          </>
        )}

        <label className="block text-[11px] font-semibold text-fg-dim mb-1 mt-1">Repeat</label>
        <div className="grid grid-cols-3 gap-1.5 mb-4">
          {(['never', 'daily', 'weekly'] as Repeat[]).map((r) => (
            <button key={r} type="button" onClick={() => setRepeat(r)} className={segBtn(repeat === r)}>
              {r[0].toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>

        <div className="text-[11px] text-fg-dim bg-scrim-faint border border-border-soft rounded-lg px-3 py-2 mb-4 font-mono break-words">
          {preview}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-xs text-fg-subtle hover:text-fg-strong transition-colors">
            Cancel
          </button>
          <button
            onClick={() => { if (canSave) onSave(preview); }}
            disabled={!canSave}
            className="px-4 py-2 bg-accent-blue text-white rounded-lg text-xs font-bold tracking-wider uppercase hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {editingId ? 'Save' : 'Set reminder'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
