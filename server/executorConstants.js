// Executor tuning knobs (2026-08-24, split out of executor.js — the orchestrator should
// stay a thin reader of knobs, not their owner). Like semanticMatcher's knobs, these exports
// are the DEFAULTS; data/tuning.json overrides (tuningStore.js) shadow them at each use site
// via getTuning. Keep the names in sync with tuningStore.js's BOUNDS map.

/** Grace after a dev-server URL appears before detaching, so trailing output can flush. */
export const DEV_URL_DETACH_GRACE_MS = 500;
/** Force-detach for recognized dev servers that never printed a URL. */
export const DEV_SERVER_FORCE_DETACH_MS = 10000;
/** Longer force-detach for unrecognized long-running commands (some one-shot scripts legitimately take a while). */
export const LONG_RUNNING_FORCE_DETACH_MS = 20000;
/** Final stdout/stderr caps for the tool-result summary — the UI only needs the tail. */
export const STDOUT_SUMMARY_CAP = 4000;
export const STDERR_SUMMARY_CAP = 2000;
/** Delay before probing a detached process that exited on its own (Windows npm wrappers can
 *  close the tracked child early while the real server keeps serving — give it a moment). */
export const DETACHED_EXIT_PROBE_DELAY_MS = 2000;
/** Timeout for that liveness probe. */
export const DETACHED_EXIT_PROBE_TIMEOUT_MS = 1500;
/** Bound on how long a dev server may sit at an unanswered port-conflict prompt before it is
 *  force-detached (matches the 5-minute confirmation TTL in state.js's sweep). */
export const PORT_PROMPT_ANSWER_TIMEOUT_MS = 5 * 60 * 1000;
// Post-detach dev-URL recovery (2026-08-18): a slow cold start can print the "Local:"
// banner AFTER the force-detach deadline (Matchday Exchange's vite took >10s on a loaded
// machine — console + NetPulse + tsx watch all running). The old detach() removed every
// stdout listener, so the banner was dropped forever: no recordDevUrl, no server_url
// event, no open-site chip, and the Live Sites tab (filtered on devUrl) showed nothing.
// The stdout handler now stays attached in URL-scan-only mode after detach; these bound
// the fallback probe that covers servers which never print a URL at all.
/** Delay before the post-detach recovery probe starts — gives a slow server time to bind. */
export const DEV_URL_RECOVERY_PROBE_DELAY_MS = 3000;
/** Per-candidate probe timeout for the recovery pass. */
export const DEV_URL_RECOVERY_PROBE_TIMEOUT_MS = 1000;
/** Max candidate URLs probed per recovery pass (candidateDevUrls caps at 3 anyway). */
export const DEV_URL_RECOVERY_MAX_CANDIDATES = 3;