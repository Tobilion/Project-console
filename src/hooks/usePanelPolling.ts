// Shared panel scaffold (Phase B.2 dedup, 2026-09-08): every tool panel re-implemented the
// same two small patterns by hand -- "fetch on mount, then again on an interval, tear down
// on unmount" and "show a confirmation message that clears itself after 8s" -- with its own
// copy of the interval/timeout ref bookkeeping (Backup/Notes/Notifications/Clipboard/Pdf/
// Reminders/FileTools panels). Both are pulled out here so a panel only supplies the fetch
// function and, for the flash message, the duration.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Runs `fetchFn` once immediately, then every `intervalMs`, while `enabled` stays true. */
export function usePanelPolling(fetchFn: () => void | Promise<void>, intervalMs: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    fetchFn();
    const t = setInterval(fetchFn, intervalMs);
    return () => clearInterval(t);
    // fetchFn is expected to be memoized by the caller (useCallback) -- including it here
    // would restart the interval on every render otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, fetchFn]);
}

/**
 * Tracks a transient status message that self-clears after `durationMs` (default 8000, the
 * value every panel previously hardcoded). Returns the current message and a setter that
 * displays a new one and (re)arms the auto-clear timer.
 */
export function useFlashMessage(durationMs = 8000) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flash = useCallback((text: string) => {
    setMessage(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), durationMs);
  }, [durationMs]);

  return [message, flash] as const;
}
