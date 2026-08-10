// Phase 12 leaf: process registry + per-process output ring buffer for executor.js
// (verbatim moves). The `runningProcesses` map is the single shared instance every consumer
// (stop server, Processes dock, AI stopProcess tool, monitoring routes) reads — it must never
// be duplicated.

import { forgetDevUrl } from './devUrlStore.js';
import { broadcast } from './wsServer.js';

// Track running processes so they can be killed by the user
// (Cleared on module load to handle HMR — stale children from previous module scope
//  are orphaned; we start fresh each time the module re-executes.)
// Multi-slot per project (projectId -> pid -> entry) since the NetPulse serve+watch fix
// (2026-08-10): a project's config can legitimately run several long-lived commands at once
// (dashboard + measurement loop). Each command owns its own slot and deletes only itself on
// 'close', so a short-lived build running next to a dev server can never orphan the server
// from its cleanup paths the way a single-slot overwrite used to.
export const runningProcesses = new Map(); // projectId -> Map<pid, { child, command, ... }>

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

/** All tracked entries for a project, newest-started last (Map iteration order). */
export function getTrackedProcesses(projectId) {
  const slot = runningProcesses.get(projectId);
  return slot ? [...slot.values()] : [];
}

/** Returns { command, lines } for a tracked process's log (or null when untracked). The log
 *  buffer is per-project (all of the project's processes share one interleaved tail), so the
 *  command reported is the newest-started process's. */
export function getProcessLog(projectId) {
  const procs = getTrackedProcesses(projectId);
  if (procs.length === 0) return null;
  const buf = processLogs.get(projectId);
  return { command: procs[procs.length - 1].command, lines: buf ? buf.snapshot() : [] };
}

/** Removes a single tracked process by pid. Returns true when it actually removed an entry;
 *  when the project's slot empties, the project key and its log buffer go with it. Never
 *  forgets the recorded dev URL or broadcasts — callers own those decisions (the URL can
 *  belong to a different, still-running process of the same project). */
export function removeTrackedProcess(projectId, pid) {
  const slot = runningProcesses.get(projectId);
  if (!slot || !slot.has(pid)) return false;
  slot.delete(pid);
  if (slot.size === 0) {
    runningProcesses.delete(projectId);
    processLogs.delete(projectId);
  }
  return true;
}

/**
 * Single kill path for every caller that stops a tracked process — the "stop server" trigger
 * phrase (connection.js), the `stop_process` WS message (dock stop button), and the AI-mode
 * `stopProcess` tool. Was previously copy-pasted three times; all three now route here so the
 * cleanup (kill + map delete + log delete + lastDevUrls delete + both broadcasts) can never
 * drift. Stops every tracked process for the project — "stop server" is one user intent, and
 * a single-slot-style "stop just one" would silently leave siblings running. Returns
 * { ok: false } when nothing is tracked for that project.
 */
export function stopTrackedProcess(projectId) {
  const procs = getTrackedProcesses(projectId);
  if (procs.length === 0) return { ok: false };
  const commands = [];
  for (const proc of procs) {
    try {
      proc.child.kill('SIGTERM');
    } catch {}
    commands.push(proc.command);
  }
  runningProcesses.delete(projectId);
  processLogs.delete(projectId);
  forgetDevUrl(projectId);
  broadcast({ type: 'dashboard_update' });
  broadcast({ type: 'processes_update' });
  return { ok: true, command: commands.join('` and `') };
}

// Clean up on exit — kills tracked children before Node shuts down
process.on('exit', () => {
  for (const [, slot] of runningProcesses) {
    for (const [, proc] of slot) {
      try { proc.child.kill('SIGTERM'); } catch {}
    }
  }
  runningProcesses.clear();
});
process.on('SIGTERM', () => {
  for (const [, slot] of runningProcesses) {
    for (const [, proc] of slot) {
      try { proc.child.kill('SIGTERM'); } catch {}
    }
  }
  runningProcesses.clear();
});
