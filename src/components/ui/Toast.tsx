import { useSyncExternalStore } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { dismissToast, getToasts, subscribeToast, type Toast } from './toastStore';

function ToastCard({ toast }: { toast: Toast }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      role="status"
      aria-live="polite"
      className="pointer-events-auto relative w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border-strong bg-panel shadow-float p-3 pl-3.5 overflow-hidden"
    >
      <div className="flex items-start gap-2.5">
        <CheckCircle2 size={16} className="text-accent-green mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-fg-strong leading-snug">{toast.title}</p>
          {toast.description && (
            <p className="text-[11px] text-fg-dim mt-0.5 leading-snug">{toast.description}</p>
          )}
          {toast.actionLabel && (
            <button
              onClick={() => {
                toast.onAction?.();
                dismissToast(toast.id);
              }}
              className="mt-1.5 text-[11px] font-medium text-accent-blue hover:text-fg-strong transition-colors"
            >
              {toast.actionLabel}
            </button>
          )}
        </div>
        <button
          onClick={() => dismissToast(toast.id)}
          aria-label="Dismiss notification"
          className={cn('p-0.5 shrink-0 text-fg-dim hover:text-fg-strong transition-colors')}
        >
          <X size={14} />
        </button>
      </div>
      {/* Auto-dismiss countdown bar (2026-08-24, Matchday Exchange's toast pattern): the
          3px progress line visibly drains over the toast's lifetime. */}
      <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-accent-blue/20 overflow-hidden rounded-b-xl">
        <div
          className="h-full bg-accent-blue/70 animate-toast-progress"
          style={{ animationDuration: `${toast.duration ?? 4000}ms` }}
        />
      </div>
    </motion.div>
  );
}

/** Fixed bottom-right toast stack. Rendered once from App so any module can fire addToast(). */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToast, getToasts, getToasts);
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
