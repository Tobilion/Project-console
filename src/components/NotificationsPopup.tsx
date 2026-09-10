// E-4 (2026-09-10): anchored notifications popup — the bell opens THIS, not the Tools
// grid entry. Fixed top-right under the header, backdrop-click/Esc to close, explicit
// mark-read (opening never auto-dismisses). The full Notifications tool panel stays one
// click away via "Open full panel" (same direct-REST endpoints the panel uses, so the
// two can never diverge on what "read" means).

import { useEffect, useState } from 'react';
import { Bell, Check, X, ArrowRight } from 'lucide-react';
import { apiFetchJson } from '../utils/apiFetch';
import type { NotificationHistoryItem } from './notifications/rules';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationsPopup({ open, onClose, onOpenFullPanel, onRead }: {
  open: boolean;
  onClose: () => void;
  onOpenFullPanel: () => void;
  /** Called after any successful dismiss so the header badge zeroes immediately. */
  onRead: () => void;
}) {
  const [items, setItems] = useState<NotificationHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    apiFetchJson<{ history?: NotificationHistoryItem[] }>('/api/notifications')
      .then((data) => {
        if (!cancelled && data?.history) {
          setItems([...data.history].sort((a, b) => b.timestamp - a.timestamp));
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const unread = items.filter((h) => !h.dismissed);
  const shown = [...unread, ...items.filter((h) => h.dismissed)].slice(0, 8);

  const dismiss = async (id: string) => {
    const data = await apiFetchJson('/api/notifications/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!data) return;
    setItems((prev) => prev.map((h) => (h.id === id || id === 'all' ? { ...h, dismissed: true } : h)));
    onRead();
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Notifications"
        className="fixed z-50 top-[60px] right-4 w-[360px] max-w-[calc(100vw-2rem)] max-h-[60vh] flex flex-col bg-panel border border-border-strong rounded-2xl shadow-modal overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-faint shrink-0">
          <Bell size={15} className="text-accent-orange" />
          <h2 className="text-sm font-semibold text-fg-strong">Notifications</h2>
          {unread.length > 0 && (
            <span className="px-1.5 py-px rounded-full bg-accent-orange/15 text-accent-orange text-[10px] font-bold">
              {unread.length} new
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {unread.length > 0 && (
              <button
                type="button"
                onClick={() => void dismiss('all')}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-fg-dim hover:text-fg-strong hover:bg-scrim-faint transition-colors"
                title="Mark everything read"
              >
                <Check size={12} /> Mark all read
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-fg-dim hover:text-fg-strong transition-colors"
              aria-label="Close notifications"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {loading && items.length === 0 ? (
            <p className="text-xs text-fg-dim text-center py-6">Loading…</p>
          ) : shown.length === 0 ? (
            <div className="text-center py-6">
              <Bell size={20} className="mx-auto text-fg-faint mb-2" />
              <p className="text-xs text-fg-dim">Nothing yet — watches, schedules and crashes land here.</p>
            </div>
          ) : (
            shown.map((h) => (
              <div
                key={h.id}
                className={`flex items-start gap-2 px-3 py-2 rounded-xl ${h.dismissed ? 'opacity-55' : 'bg-panel-strong/60'}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-fg-strong truncate">{h.title}</p>
                  <p className="text-[11px] text-fg-muted truncate">{h.body}</p>
                  <p className="text-[10px] text-fg-faint mt-0.5">{timeAgo(h.timestamp)}</p>
                </div>
                {!h.dismissed && (
                  <button
                    type="button"
                    onClick={() => void dismiss(h.id)}
                    className="shrink-0 p-1 rounded-md text-fg-dim hover:text-accent-green transition-colors"
                    title="Mark read"
                  >
                    <Check size={13} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
        <button
          type="button"
          onClick={() => { onClose(); onOpenFullPanel(); }}
          className="shrink-0 flex items-center justify-center gap-1.5 px-4 py-2.5 border-t border-border-faint text-xs font-semibold text-accent-blue hover:bg-accent-blue/5 transition-colors"
        >
          Open full panel <ArrowRight size={13} />
        </button>
      </div>
    </>
  );
}
