import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { state, withPortCollisionWarning, pendingConfirmations } from './state.js';
import { summarizeCommandOutput } from './outputSummarizer.js';

// Strips ANSI escape sequences so URL detection isn't fooled by color/bold codes
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

// Matches URLs like http://localhost:3000, http://127.0.0.1:5173/, etc.
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]):\d{2,5}\/?/gi;

// Patterns that indicate a long-running dev server — we auto-detach after URL / timeout
const DEV_SERVER_PATTERNS = [
  /npx serve/i,
  /python -m http\.server/i,
  /npm run (dev|start|serve)/i,
  /vite/i,
  /tsx (dev|serve)/i,
  /next dev/i,
  /astro dev/i,
  /node (server|app|index|main)\./i,
];

function isDevServerCommand(command) {
  return DEV_SERVER_PATTERNS.some(p => p.test(command));
}

// --- Port-in-use handling (requested directly, 2026-07-29) ---
// Dev servers hit an already-occupied port in two different shapes, and neither used to be
// handled: (1) tools like Create React App's `react-scripts start` print an interactive
// "Would you like to run the app on another port instead? (Y/n)" prompt and then just wait —
// since stdin was previously `'ignore'`, the process would hang forever with no way to answer
// it; (2) tools with no auto-retry (custom Node/Express servers, some configs) just crash with
// EADDRINUSE and exit. Vite's own default behavior (auto-increment + report the real port) needs
// no special handling — the existing URL detection above already captures whatever port it
// actually lands on.

// CRA/react-scripts' prompt text, matched loosely (port number can appear a little before the
// "(Y/n)" marker, with framing text in between).
const PORT_PROMPT_RE = /port\s+(\d{2,5})[\s\S]{0,300}\(Y\/n\)/i;

const PORT_IN_USE_HARD_RE = /EADDRINUSE|address already in use/i;

/** Best-effort port extraction from whichever line actually mentions the conflict. */
function extractBusyPort(text) {
  const line = text.split('\n').find((l) => PORT_IN_USE_HARD_RE.test(l));
  if (!line) return null;
  const m = line.match(/:(\d{2,5})\b/) || line.match(/port\s+(\d{2,5})/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Builds a best-effort retry command on the next port up. If the original command already has
 * an explicit `--port` flag (Vite's style — matches this project's own confirmed-live case),
 * increment that. Otherwise fall back to setting the PORT env var, which covers CRA and any
 * Node http server that reads `process.env.PORT` (including this console's own server — see
 * index.js) — cross-platform, matching the same process.platform branching convention already
 * used in commandGuesser.js.
 */
function buildPortRetryCommand(command, busyPort) {
  const nextPort = busyPort + 1;
  if (/--port[= ]\d+/i.test(command)) {
    return command.replace(/--port[= ]\d+/i, `--port=${nextPort}`);
  }
  const isWindows = process.platform === 'win32';
  return isWindows ? `set PORT=${nextPort}&& ${command}` : `PORT=${nextPort} ${command}`;
}

// Git prints one of these per file, the first time each file is committed under whatever
// core.autocrlf setting is active — purely informational, not an error, and not something the
// user can or needs to act on. Confirmed live 2026-07-29: committing ~160 new files in one go
// (see git_add_A style bulk commits from trigger mode) produced 159 of these on stderr, each
// forwarded as a separate chat bubble (see the buffering fix below) — collapsed here into one
// summary line instead of spamming the chat with a warning per file.
const LF_CRLF_WARNING_RE = /^warning: in the working copy of '([^']+)', LF will be replaced by CRLF the next time Git touches it\.?$/;

/** Collapse repeated per-file LF/CRLF warnings in a stderr chunk into a single summary line,
 * leaving any other stderr content (real errors, other warnings) untouched. */
function collapseLfCrlfWarnings(text) {
  const lines = text.split('\n');
  const affectedFiles = [];
  const kept = [];
  for (const line of lines) {
    const m = line.match(LF_CRLF_WARNING_RE);
    if (m) affectedFiles.push(m[1]);
    else kept.push(line);
  }
  if (affectedFiles.length === 0) return text;
  const summary = affectedFiles.length <= 3
    ? `warning: line endings will be normalized (LF -> CRLF) for: ${affectedFiles.join(', ')} (cosmetic, no action needed)`
    : `warning: line endings will be normalized (LF -> CRLF) for ${affectedFiles.length} files (cosmetic, no action needed)`;
  const rest = kept.join('\n').trim();
  return rest ? `${rest}\n${summary}` : summary;
}

// How long to coalesce rapid bursts of stdout/stderr `data` events before forwarding them to the
// client as one message. Without this, a command that writes many small chunks in quick
// succession (git printing one warning line per file is the confirmed-live case) turns into one
// chat bubble per chunk — this batches them into far fewer, larger messages instead. Kept short
// enough that normal command output still feels live.
const OUTPUT_FLUSH_MS = 150;

/**
 * Wraps a `sendEvent(type, text)` call with a small buffering window so rapid bursts of output
 * become one flushed message instead of one message per OS-level `data` event. `transform` (if
 * given) runs once on the buffered text right before it's sent — used here to collapse repeated
 * LF/CRLF warnings — so it only has to look at a handful of flushed batches, not every raw chunk.
 */
function createBufferedSender(sendEvent, type, transform) {
  let buffer = '';
  let timer = null;
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer) return;
    const out = transform ? transform(buffer) : buffer;
    if (out) sendEvent(type, out);
    buffer = '';
  }
  return {
    push(chunk) {
      buffer += chunk;
      if (!timer) timer = setTimeout(flush, OUTPUT_FLUSH_MS);
    },
    flush,
  };
}

// Track running processes so they can be killed by the user
// (Cleared on module load to handle HMR — stale children from previous module scope
//  are orphaned; we start fresh each time the module re-executes.)
export const runningProcesses = new Map(); // projectId -> { child, command }

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

/**
 * Spawns a shell command.
 *
 * For dev-server commands (long-running processes like `npx serve .` or
 * `python -m http.server`), output streams until a URL is detected or a
 * timeout elapses, then we detach: an `end` event is sent so the UI knows
 * the "task is complete", and subsequent process output is silently ignored.
 * The process reference is kept in `runningProcesses` so the user can stop
 * it later via WebSocket.
 *
 * For short-lived commands, behavior is unchanged: all output streams until
 * the process exits naturally.
 */
export function executeCommand(command, cwd, ws, projectId) {
  let finalCommand = command;

  const isWindows = process.platform === 'win32';
  const venvPath = path.join(cwd, 'venv');

  if (fs.existsSync(venvPath)) {
    const pythonExe = isWindows
      ? path.join('venv', 'Scripts', 'python.exe')
      : path.join('venv', 'bin', 'python');
    if (command.startsWith('python ')) {
      finalCommand = command.replace('python ', `${pythonExe} `);
    }
  }

  const isDev = isDevServerCommand(finalCommand);
  let detached = false;

  const sendEvent = (type, data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    let detachTimer = null;
    let forceDetachTimer = null;
    let portPromptAsked = false;

    // Buffered relays for what actually gets shown to the user — see createBufferedSender above.
    // `stdout`/`stderr` (the raw accumulators above) still capture everything unbuffered for the
    // final `data.stdout`/`data.stderr` summary and for live URL detection below; only the
    // *live-streamed* copy shown in chat is batched/collapsed.
    const stdoutSender = createBufferedSender(sendEvent, 'output');
    const stderrSender = createBufferedSender(sendEvent, 'error_output', collapseLfCrlfWarnings);

    try {
      child = spawn(finalCommand, {
        cwd: cwd,
        shell: true,
        // stdin used to be 'ignore', which meant an interactive "port already in use, run on
        // another one instead? (Y/n)" prompt (react-scripts/CRA) had no way to ever be answered
        // — the process would just hang. 'pipe' costs nothing when nothing writes to it; only
        // used when the port-conflict prompt below is actually detected and the user approves.
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      sendEvent('error_output', `Failed to start process: ${err.message}`);
      sendEvent('end', `\nProcess failed.`);
      resolve({ success: false, error: err.message });
      return;
    }

    sendEvent('start', `Executing: ${finalCommand}\n`);

    // Register so user can stop the server later
    if (projectId) {
      runningProcesses.set(projectId, { child, command: finalCommand });
    }

    function detach() {
      if (detached) return;
      detached = true;
      if (detachTimer) clearTimeout(detachTimer);
      // Stop listening to output
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      // Flush any output that arrived just before detaching so it isn't silently dropped.
      stdoutSender.flush();
      stderrSender.flush();
      // Send end so the UI knows the "task is done" (the process keeps running in the background)
      const detachedUrl = state.lastDevUrls.get(projectId);
      // Now also fires for unrecognized-but-still-running commands (see the force-detach comment
      // above), not just confirmed dev servers — "Dev server" phrasing would be misleading for
      // something like a watch loop with no URL at all, so only use it when there's actually a
      // detected URL or the command matched a known dev-server pattern.
      const label = (isDev || detachedUrl) ? 'Dev server' : 'This command';
      const detachMsg = withPortCollisionWarning(
        `\n${label} is still running${detachedUrl ? ` at ${detachedUrl}` : ' in the background'} — you can keep chatting. Use "stop server" to shut it down.\n`,
        detachedUrl
      );
      sendEvent('end', detachMsg);
      resolve({
        success: true,
        data: { code: null, detached: true, devServer: isDev || !!detachedUrl, url: state.lastDevUrls.get(projectId) || null }
      });
    }

    child.stdout.on('data', (data) => {
      const s = data.toString();
      stdout += s;

      if (detached) return;

      stdoutSender.push(s);

      const clean = s.replace(ANSI_RE, '');
      const urls = clean.match(URL_PATTERN);
      if (urls) {
        const unique = [...new Set(urls.map(u => u.replace(/\/+$/, '')))];
        for (const url of unique) {
          sendEvent('server_url', url);
          if (projectId) state.lastDevUrls.set(projectId, url);
        }
        // If this is a dev server command, detach after URL + short grace to show it
        if (isDev) {
          detachTimer = setTimeout(detach, 500);
        }
      }

      // Interactive "port already in use, run on another one instead? (Y/n)" prompt — ask the
      // user rather than guessing on their behalf, then relay their choice into the still-running
      // process's stdin once they respond (see connection.js's handleConfirmResponse pending.
      // stdinWrite branch). Cancel the force-detach timer while this is pending so the console
      // doesn't claim "Dev server is running" while it's actually just sitting at this prompt.
      if (isDev && !portPromptAsked && projectId) {
        const promptMatch = clean.match(PORT_PROMPT_RE);
        if (promptMatch) {
          portPromptAsked = true;
          if (forceDetachTimer) clearTimeout(forceDetachTimer);
          const busyPort = parseInt(promptMatch[1], 10);
          const token = crypto.randomUUID();
          pendingConfirmations.set(token, {
            projectId,
            stdinWrite: { yes: 'Y\n', no: 'n\n' },
            command: `Respond to dev server port prompt (port ${busyPort} busy)`,
            trigger: finalCommand,
            createdAt: Date.now(),
          });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'confirm_prompt',
              token,
              command: `Port ${busyPort} is already in use. Run this dev server on the next available port instead?`,
              trigger: 'port_conflict',
            }));
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      if (detached) return;
      const s = data.toString();
      stderr += s;
      stderrSender.push(s);
    });

    // For dev server commands, force-detach after 10s even without URL. Kept in a variable now
    // so the port-conflict-prompt handler above can cancel it — otherwise a still-pending "run
    // on another port?" question could get papered over by a premature "Dev server is running".
    //
    // Confirmed live 2026-07-29: this used to be gated on `isDev` only — but `DEV_SERVER_PATTERNS`
    // can't enumerate every project's own server-launching syntax (NetPulse's `main.py serve` /
    // `main.py watch --interval N` don't match any recognized npm/vite/etc. shape), so a command
    // that never matches ends up with NO force-detach at all. Real symptom: an AI-mode NetPulse
    // dashboard run streamed Flask's live access-log lines into the chat forever — including into
    // completely unrelated later messages — because the underlying process never detached even
    // though `aiQuery.js`'s own 6s tool-loop timeout had already moved on without it. Now applies
    // to EVERY command, not just recognized dev servers, just with a longer grace period for the
    // unrecognized case (some one-shot scripts legitimately take a while) — a slow one-shot script
    // getting labeled "running in background" a little early is a much smaller problem than a
    // process streaming into the chat indefinitely.
    forceDetachTimer = setTimeout(() => {
      if (!detached) detach();
    }, isDev ? 10000 : 20000);

    child.on('close', (code) => {
      // Confirmed live 2026-07-30 (Matchday Exchange transcript): "stop server" reported "No
      // running server" seconds after "what's the link?" confirmed the dev server was still
      // serving requests. Root cause — this used to delete the runningProcesses entry
      // unconditionally on 'close', including after detach() had already run. On at least some
      // Windows npm/vite invocations, the tracked `child` (the shell wrapper around `npm run
      // dev`) can fire its own 'close' well before the actual dev server process it spawned
      // stops serving, orphaning the real server from the handle we were tracking it under —
      // wiping the map entry at that point permanently breaks "stop server" for a process that's
      // still very much alive, even though `state.lastDevUrls` (a separate cache) correctly still
      // shows it running. Once detached, "stop server" (connection.js) is the only code that
      // should ever remove this entry — it kills the child and deletes the entry itself
      // synchronously, so skipping the delete here for an already-detached entry doesn't leak: at
      // worst, a genuinely-dead detached process leaves a stale entry until the next explicit
      // "stop server" call, which is a harmless no-op kill instead of a false "nothing running".
      if (!detached) runningProcesses.delete(projectId);
      if (detached) return;
      stdoutSender.flush();
      stderrSender.flush();
      // Requested explicitly (2026-07-29, in response to the LF/CRLF flood above): don't just
      // stream the raw log and stop — always look at what the command actually produced and call
      // out the parts that matter (errors, package counts, commit/push results) so the user isn't
      // stuck reading a long dump themselves. Heuristic/regex-based (see outputSummarizer.js),
      // not an LLM call, so this works the same whether Ollama is running or not. Returns null
      // for short/uninteresting output — nothing extra is sent in that case.
      const summary = summarizeCommandOutput({ command: finalCommand, stdout, stderr, exitCode: code });
      if (summary) sendEvent('answer', summary);

      // Hard port-conflict failure — the process crashed outright instead of prompting or
      // auto-retrying (e.g. a plain Node/Express server with no built-in port fallback). Offer a
      // one-click retry on the next port through the normal confirm-before-run flow, same as any
      // other command — this never runs anything without the user approving it.
      if (code !== 0 && isDev && projectId) {
        const busyPort = extractBusyPort(`${stdout}\n${stderr}`);
        if (busyPort) {
          const retryCommand = buildPortRetryCommand(finalCommand, busyPort);
          const token = crypto.randomUUID();
          pendingConfirmations.set(token, {
            projectId,
            command: retryCommand,
            trigger: finalCommand,
            createdAt: Date.now(),
          });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'confirm_prompt',
              token,
              command: `${retryCommand}  (port ${busyPort} was already in use — retry on the next port)`,
              trigger: 'port_conflict_retry',
            }));
          }
        }
      }

      sendEvent('end', `\nProcess exited with code ${code}`);
      resolve({
        success: code === 0,
        data: {
          code,
          stdout: stdout.length > 4000 ? `...${stdout.slice(-4000)}` : stdout,
          stderr: stderr.length > 2000 ? `...${stderr.slice(-2000)}` : stderr
        }
      });
    });

    child.on('error', (err) => {
      runningProcesses.delete(projectId);
      sendEvent('error_output', `Failed to start process: ${err.message}`);
      sendEvent('end', `\nProcess failed.`);
      resolve({ success: false, error: err.message });
    });
  });
}
