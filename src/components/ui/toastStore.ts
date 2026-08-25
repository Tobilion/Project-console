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
