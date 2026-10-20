// Live WebSocket chat probe (2026-10-20).
//
// The continuous matcher harness only exercises the MATCHER: it proves which intent a
// phrase would select, but not whether the chat actually answers, whether the turn ever
// terminates, or how long it takes. Its `--live` flag was parsed and never used.
//
// This module drives the real WS protocol against a running console — the same messages
// the CLI and the web client send — and reports, per turn: the answer text, whether the
// turn TERMINATED (an `end` message, or an answer followed by a quiet window), any error
// output, and the wall-clock latency.
//
// Protocol notes (mirrors server/cli-client.js):
//   - `client_info` announces the client so server-side answers can phrase themselves for
//     a terminal.
//   - `execute` carries { projectId, input, sessionId }. A null sessionId lets the server
//     create and track the session.
//   - A read-only turn ends with `end`; a pure answer turn may not send one, so a quiet
//     window after the answer is treated as the end of the turn (the same rule the CLI's
//     --query mode uses).

import WebSocket from 'ws';

const DEFAULT_PORT = 3000;
const QUIET_WINDOW_MS = 1500;
const TURN_TIMEOUT_MS = 30000;

function projectIdFromArg(arg) {
  if (!arg) return null;
  const target = String(arg).toLowerCase();
  const match = (project) => project.id?.toLowerCase() === target
    || project.name?.toLowerCase() === target
    || project.folderName?.toLowerCase() === target;
  return match;
}

/** Fetches the console's project list; returns [] when the console is unreachable. */
export async function fetchProjects(port, host = '127.0.0.1') {
  try {
    const res = await fetch(`http://${host}:${port}/api/projects`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.projects) ? data.projects : [];
  } catch {
    return [];
  }
}

/**
 * Sends every input through the real chat pipeline and reports what came back.
 *
 * inputs: [{ input: string, expected?: string|null }]
 * Returns { turns, terminated, unanswered, errored, avgMs, p95Ms, results }.
 */
export async function runLiveChatProbe({ inputs, port = DEFAULT_PORT, host = '127.0.0.1', projectId, onProgress }) {
  const projects = await fetchProjects(port, host);
  if (projects.length === 0) {
    throw new Error(`No console answered on port ${port}. Start one (npm run dev) before running the live probe.`);
  }
  const target = projectId ? projects.find(projectIdFromArg(projectId)) : projects[0];
  if (!target) {
    throw new Error(`No project matches "${projectId}". Available: ${projects.map((p) => p.name).join(', ')}`);
  }

  const results = [];
  let terminated = 0;
  let unanswered = 0;
  let errored = 0;
  const latencies = [];

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}/stream`);
    let queue = inputs.slice();
    let current = null;
    let quietTimer = null;
    let turnTimer = null;

    const cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (turnTimer) clearTimeout(turnTimer);
    };

    const finishTurn = (outcome) => {
      if (!current) return;
      cleanup();
      const record = { ...current, outcome, ms: Date.now() - current.startedAt };
      results.push(record);
      latencies.push(record.ms);
      if (outcome === 'error') errored++;
      else if (outcome === 'no-response') unanswered++;
      else terminated++;
      current = null;
      if (onProgress) onProgress(record, results.length, inputs.length);
      sendNext();
    };

    const sendNext = () => {
      if (!queue.length) {
        cleanup();
        try { ws.close(); } catch { /* already closing */ }
        resolve();
        return;
      }
      const next = queue.shift();
      current = { input: next.input, expected: next.expected ?? null, answer: '', error: '', ms: 0, startedAt: Date.now() };
      try {
        ws.send(JSON.stringify({ type: 'execute', payload: { projectId: target.id, input: next.input, sessionId: null } }));
      } catch (err) {
        current.error = err.message;
        finishTurn('error');
        return;
      }
      turnTimer = setTimeout(() => finishTurn('no-response'), TURN_TIMEOUT_MS);
    };

    ws.on('open', () => {
      try { ws.send(JSON.stringify({ type: 'client_info', payload: { client: 'cli' } })); } catch { /* best-effort */ }
      sendNext();
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!current) return;
      if (msg.type === 'answer') {
        current.answer += msg.data ? String(msg.data) : '';
        // An answer may be followed by more output; the quiet window decides when the turn
        // is over, unless an explicit `end` arrives first. The callback captures `current`
        // at fire time, so it must read the record that is still in flight.
        const record = current;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finishTurn(record.error ? 'error' : 'answered'), QUIET_WINDOW_MS);
      } else if (msg.type === 'error_output') {
        current.error += msg.data ? String(msg.data) : '';
      } else if (msg.type === 'end') {
        finishTurn(current.error ? 'error' : 'answered');
      }
    });
    ws.on('error', (err) => {
      cleanup();
      reject(err);
    });
    ws.on('close', () => {
      if (current) finishTurn('no-response');
      else resolve();
    });
  });

  latencies.sort((a, b) => a - b);
  const avgMs = latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;
  const p95Ms = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;

  return { turns: results.length, terminated, unanswered, errored, avgMs, p95Ms, results };
}

/** Human-readable summary for the harness output. */
export function formatLiveReport(report, limit = 15) {
  const lines = [];
  lines.push(`live turns: ${report.turns}  answered: ${report.terminated}  no-response: ${report.unanswered}  errors: ${report.errored}  avg: ${report.avgMs}ms  p95: ${report.p95Ms}ms`);
  const problems = report.results.filter((r) => r.outcome !== 'answered' || r.error);
  if (problems.length) {
    lines.push(`\nPROBLEM TURNS (${problems.length}):`);
    for (const r of problems.slice(0, limit)) {
      lines.push(`  '${r.input}' -> ${r.outcome}${r.error ? ` :: ${r.error.trim().slice(0, 160)}` : ''}`);
    }
  }
  const empties = report.results.filter((r) => r.outcome === 'answered' && !r.answer.trim());
  if (empties.length) {
    lines.push(`\nEMPTY ANSWERS (${empties.length}):`);
    for (const r of empties.slice(0, limit)) lines.push(`  '${r.input}'`);
  }
  return lines.join('\n');
}
