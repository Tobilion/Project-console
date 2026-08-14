import React, { useEffect } from 'react';
import { PendingToolConfirm, PendingMemorySuggestion } from '../types';
import { TerminalConfirmCards } from './TerminalConfirmCards';

interface ConfirmCardsOverlayProps {
  pendingConfirm: { token: string; command: string } | null;
  onConfirm: (confirmed: boolean) => void;
  pendingToolConfirm: PendingToolConfirm | null;
  onToolConfirm: (confirmed: boolean) => void;
  onApproveTask?: () => void;
  pendingMemorySuggestion?: PendingMemorySuggestion | null;
  onMemorySuggestionRespond?: (accept: boolean) => void;
}

/** App-level confirm-card overlay (2026-08-12 audit fix): TerminalConfirmCards used to render
 *  only inside TerminalMessages, which unmounts whenever the Tools view is open — so any
 *  confirm-gated action triggered from a panel (PDF merge, file tidy, duplicates delete, ...)
 *  left the user stuck with no visible approval card while the panel's "confirm in the chat
 *  below" text pointed at an unmounted chat. Rendered here as a fixed overlay, the cards are
 *  visible regardless of which top-level view (Terminal, ToolsPanel, Dashboard, ...) is
 *  active. Rendered once at App level; TerminalMessages no longer renders its own copy. */
export function ConfirmCardsOverlay(props: ConfirmCardsOverlayProps) {
  const hasPending = !!props.pendingConfirm || !!props.pendingToolConfirm || !!props.pendingMemorySuggestion;

  // Escape rejects whatever card is pending — the keyboard path out of a panel-triggered
  // confirm (a panel click can otherwise leave the card with no cancel affordance).
  useEffect(() => {
    if (!hasPending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (props.pendingToolConfirm) props.onToolConfirm(false);
      else if (props.pendingConfirm) props.onConfirm(false);
      else if (props.pendingMemorySuggestion) props.onMemorySuggestionRespond?.(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasPending, props.pendingConfirm, props.pendingToolConfirm, props.pendingMemorySuggestion, props.onConfirm, props.onToolConfirm, props.onMemorySuggestionRespond]);

  if (!hasPending) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] w-full max-w-xl px-4 pointer-events-none">
      <div className="pointer-events-auto">
        <TerminalConfirmCards {...props} />
      </div>
    </div>
  );
}
