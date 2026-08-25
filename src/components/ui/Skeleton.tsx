import { cn } from '../../lib/utils';

/** Skeleton loading placeholder (2026-08-24) — replaces blank flashes while data loads.
 *  Sized by className at the call site; pulse animation, zinc-token background. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-panel-strong/70', className)} />;
}