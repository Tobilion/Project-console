import { useEffect } from 'react';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Focus trap for modal overlays (2026-08-24): Tab/Shift+Tab cycle within the dialog so
 * keyboard focus can never reach background content while it is open; moves focus to the
 * first focusable on open. Extracted from ModalShell's inline trap so the custom overlays
 * (CommandDeck, ShortcutsOverlay, TourOverlay) get the same behavior without duplicating it.
 */
export function useFocusTrap(panelRef: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
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
    const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [panelRef, active]);
}