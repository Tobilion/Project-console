// F-11 (2026-09-09): chat-native rich tool UI, second card type. Renders a `notes`-type
// TerminalMessageCard (see src/types.ts) as a flat Apple-Notes-style feed inline in the
// chat thread — one row per note with its date, plus a per-row delete action, instead of
// only the plain markdown list `show my notes` renders by default (that markdown text is
// UNCHANGED and still sits above this card — see messageContent.tsx — so CLI/accessibility
// and any client that doesn't understand `card` still get the full answer).
//
// Delete calls the exact same DELETE /api/projects/:id/notes the Notes panel's own delete
// button uses (server/routes/noteRoutes.js, D-7) with the note's own text as the key — the
// same normalized-match contract `delete note: ...` uses, including the F-5(2) twin
// ambiguity rule (a twin delete from the card answers the error inline on the row instead
// of removing anything). Rows removed here disappear for real: reopening the chat later
// shows them gone, consistent with the panel. No inline edit affordance — the store is
// append-only with no in-place replace (see F-6), so the panel owns editing.
import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { NoteCardItem } from '../../types';

export function NotesCard({ items }: { items: NoteCardItem[] }) {
  // Local state: row text -> 'pending' (in-flight DELETE) | 'deleted' (confirmed) | 'error'.
  const [status, setStatus] = useState<Record<string, 'pending' | 'deleted' | 'error'>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!items || items.length === 0) return null;

  const handleDelete = async (item: NoteCardItem) => {
    const key = `${item.projectId}\n${item.text}`;
    if (status[key] === 'pending' || status[key] === 'deleted') return;
    setStatus((prev) => ({ ...prev, [key]: 'pending' }));
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(item.projectId)}/notes`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.text }),
      });
      const data = await res.json().catch(() => ({ success: false }));
      if (data && data.success) {
        setStatus((prev) => ({ ...prev, [key]: 'deleted' }));
      } else {
        setStatus((prev) => ({ ...prev, [key]: 'error' }));
        setErrors((prev) => ({ ...prev, [key]: data?.error || "Couldn't delete it — try again." }));
      }
    } catch {
      setStatus((prev) => ({ ...prev, [key]: 'error' }));
      setErrors((prev) => ({ ...prev, [key]: 'Could not reach the server.' }));
    }
  };

  const visible = items.filter((it) => status[`${it.projectId}\n${it.text}`] !== 'deleted');
  if (visible.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-border-soft">
      <div className="rounded-xl border border-border-soft overflow-hidden bg-surface/40">
        {visible.map((it) => {
          const key = `${it.projectId}\n${it.text}`;
          const pending = status[key] === 'pending';
          const error = status[key] === 'error';
          return (
            <div key={key} className="w-full flex items-start gap-2.5 px-3 py-2 text-left">
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-snug text-fg">{it.text}</span>
                {it.date && (
                  <span className="block text-[10px] text-fg-subtle mt-0.5">{it.date}</span>
                )}
                {error && (
                  <span className="block text-[10px] text-accent-red mt-0.5">{errors[key]}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => handleDelete(it)}
                disabled={pending}
                className="p-1.5 shrink-0 text-fg-dim hover:text-accent-red rounded transition-colors disabled:opacity-50"
                title={pending ? 'Deleting…' : 'Delete this note'}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
