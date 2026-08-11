import { exec } from 'child_process';
import path from 'path';
import { semanticMatcher } from '../semanticMatcher.js';
import { getOllamaHost } from '../ollama.js';
import { runningProcesses } from '../executor.js';

// Phase 8 (2026-08-11): `health check` / `is my console healthy` — a single read-only status
// snapshot of the console's own runtime, not of any project. Pre-matcher admin tier (wired in
// connectionExecute.js next to telemetry/distillation): never touches the matching pipeline,
// never confirms, never mutates anything. Best-effort per check — a failure reports the fact,
// it never throws to the caller.
//
// Checks:
//  1. Ollama daemon reachability (same host the chat path uses).
//  2. Embedding model state (semanticMatcher.ready / initError).
//  3. Free disk space for data/ — this app's own storage home (best-effort on Windows via
//     Get-PSDrive; unknown report when the probe itself fails).
//  4. Zombie tracked processes: entries whose tracked child PID is no longer alive. Best-effort
//     on Windows, where PID liveness is a process.kill(pid, 0) probe and PIDs can be reused —
//     the honest wording reflects that.
const OLLAMA_PROBE_TIMEOUT_MS = 2000;
const DISK_PROBE_TIMEOUT_MS = 3000;
const MAX_ZOMBIES_LISTED = 10;

function checkPhrases(input) {
  const i = input.toLowerCase();
  return (
    i === 'health check' || i === 'health' || i === 'is my console healthy' ||
    i === 'console health' || i === 'how healthy is my console' || i === 'system health'
  );
}

async function probeOllama() {
  try {
    const res = await fetch(`${getOllamaHost()}/api/version`, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return `unreachable (HTTP ${res.status})`;
    const body = await res.json().catch(() => null);
    return `reachable${body?.version ? ` — version ${body.version}` : ''}`;
  } catch {
    return 'unreachable';
  }
}

async function probeDiskSpace() {
  const root = path.parse(path.resolve('data')).root; // e.g. "C:\"
  return new Promise((resolve) => {
    // Get-PSDrive's Free is bytes; format to the same unit the rest of the reply uses.
    exec(
      `powershell -NoProfile -Command "(Get-PSDrive -Name '${root[0]}' | Select-Object -ExpandProperty Free) / 1GB"`,
      { timeout: DISK_PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err || !stdout) return resolve(`unknown (probe failed on ${root[0]}:)`);
        const gb = parseFloat(stdout.trim());
        return resolve(Number.isFinite(gb) ? `${gb.toFixed(1)} GB free on ${root[0]}:` : 'unknown');
      },
    );
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists but owned elsewhere
  }
}

function findZombies() {
  const zombies = [];
  for (const [projectId, slot] of runningProcesses) {
    for (const proc of slot.values()) {
      const pid = proc.child?.pid ?? null;
      if (!pid || !isPidAlive(pid)) {
        zombies.push({ projectId, pid, label: proc.command?.slice(0, 60) || 'unknown command' });
      }
    }
  }
  return zombies;
}

export async function handleHealthCheck(ws, lowerInput) {
  if (!checkPhrases(lowerInput)) return false;

  const [ollamaStatus, diskStatus] = await Promise.all([probeOllama(), probeDiskSpace()]);
  const zombies = findZombies();

  let embeddings;
  if (semanticMatcher.ready) embeddings = 'loaded';
  else if (semanticMatcher.initError) embeddings = `failed — ${String(semanticMatcher.initError.message || semanticMatcher.initError).slice(0, 120)}`;
  else embeddings = 'not initialized yet';

  let reply = `**Console health**\n\n`;
  reply += `- Ollama: ${ollamaStatus}\n`;
  reply += `- Embedding model: ${embeddings}\n`;
  reply += `- Disk (data/): ${diskStatus}\n`;
  reply += `- Tracked processes: ${[...runningProcesses.values()].reduce((s, m) => s + m.size, 0)}`;
  if (zombies.length > 0) {
    const shown = zombies.slice(0, MAX_ZOMBIES_LISTED);
    reply += ` — **${zombies.length} zombie(s)** (tracked but the child PID is gone):\n`;
    reply += shown.map((z) => `  - \`${z.label}\` (pid ${z.pid ?? 'none'}, ${z.projectId})`).join('\n');
    if (zombies.length > shown.length) reply += `\n  - …and ${zombies.length - shown.length} more`;
    reply += `\n\nKill them with \`stop the server\` / the dock's stop button, or ignore them — a zombie entry only affects the dashboard's process list.`;
  } else {
    reply += ' — none\n';
  }
  reply += `\n(PID liveness is best-effort on Windows — PIDs can be recycled, so treat the zombie list as a hint, not a verdict.)`;

  ws.send(JSON.stringify({ type: 'answer', data: reply }));
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}