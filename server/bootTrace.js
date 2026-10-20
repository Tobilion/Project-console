// Opt-in boot timing trace (2026-10-20).
//
// The console's cold start has two very different halves: the work the server does before
// it binds a port (project discovery, the embedding model, NLP training) and the work a
// CLIENT does before it can talk (port probing, project picking, socket setup). Both were
// previously invisible — the user saw a spinner with no phases, and the server's own log
// lines only started once the matcher began loading, which made the pre-matcher time
// impossible to attribute.
//
// This module is OFF by default. Set CONSOLE_BOOT_TRACE=1 to get one line per phase with
// the elapsed milliseconds since the process started. It is deliberately dependency-free
// (no pino import) so it can be used from any boot leaf without dragging the logger graph
// in, and it writes to stderr so it interleaves correctly with the existing [boot-state]
// markers the desktop splash reads.

const START = Date.now();

let enabled = process.env.CONSOLE_BOOT_TRACE === '1' || process.env.CONSOLE_BOOT_TRACE === 'true';

/** Enables the trace at runtime (used by the CLI launcher before it spawns the server). */
export function enableBootTrace() {
  enabled = true;
}

/** True when tracing is on — callers can skip expensive work (stat calls, directory walks). */
export function bootTraceEnabled() {
  return enabled;
}

/**
 * Records a boot phase. `detail` is optional and must be cheap to build — it is only
 * formatted when tracing is on.
 */
export function traceBoot(phase, detail) {
  if (!enabled) return;
  const elapsed = Date.now() - START;
  const suffix = detail === undefined || detail === null || detail === '' ? '' : ` ${detail}`;
  process.stderr.write(`[boot-trace] ${String(elapsed).padStart(7)}ms ${phase}${suffix}\n`);
}

/** Milliseconds since this module was first imported — the server's own boot clock. */
export function bootElapsedMs() {
  return Date.now() - START;
}
