import React, { useEffect } from 'react';

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  maxWidth?: string;
  children: React.ReactNode;
}

/** Shared modal overlay: fixed backdrop + centered panel + Esc-to-close. Extracted from
 *  UserProfileModal.tsx (Phase 1 modularization) so every modal owns this shell once; the
 *  welcome-tour overlay is structurally different (fixed z-50 card, local state machine) and
 *  stays on WelcomeScreen for now. */
export function ModalShell({ open, onClose, maxWidth = 'max-w-md', children }: ModalShellProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-scrim-strong backdrop-blur-sm" onClick={onClose} />
      <div className={`relative z-10 w-full ${maxWidth} mx-4 bg-panel/90 backdrop-blur-xl border border-border-strong rounded-2xl shadow-modal overflow-hidden max-h-[85vh] flex flex-col`}>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
