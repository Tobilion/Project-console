// Phase 12: orchestrator for command execution. Pure logic lives in the Phase 12 leaves:
//   - executorOutput.js       ANSI/URL/LF-CRLF transforms + createBufferedSender
//   - executorPorts.js        port-conflict detection, prompt ask, retry offer
//   - executorProcesses.js    runningProcesses map + ring buffer + stopTrackedProcess
//   - executorDevServer.js    dev-server pattern detection + detach message builder
//   - executorConstants.js    tuning knobs (data/tuning.json can override each at use time)
//   - executorUrlRecovery.js  post-detach candidate-port probe (servers that never print a URL)
//   - executorClose.js        the 'close' handler (cleanup + summary + retries + notifications)
// This file owns only the spawn lifecycle itself: venv rewrite, the tracked entry, the
// stream wiring, detach, and the close/error handlers.
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { broadcast } from './wsServer.js';
import { recordDevUrl, forgetDevUrl } from './devUrlStore.js';
import { state } from './state.js';
import { readProfile } from './routes/profileRoutes.js';
import { buildSandboxEnv } from './executorSandbox.js';
import {
  runningProcesses,
  processLogs,
  LineRingBuffer,
  MAX_LOG_LINES,
  getProcessLog,
  getTrackedProcesses,
  removeTrackedProcess,
  stopTrackedProcess,
} from './executorProcesses.js';
import { ANSI_RE, URL_PATTERN, collapseLfCrlfWarnings, createBufferedSender } from './executorOutput.js';
import { buildPortPromptConfirmation } from './executorPorts.js';
import { isDevServerCommand, buildDetachMessage } from './executorDevServer.js';
import { getTuning } from './tuningStore.js';
import { createCloseHandler } from './executorClose.js';
import { recoverDevUrlAfterDetach } from './executorUrlRecovery.js';
import {
  DEV_URL_DETACH_GRACE_MS,
  DEV_SERVER_FORCE_DETACH_MS,
  LONG_RUNNING_FORCE_DETACH_MS,
  PORT_PROMPT_ANSWER_TIMEOUT_MS,
} from './executorConstants.js';

// Re-exports so every external importer keeps using `../executor.js` unchanged:
// monitoringRoutes (runningProcesses, getProcessLog), toolProcess (runningProcesses,
// stopTrackedProcess), builtinFileNpm/builtinProjectContext/builtinLiveState/connectionConfirm/
// connectionDevServer/connectionRoutes (runningProcesses), connectionDevServer/connectionRoutes
// (stopTrackedProcess), connectionConfirm (PORT_PROMPT_ANSWER_TIMEOUT_MS), processLogs (no
// external importer today — kept for the Phase 6 harness). The remaining knobs stay importable
// from executorConstants.js (getTuning callers use the defaults here or the constants module).
export { runningProcesses, processLogs, getProcessLog, stopTrackedProcess, PORT_PROMPT_ANSWER_TIMEOUT_MS };

/** Rewrites `python ...` to the project's venv interpreter when a venv exists (verbatim rule). */
function rewriteVenvPython(command, cwd) {
  const isWindows = process.platform === 'win32';
  const venvPath = path.join(cwd, 'venv');
  if (!fs.existsSync(venvPath) || !command.startsWith('python ')) return command;
  const pythonExe = isWindows
    ? path.join('venv', 'Scripts', 'python.exe')
    : path.join('venv', 'bin', 'python');
  return command.replace('python ', `${pythonExe} `);
}

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
 *
 * Phase 3 (2026-08-10): `opts.sandboxed` flags a command that went through the
 * confirm gate as risky/always-confirm. When the user's profile has the opt-in
 * `sandboxRiskyCommands` setting on, such commands spawn with the restricted
 * environment from executorSandbox.js instead of inheriting the server's env.
 * With the setting off (the default), the flag changes nothing — byte-identical
 * to pre-Phase-3 behavior.
 */
export function executeCommand(command, cwd, ws, projectId, opts = {}) {
  const finalCommand = rewriteVenvPython(command, cwd);
  const isDev = isDevServerCommand(finalCommand);
  const sandboxed = !!opts.sandboxed && readProfile().sandboxRiskyCommands;
  // Optional turn ownership tag (set by AI-mode turns): lets `cancel` kill only the processes
  // THIS turn started, never a dev server the user started separately (audit 2026-08-17).
  const turnKey = opts?.turnKey || null;
  let detached = false;

  const sendEvent = (type, data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  };

  // runningProcesses is multi-slot (one entry per running command), and executeCommand is
  // reachable with no duplicate guard from npm_build/npm_install, the typed-command bypass and
  // every confirmed command. Overwriting a live entry used to orphan the previous process from
  // every cleanup path (the short build then deleted the entry on close, leaving a real dev
  // server untracked and unkillable; audit 2026-08-06, Phase 2). Each command now owns its own
  // slot and only deletes itself on close, so different commands can run concurrently (the
  // NetPulse config's serve + watch pair is designed to coexist). The one thing still refused
  // is a literal duplicate of a command that is already tracked — restarting a dev server is a
  // stop-then-start gesture, and two identical watch loops would both report the same thing.
  const existing = projectId
    ? getTrackedProcesses(projectId).find((p) => p.command === finalCommand)
    : null;
  if (existing?.child && existing.child.exitCode === null && existing.child.signalCode === null) {
    sendEvent('answer', `**[${projectId}]** already has \`${existing.command}\` running — say "stop server" first if you want to restart it.`);
    sendEvent('end', '');
    return Promise.resolve({ success: false, error: 'a process with the same command is already running for this project' });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;

    // The tracked entry doubles as the shared handle for the port-prompt flow: connectionConfirm
    // (which answers the stdin prompt) reads the timers/flag off this object to re-arm the
    // force-detach bound and allow a repeat prompt, since executor's closure isn't reachable
    // from there. `forceDetach` is the only closure-bound piece it needs.
    const trackedEntry = {
      child: null,
      command: finalCommand,
      startedAt: Date.now(),
      detachTimer: null,
      forceDetachTimer: null,
      portPromptAsked: false,
      turnKey,
    };
    trackedEntry.forceDetach = () => { if (!detached) detach(); };

    // Buffered relays for what actually gets shown to the user — see createBufferedSender above.
    // `stdout`/`stderr` (the raw accumulators above) still capture everything unbuffered for the
    // final `data.stdout`/`data.stderr` summary and for live URL detection below; only the
    // *live-streamed* copy shown in chat is batched/collapsed.
    const stdoutSender = createBufferedSender(sendEvent, 'output');
    const stderrSender = createBufferedSender(sendEvent, 'error_output', (text) => {
      const out = collapseLfCrlfWarnings(text);
      // The LF/CRLF collapse summary is a pure informational notice (the "(cosmetic, no action
      // needed)" marker) — reroute it through the `warning` channel so the frontend renders an
      // amber notice instead of a red error bubble. Only a summary standing completely alone
      // (single line, no real error text mixed into the same batch) is rerouted; mixed batches
      // keep the collapse but stay red so real errors are never downgraded.
      if (out && out.includes('(cosmetic, no action needed)') && !out.includes('\n')) {
        return { type: 'warning', text: out };
      }
      return out;
    });

    try {
      child = spawn(finalCommand, {
        cwd: cwd,
        // Sandboxed runs get the allowlisted env (executorSandbox.js); everything else
        // inherits the server's env exactly as before — undefined = inherit.
        env: sandboxed ? buildSandboxEnv(process.env, cwd) : undefined,
        shell: true,
        // POSIX: give the shell wrapper its own process group (detached) so a stop can
        // SIGTERM the whole tree via -pid, not just the wrapper — killing the wrapper alone
        // orphans the real server it spawned (the 2026-08-10 Windows orphan class, still live
        // on mac/Linux; see killProcessTree's note in executorProcesses.js). Windows keeps its
        // synchronous taskkill /t tree-kill and must not change process-creation semantics here.
        detached: process.platform !== 'win32',
        // stdin used to be 'ignore', which meant an interactive "port already in use, run on
        // another one instead? (Y/n)" prompt (react-scripts/CRA) had no way to ever be answered
        // — the process would just hang. 'pipe' costs nothing when nothing writes to it; only
        // used when the port-conflict prompt below is actually detected and the user approves.
        stdio: ['pipe', 'pipe', 'pipe'],
        // windowsHide: true prevents a flashing console window when the parent process has no
        // attached console (daemon mode, background start, npx launcher). Harmless on macOS/Linux.
        windowsHide: true
      });
    } catch (err) {
      sendEvent('error_output', `Failed to start process: ${err.message}`);
      sendEvent('end', `\nProcess failed.`);
      resolve({ success: false, error: err.message });
      return;
    }

    trackedEntry.child = child;
    // A child whose pipe breaks mid-write (exited between a writable check and the write)
    // emits 'error' on the stdin stream — attach a listener once at spawn so that error never
    // surfaces as an uncaughtException from the port-prompt reply path (audit 2026-08-06).
    if (child.stdin) child.stdin.on('error', () => {});
    // Same class of pipe-break errors on the output streams (audit 2026-08-17): the stdout
    // handler's writable-check + push window is exactly as racy as the stdin one, and an
    // unhandled stream 'error' is a process-level crash, not a message.
    if (child.stdout) child.stdout.on('error', () => {});
    if (child.stderr) child.stderr.on('error', () => {});

    sendEvent('start', `Executing: ${finalCommand}\n`);

    if (sandboxed) {
      // Visible proof the restricted context took effect — the spec's "prove it" requirement:
      // the env allowlist can be checked from any sandboxed run (e.g. `set` shows only the
      // allowlisted variables plus the CONSOLE_SANDBOXED marker).
      sendEvent('warning', 'Sandboxed execution active: environment allowlisted and cwd restricted to the project (see CLAUDE.md for exact guarantees — not a container).');
    }

    // Register so user can stop the server later. Each command gets its own slot keyed by its
    // own pid; the per-project log buffer is only created once (concurrent processes share the
    // interleaved tail rather than wiping each other's).
    if (projectId) {
      let slot = runningProcesses.get(projectId);
      if (!slot) {
        slot = new Map();
        runningProcesses.set(projectId, slot);
      }
      slot.set(child.pid, trackedEntry);
      if (!processLogs.has(projectId)) processLogs.set(projectId, new LineRingBuffer(MAX_LOG_LINES));
      broadcast({ type: 'dashboard_update' });
      broadcast({ type: 'processes_update' });
    }

    function detach() {
      if (detached) return;
      detached = true;
      if (trackedEntry.detachTimer) clearTimeout(trackedEntry.detachTimer);
      if (trackedEntry.forceDetachTimer) clearTimeout(trackedEntry.forceDetachTimer);
      // 2026-08-18: the stdout listener STAYS attached in URL-scan-only mode instead of being
      // removed — a slow cold start can print the "Local:" banner after the force-detach
      // deadline (Matchday Exchange's vite on a loaded machine), and removing the listener
      // dropped that banner forever (no recordDevUrl, no server_url event, no Live Sites row
      // or open-site chip). The data handler below still scans for URLs after detach; it just
      // stops streaming/buffering. stderr carries no URLs, so its listener is still dropped.
      child.stderr.removeAllListeners('data');
      // Flush any output that arrived just before detaching so it isn't silently dropped.
      stdoutSender.flush();
      stderrSender.flush();
      // Send end so the UI knows the "task is done" (the process keeps running in the background)
      const msg = buildDetachMessage(projectId, isDev);
      sendEvent('end', msg.text);
      resolve({
        success: true,
        data: { code: null, detached: true, devServer: msg.devServer, url: msg.url || null }
      });
      // Fallback for servers that never print a URL at all (or print it to a stream we can't
      // see): probe the project's candidate ports after a short delay and record the first
      // hit, so a live-but-quiet server still lands in the Live Sites tab and the chip.
      // Fire-and-forget, bounded, never blocks the turn (2026-08-18).
      if (isDev && projectId && !state.lastDevUrls.has(projectId)) {
        recoverDevUrlAfterDetach(projectId, ws);
      }
    }

    child.stdout.on('data', (data) => {
      const s = data.toString();
      // Only accumulate for the summary while streaming — a detached dev server could run for
      // hours and the listener stays attached for URL scanning, so `stdout` must stop growing.
      if (!detached) stdout += s;

      // 2026-08-18: after detach, keep scanning for URLs (a slow cold-start banner can arrive
      // late) but stop streaming/buffering — the process is background now.
      if (!detached) {
        stdoutSender.push(s);
        if (projectId) processLogs.get(projectId)?.push(s);
      }

      const clean = s.replace(ANSI_RE, '');
      const urls = clean.match(URL_PATTERN);
      if (urls) {
        const unique = [...new Set(urls.map(u => u.replace(/\/+$/, '')))];
        for (const url of unique) {
          sendEvent('server_url', url);
          if (projectId) {
            recordDevUrl(projectId, url);
            broadcast({ type: 'dashboard_update' });
            broadcast({ type: 'processes_update' });
          }
        }
        // If this is a dev server command, detach after URL + short grace to show it
        if (isDev && !detached) {
          trackedEntry.detachTimer = setTimeout(detach, getTuning('DEV_URL_DETACH_GRACE_MS', DEV_URL_DETACH_GRACE_MS));
        }
      }

      // Interactive "port already in use, run on another one instead? (Y/n)" prompt — ask the
      // user rather than guessing on their behalf, then relay their choice into the still-running
      // process's stdin once they respond (see connection.js's handleConfirmResponse pending.
      // stdinWrite branch). Cancel the force-detach timer while this is pending so the console
      // doesn't claim "Dev server is running" while it's actually just sitting at this prompt.
      // The bound is re-armed on answer (connectionConfirm re-arms it to PORT_PROMPT_ANSWER_
      // TIMEOUT_MS and resets portPromptAsked so a second conflict can prompt again) — without
      // that, an unanswered prompt left the command hung forever.
      if (isDev && !detached && !trackedEntry.portPromptAsked && projectId) {
        const asked = buildPortPromptConfirmation({
          ws, projectId, cleanInput: clean, triggerCommand: finalCommand,
        });
        if (asked) {
          trackedEntry.portPromptAsked = true;
          if (trackedEntry.forceDetachTimer) clearTimeout(trackedEntry.forceDetachTimer);
          trackedEntry.forceDetachTimer = setTimeout(trackedEntry.forceDetach, PORT_PROMPT_ANSWER_TIMEOUT_MS);
        }
      }
    });

    child.stderr.on('data', (data) => {
      if (detached) return;
      const s = data.toString();
      stderr += s;
      stderrSender.push(s);
      if (projectId) processLogs.get(projectId)?.push(s);
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
    trackedEntry.forceDetachTimer = setTimeout(() => {
      if (!detached) detach();
    }, isDev ? getTuning('DEV_SERVER_FORCE_DETACH_MS', DEV_SERVER_FORCE_DETACH_MS) : getTuning('LONG_RUNNING_FORCE_DETACH_MS', LONG_RUNNING_FORCE_DETACH_MS));

    child.on('close', createCloseHandler({
      trackedEntry,
      child,
      projectId,
      finalCommand,
      turnKey,
      isDev,
      ws,
      sendEvent,
      resolve,
      getDetached: () => detached,
      getStdout: () => stdout,
      getStderr: () => stderr,
      stdoutSender,
      stderrSender,
    }));

    child.on('error', (err) => {
      if (trackedEntry.detachTimer) clearTimeout(trackedEntry.detachTimer);
      if (trackedEntry.forceDetachTimer) clearTimeout(trackedEntry.forceDetachTimer);
      // Spawn may have failed before the entry was registered — removeTrackedProcess is a
      // no-op then, and there is nothing to broadcast.
      const removed = removeTrackedProcess(projectId, child.pid);
      if (removed) {
        if (!runningProcesses.has(projectId)) forgetDevUrl(projectId);
        broadcast({ type: 'dashboard_update' });
        broadcast({ type: 'processes_update' });
      }
      sendEvent('error_output', `Failed to start process: ${err.message}`);
      sendEvent('end', `\nProcess failed.`);
      resolve({ success: false, error: err.message });
    });
  });
}