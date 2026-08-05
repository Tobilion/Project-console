// Phase 12 leaf: process registry + per-process output ring buffer for executor.js
// (verbatim moves). The `runningProcesses` map is the single shared instance every consumer
// (stop server, Processes dock, AI stopProcess tool, monitoring routes) reads — it must never
// be duplicated.

import { forgetDevUrl } from './devUrlStore.js';
import { broadcast } from './wsServer.js';

// Track running processes so they can be killed by the user
// (Cleared on module load to handle HMR — stale children from previous module scope
//  are orphaned; we start fresh each time the module re-executes.)
export const runningProcesses = new Map(); // projectId -> { child, command }

// --- Phase 6: per-process output ring buffer (memory only) ---
// Keeps the tail of each tracked process's stdout/stderr so the Processes dock can replay
// recent output to a (re)connecting client — the live chat stream itself is connection-scoped
// (sendEvent → originating ws only) and is deliberately NOT re-broadcast.
const MAX_LOG_LINES = 2000;
export { MAX_LOG_LINES };

/** Tail-capped line buffer. Handles chunks that split a line across two `data` events by
 *  holding the unterminated tail in `pending` until the next chunk completes it. */
export class LineRingBuffer {
  constructor(cap) {
    this.cap = cap;
    this.lines = [];
    this.pending = '';
  }
  push(text) {
    this.pending += text;
    const parts = this.pending.split('\n');
    this.pending = parts.pop();
    this.lines.push(...parts);
    if (this.lines.length > this.cap) {
      this.lines.splice(0, this.lines.length - this.cap);
    }
  }
  snapshot() {
    return this.pending ? [...this.lines, this.pending] : [...this.lines];
  }
}

export const processLogs = new Map(); // projectId -> LineRingBuffer

/** Returns { command, lines } for a tracked process's log (or null when untracked). */
export function getProcessLog(projectId) {
  const proc = runningProcesses.get(projectId);
  if (!proc) return null;
  const buf = processLogs.get(projectId);
  return { command: proc.command, lines: buf ? buf.snapshot() : [] };
}

/**
 * Single kill path for every caller that stops a tracked process — the "stop server" trigger
 * phrase (connection.js), the `stop_process` WS message (dock stop button), and the AI-mode
 * `stopProcess` tool. Was previously copy-pasted three times; all three now route here so the
 * cleanup (kill + map delete + log delete + lastDevUrls delete + both broadcasts) can never
 * drift. Returns { ok: false } when nothing is tracked for that project.
 */
export function stopTrackedProcess(projectId) {
  const proc = runningProcesses.get(projectId);
  if (!proc) return { ok: false };
  try {
    proc.child.kill('SIGTERM');
  } catch {}
  runningProcesses.delete(projectId);
  processLogs.delete(projectId);
  forgetDevUrl(projectId);
  broadcast({ type: 'dashboard_update' });
  broadcast({ type: 'processes_update' });
  return { ok: true, command: proc.command };
}

// Clean up on exit — kills tracked children before Node shuts down
process.on('exit', () => {
  for (const [, proc] of runningProcesses) {
    try { proc.child.kill('SIGTERM'); } catch {}
  }
  runningProcesses.clear();
});
process.on('SIGTERM', () => {
  for (const [, proc] of runningProcesses) {
    try { proc.child.kill('SIGTERM'); } catch {}
  }
  runningProcesses.clear();
});
