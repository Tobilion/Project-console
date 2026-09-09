// Shared client-side constants (Phase B.3 consolidation, 2026-09-09). The same poll-interval
// literals were repeated inline across tool panels (15000ms appeared in five files + the
// header bell poll). Each panel keeps its own cadence — the consolidation targets the
// literal duplication only, so a future tuning pass edits this one file instead of nine.
// Deliberately NOT part of the server tuningStore: these are frontend render lifecycles, not
// backend knobs, and the tuningStore contract is numbers-with-bounds for server consumers.

/** Clipboard history poll — fastest, the clipboard is high-frequency. */
export const PANEL_POLL_CLIPBOARD_MS = 4000;

/** Dashboard live-sites/projects refresh. */
export const PANEL_POLL_DASHBOARD_MS = 5000;

/** PDF file list refresh — file writes are mid-frequency. */
export const PANEL_POLL_PDF_MS = 6000;

/** Notifications/trigger-history refresh. */
export const PANEL_POLL_NOTIFICATIONS_MS = 10000;

/** Slow-moving lists (backups, notes, reminders, spreadsheets) + the header bell. */
export const PANEL_POLL_SLOW_MS = 15000;