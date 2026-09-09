// F-11 (2026-09-08/09): chat-native rich tool UI, first card type. Renders a
// `reminders`-type TerminalMessageCard (see src/types.ts) as an Apple-Reminders-style
// checklist inline in the chat thread — tap a row to mark it done, done rows move to a
// struck-through completed section, instead of the plain markdown list `list my reminders`
// renders by default (that markdown text is UNCHANGED and still sits above this card — see
// messageContent.tsx — so CLI/accessibility and any client that doesn't understand `card`
// still get the full answer).
//
// "Done" here calls the exact same DELETE /api/reminders/:id the Reminders panel's own
// cancel button uses (server/routes/reminderRoutes.js, D-7) — there is no separate
// "completed but kept" state in the schedule store (cancelling a reminder removes it
// outright), so this card's completed section is a local, session-lifetime visual — reopening
// the chat later shows the reminder gone entirely (consistent with `cancel reminder <id>`
// already being a hard delete everywhere else in the app, just presented with Apple
// Reminders' "tap to complete" language instead of "cancel").
import React, { useState } from 'react';
import { Check } from 'lucide-react';
import type { ReminderCardItem } from '../../types';

export function ReminderCard({ items }: { items: ReminderCardItem[] }) {
  // Local optimistic state: id -> 'pending' (in-flight DELETE) | 'done' (confirmed) | 'error'.
  const [status, setStatus] = useState<Record<string, 'pending' | 'done' | 'error'>>({});

  if (!items || items.length === 0) return null;

  const handleToggle = async (id: string) => {
    if (status[id] === 'pending' || status[id] === 'done') return;
    setStatus((prev) => ({ ...prev, [id]: 'pending' }));
    try {
      const res = await fetch(`/api/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({ ok: false }));
      setStatus((prev) => ({ ...prev, [id]: data.ok ? 'done' : 'error' }));
    } catch {
      setStatus((prev) => ({ ...prev, [id]: 'error' }));
    }
  };

  const active = items.filter((it) => status[it.id] !== 'done');
  const done = items.filter((it) => status[it.id] === 'done');

  return (
    <div className="mt-3 pt-3 border-t border-border-soft">
      <div className="rounded-xl border border-border-soft overflow-hidden bg-surface/40">
        {active.map((it) => (
          <ReminderRow key={it.id} item={it} pending={status[it.id] === 'pending'} error={status[it.id] === 'error'} onToggle={() => handleToggle(it.id)} />
        ))}
        {done.length > 0 && (
          <div className="border-t border-border-faint">
            <p className="px-3 pt-2 text-[9px] font-bold tracking-wider uppercase text-fg-dim">Completed</p>
            {done.map((it) => (
              <ReminderRow key={it.id} item={it} done onToggle={() => {}} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReminderRow({
  item, done, pending, error, onToggle,
}: {
  item: ReminderCardItem;
  done?: boolean;
  pending?: boolean;
  error?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={done || pending}
      className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-panel-strong/50 transition-colors disabled:cursor-default"
      title={done ? 'Completed' : 'Tap to mark done'}
    >
      <span
        className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
          done
            ? 'bg-accent-blue border-accent-blue'
            : pending
            ? 'border-accent-blue/60 animate-pulse'
            : 'border-fg-dim'
        }`}
      >
        {done && <Check size={10} className="text-white" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm leading-snug ${done ? 'line-through text-fg-dim' : 'text-fg'}`}>
          {item.text}
        </span>
        {item.label && !done && (
          <span className="block text-[10px] text-fg-subtle mt-0.5">{item.label}</span>
        )}
        {error && (
          <span className="block text-[10px] text-accent-red mt-0.5">Couldn't complete it — try again.</span>
        )}
      </span>
    </button>
  );
}
