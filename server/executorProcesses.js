// Phase 12 leaf: process registry + per-process output ring buffer for executor.js
// (verbatim moves). The `runningProcesses` map is the single shared instance every consumer
// (stop server, Processes dock, AI stopProcess tool, monitoring routes) reads — it must never
// be duplicated.

import { spawnSync } from 'child_process';
import { forgetDevUrl } from './devUrlStore.js';
import { state } from './state.js';
import { probeUrl } from './livenessProbe.js';
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
 * Windows: the tracked child is a cmd.exe shell wrapper (executor.js spawns with shell: true),
 * and TerminateProcess on the wrapper alone leaves the real process (python.exe, node, ...)
 * running as an orphan — confirmed live 2026-08-10: the console reported "Stopped" while the
 * Flask server kept serving on :5000 with its port still occupied and no way to stop it from
 * the console anymore. taskkill /f /t kills the wrapper AND its whole descendant tree, so it
 * MUST run synchronously: an async spawn raced the caller's SIGTERM, the wrapper died first,
 * and taskkill then reported "no running instance" (exit 128) without killing anything. POSIX
 * keeps plain SIGTERM on the child (no behavior change).
 */
function killProcessTree(child) {
  if (process.platform !== 'win32' || !child?.pid) return;
  try {
    spawnSync('taskkill', ['/f', '/t', '/pid', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows: command lines of processes still matching the given commands (whitespace-normalized,
 *  case-insensitive). Used AFTER a stop to catch survivors taskkill missed because the tracked
 *  child was the short-lived cmd wrapper while the real process runs on (the 2026-08-10 orphan
 *  scenario). Best-effort: any PowerShell failure returns []. */
function win32SurvivorsByCommandLine(commands) {
  if (process.platform !== 'win32' || commands.length === 0) return [];
  const targets = commands.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (targets.length === 0) return [];
  const quoted = targets.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
  const script =
    `$t = @(${quoted}); Get-CimInstance Win32_Process | ` +
    `Where-Object { if ($_.CommandLine) { $t -contains (($_.CommandLine -replace '\\s+',' ').Trim()) } } | ` +
    `ForEach-Object { $_.CommandLine }`;
  try {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 5000,
    });
    if (res.status !== 0 || !res.stdout) return [];
    return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Post-stop verification (requested live 2026-08-10: a user stopping a server must never be
 *  left believing the site is down while a process survived). Reports only — never re-kills:
 *  a same-command-line process may be the user's own manually started instance. Returns a
 *  warning string or null.
 */
async function verifyProcessStopped(procs, devUrl) {
  await sleep(500);
  const warnings = [];
  for (const proc of procs) {
    try {
      process.kill(proc.child.pid, 0);
      warnings.push(`process ${proc.child.pid} is still alive`);
    } catch {}
  }
  for (const cmdline of win32SurvivorsByCommandLine(procs.map((p) => p.command)).slice(0, 2)) {
    warnings.push(`a process still appears to be running \`${cmdline}\``);
  }
  if (devUrl) {
    try {
      // Skip probing when the URL is the console's own port — that would be ourselves.
      const port = new URL(devUrl).port || '80';
      if (Number(port) !== state.serverPort) {
        const probe = await probeUrl(devUrl, 1500);
        if (probe.alive) warnings.push(`the site at **${devUrl}** is still responding`);
      }
    } catch {}
  }
  return warnings.length > 0 ? warnings.join('; ') : null;
}

/**
 * Single kill path for every caller that stops a tracked process — the "stop server" trigger
 * phrase (connection.js), the `stop_process` WS message (dock stop button), and the AI-mode
 * `stopProcess` tool. Was previously copy-pasted three times; all three now route here so the
 * cleanup (kill + map delete + log delete + lastDevUrls delete + both broadcasts) can never
 * drift. Stops every tracked process for the project — "stop server" is one user intent, and
 * a single-slot-style "stop just one" would silently leave siblings running. Returns
 * { ok: false } when nothing is tracked for that project, plus an optional `warning` when
 * post-stop verification found survivors (process still alive / site still responding).
 *
 * `turnKey` (optional) restricts the stop to processes started by one AI turn — used by the
 * `cancel` WS message so cancelling an AI turn never tears down a dev server the user started
 * separately (audit 2026-08-17). With a turnKey, the project's dev URL and log buffer are only
 * cleared when the turn's stop emptied the slot (a sibling process may still own them).
 */
export async function stopTrackedProcess(projectId, { turnKey } = {}) {
  const slot = runningProcesses.get(projectId);
  const entries = slot ? [...slot.entries()] : [];
  const toStop = turnKey ? entries.filter(([, p]) => p.turnKey === turnKey) : entries;
  if (toStop.length === 0) return { ok: false };
  const commands = [];
  for (const [pid, proc] of toStop) {
    if (process.platform === 'win32') {
      // taskkill /f /t kills the wrapper itself — no SIGTERM needed, and sending one first
      // would orphan the tree from the kill (see killProcessTree's sync note).
      killProcessTree(proc.child);
    } else {
      try {
        proc.child.kill('SIGTERM');
      } catch {}
    }
    commands.push(proc.command);
    removeTrackedProcess(projectId, pid);
  }
  const slotNowEmpty = !runningProcesses.has(projectId);
  const devUrl = slotNowEmpty ? (state.lastDevUrls.get(projectId) || null) : null;
  if (slotNowEmpty) forgetDevUrl(projectId);
  broadcast({ type: 'dashboard_update' });
  broadcast({ type: 'processes_update' });
  const warning = await verifyProcessStopped(toStop.map(([, p]) => p), devUrl);
  return { ok: true, command: commands.join('` and `'), warning };
}

// Clean up on exit — kills tracked children before Node shuts down
process.on('exit', () => {
  for (const [, slot] of runningProcesses) {
    for (const [, proc] of slot) {
      if (process.platform === 'win32') killProcessTree(proc.child);
      else { try { proc.child.kill('SIGTERM'); } catch {} }
    }
  }
  runningProcesses.clear();
});
process.on('SIGTERM', () => {
  for (const [, slot] of runningProcesses) {
    for (const [, proc] of slot) {
      if (process.platform === 'win32') killProcessTree(proc.child);
      else { try { proc.child.kill('SIGTERM'); } catch {} }
    }
  }
  runningProcesses.clear();
});
