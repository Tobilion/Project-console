import React, { useEffect, useRef } from 'react';

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  maxWidth?: string;
  children: React.ReactNode;
}

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Shared modal overlay: fixed backdrop + centered panel + Esc-to-close. Extracted from
 *  UserProfileModal.tsx (Phase 1 modularization) so every modal owns this shell once; the
 *  welcome-tour overlay is structurally different (fixed z-50 card, local state machine) and
 *  stays on WelcomeScreen for now. */
export function ModalShell({ open, onClose, maxWidth = 'max-w-md', children }: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Focus trap: Tab/Shift+Tab cycle within the dialog so keyboard focus can never reach
      // background content while a modal is open.
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    // Move focus into the dialog on open so the first Tab can't start on background content.
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={`relative z-10 w-full ${maxWidth} mx-4 bg-panel/90 backdrop-blur-xl border border-border-strong rounded-2xl shadow-modal overflow-hidden max-h-[85vh] flex flex-col`}
      >
        <div className="flex-1 min-h-0 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
