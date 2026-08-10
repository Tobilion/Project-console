import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { isWindows } from './platformCommand.js';

/**
 * Background, non-blocking TypeScript type-check verification (Phase 1, Part 1.4). Whenever the
 * AI (or a direct frontend tool call) writes/edits a file in a project that has a tsconfig.json,
 * scheduleVerification() is fired-and-forgotten from the tool loop — it never blocks `runToolCall`
 * or the next model turn. The check runs `npx tsc --noEmit` in the project root with a 60s cap;
 * its result is summarized to server stdout (visible in the `npm run dev` / start.bat terminal).
 *
 * Design constraints (from CLAUDE.md known-gotchas):
 *  - Per-project debounce + single-flight gate: concurrent edits on the same project collapse to
 *    one check, and a check never overlaps itself.
 *  - Spawn must be windowsHide (avoids a cmd flash per command) and must use the .cmd wrapper on
 *    Windows (`npx` alone fails with ENOENT via spawn without a shell).
 *  - Never throws to the caller.
 */
export const DEBOUNCE_MS = 2000;
export const HARNESS_TIMEOUT_MS = 60000;
export const MAX_OUTPUT_LINES = 12;

const TSC_BIN = isWindows ? 'npx.cmd' : 'npx';

/** Per-root tracker: { timer, running } so edits collapse and don't overlap. */
const state = new Map();

/** True if `root` contains a tsconfig.json — only TS projects get the typecheck pass. */
export async function hasTypeScriptProject(root) {
  if (!root) return false;
  try {
    const st = await fs.stat(path.join(root, 'tsconfig.json'));
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Debounced, single-flight, non-blocking per-project type check. Returns immediately. The actual
 * `npx tsc --noEmit` runs in the background and logs its summary via `log` (defaults to console.log).
 */
export function scheduleVerification(root, log) {
  if (!root) return;
  const logger = typeof log === 'function' ? log : console.log;
  let s = state.get(root);
  if (!s) {
    s = { timer: null, running: false };
    state.set(root, s);
  }
  if (s.running) return; // a check is already in flight — coalesce
  if (s.timer) return; // a debounced check is waiting — let it fire

  s.timer = setTimeout(() => {
    s.timer = null;
    s.running = true;
    void hasTypeScriptProject(root).then((isTs) => {
      if (!isTs) {
        s.running = false;
        return;
      }
      runTypeScriptCheck(root, logger).catch(() => {
        s.running = false;
      }).finally(() => {
        s.running = false;
      });
    });
  }, DEBOUNCE_MS);
}

/** Cancels a pending debounce and clears the running flag (used by tests/shutdown). */
export function cancelVerification(root) {
  const s = state.get(root);
  if (s) {
    if (s.timer) clearTimeout(s.timer);
    state.delete(root);
  }
}

/** Runs `npx tsc --noEmit` in `root` with the 60s cap; never throws. */
async function runTypeScriptCheck(root, log) {
  const child = spawn(TSC_BIN, ['tsc', '--noEmit'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, HARNESS_TIMEOUT_MS);
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let code;
  try {
    code = await new Promise((resolve) => {
      child.on('error', () => resolve(null)); // e.g. npx not installed — treat as non-fatal
      child.on('close', (c) => resolve(c));
    });
  } finally {
    clearTimeout(timeout);
  }
  const parsed = parseTscResult(code ?? (timedOut ? -1 : code), stdout, stderr);
  const rel = path.relative(process.cwd(), root) || root;
  if (parsed.errors === 0) {
    log(`[verify] ${rel}: type check passed (0 errors).`);
  } else {
    log(`[verify] ${rel}: ${parsed.errors} error(s); last output:\n${parsed.lines.join('\n')}`);
  }
  return parsed;
}

/**
 * Parses `tsc` output. Returns { exitCode, errors, lines }. Pure + synchronous — tested directly.
 * tsc prints a trailing "N error(s)" summary line on stdout; if it's missing, fall back to
 * counting `error TS####:` per-error lines, since not every tsc version emits the summary.
 */
export function parseTscResult(exitCode, stdout, stderr) {
  const combined = `${stdout || ''}${stderr || ''}`;
  const errors = countTscErrors(combined);
  return {
    exitCode: typeof exitCode === 'number' ? exitCode : -1,
    errors,
    lines: tailLines(combined, MAX_OUTPUT_LINES),
  };
}

function countTscErrors(text) {
  const summary = text.match(/(\d+)\s+error[s]?\s*\(?/i);
  if (summary) return parseInt(summary[1], 10);
  return (text.match(/\berror TS\d+:/g) || []).length;
}

function tailLines(text, n) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.slice(Math.max(0, lines.length - n));
}
