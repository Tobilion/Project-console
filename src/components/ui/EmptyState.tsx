import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface EmptyStateProps {
  /** lucide-react icon element rendered in a surface chip above the title. */
  icon?: ReactNode;
  title: string;
  hint?: string;
  /** Optional primary action (e.g. "Scan a folder" on the empty dashboard). */
  action?: { label: string; onClick: () => void };
  className?: string;
}

/**
 * Shared designed empty state (2026-08-24) — icon chip + title + hint + optional action,
 * modeled on the ClipboardPanel's off-state card so every panel/list gets a first-run
 * affordance instead of bare "No X found" text. Pure presentational; zinc-token themed.
 */
export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 px-6 text-center', className)}>
      {icon && (
        <div className="w-11 h-11 rounded-2xl bg-surface border border-border-faint flex items-center justify-center text-fg-subtle">
          {icon}
        </div>
      )}
      <p className="text-[13px] font-medium text-fg-strong">{title}</p>
      {hint && <p className="text-[11px] text-fg-dim max-w-[280px] leading-relaxed">{hint}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-1 text-[11px] font-medium text-accent-blue hover:text-fg-strong transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}