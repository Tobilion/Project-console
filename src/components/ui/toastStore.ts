// Module-level toast store (2026-08-24): a tiny pub/sub so any component can fire a toast
// without prop-drilling, mirroring the useTheme store pattern (subscribe + snapshot + emit).
// Modeled on the sibling Matchday Exchange's toast store (3-toast cap, auto-dismiss) so the
// console gets the same background-completion affordance its sibling projects already have.
// Client-side only — nothing here touches the server.

export interface Toast {
  id: number;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Auto-dismiss delay in ms; default 4000. */
  duration?: number;
}

const DEFAULT_DURATION = 4000;
const MAX_TOASTS = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function addToast(input: Omit<Toast, 'id'>): number {
  const id = nextId++;
  const toast: Toast = { ...input, id, duration: input.duration ?? DEFAULT_DURATION };
  toasts = [...toasts, toast];
  if (toasts.length > MAX_TOASTS) toasts = toasts.slice(-MAX_TOASTS);
  emit();
  // Fire-and-forget auto-dismiss; the timer is the only place a toast leaves the stack.
  setTimeout(() => dismissToast(id), toast.duration);
  return id;
}

export function dismissToast(id: number) {
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) emit();
}

export function subscribeToast(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getToasts(): Toast[] {
  return toasts;
}

// Profile-synced toast prefs (B.3, 2026-09-09): reminderToastDurationMs /
// reminderToastPosition live in the server profile (edited in Settings), but toast call
// sites are module-level functions with no access to React state — so useUserProfile mirrors
// just these display prefs (plus aiRedirectDelayMs, read the same way in wsMessageCases.ts)
// into localStorage['console.profile'], and these helpers read them back. Everything is
// sanitized on read (server already clamps on write; this covers a hand-edited key too),
// and every fallback matches the pre-existing hardcoded behavior exactly, so a missing key
// changes nothing.

export type ReminderToastPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

const REMINDER_TOAST_POSITIONS: ReminderToastPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];

function readProfilePrefs(): { reminderToastDurationMs?: unknown; reminderToastPosition?: unknown; aiRedirectDelayMs?: unknown } {
  try {
    // The mirror key lives in useUserProfile (single source of truth); kept inline here
    // to keep this store dependency-free (same contract as the zero-import wsReply/atomics).
    const raw = localStorage.getItem('console.profile');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** How long reminder toasts (fired + undo) stay up. Default 8000 = the old hardcoded value. */
export function reminderToastDuration(): number {
  const v = readProfilePrefs().reminderToastDurationMs;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(2000, Math.min(30000, v)) : 8000;
}

/** Where the toast stack anchors. Default 'bottom-right' = the old fixed position. */
export function reminderToastPosition(): ReminderToastPosition {
  const v = readProfilePrefs().reminderToastPosition;
  return typeof v === 'string' && (REMINDER_TOAST_POSITIONS as string[]).includes(v)
    ? (v as ReminderToastPosition)
    : 'bottom-right';
}

/** Delay before auto-opening a panel after an AI trigger command. Default 0 = instant. */
export function aiRedirectDelay(): number {
  const v = readProfilePrefs().aiRedirectDelayMs;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(10000, v)) : 0;
}
