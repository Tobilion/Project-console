// Phase 12: orchestrator for command execution. Pure logic lives in the Phase 12 leaves:
//   - executorOutput.js      ANSI/URL/LF-CRLF transforms + createBufferedSender
//   - executorPorts.js       port-conflict detection, prompt ask, retry offer
//   - executorProcesses.js   runningProcesses map + ring buffer + stopTrackedProcess
//   - executorDevServer.js   dev-server pattern detection + detach message builder
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { broadcast } from './wsServer.js';
import { recordDevUrl, forgetDevUrl } from './devUrlStore.js';
import { state } from './state.js';
import { probeUrl } from './livenessProbe.js';
import { summarizeCommandOutput } from './outputSummarizer.js';
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
import { buildPortPromptConfirmation, offerPortRetry } from './executorPorts.js';
import { isDevServerCommand, buildDetachMessage } from './executorDevServer.js';

// Re-exports so every external importer keeps using `../executor.js` unchanged:
// monitoringRoutes (runningProcesses, getProcessLog), toolProcess (runningProcesses,
// stopTrackedProcess), builtinFileNpm/builtinProjectContext/builtinLiveState/connectionConfirm/
// connectionDevServer/connectionRoutes (runningProcesses), connectionDevServer/connectionRoutes
// (stopTrackedProcess), processLogs (no external importer today — kept for the Phase 6 harness).
export { runningProcesses, processLogs, getProcessLog, stopTrackedProcess };

// Tunable knobs (Phase 4: magic numbers standardized).
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
 */
export function executeCommand(command, cwd, ws, projectId) {
  const finalCommand = rewriteVenvPython(command, cwd);
  const isDev = isDevServerCommand(finalCommand);
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
        shell: true,
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

    sendEvent('start', `Executing: ${finalCommand}\n`);

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
      // Stop listening to output
      child.stdout.removeAllListeners('data');
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
    }

    child.stdout.on('data', (data) => {
      const s = data.toString();
      stdout += s;

      if (detached) return;

      stdoutSender.push(s);
      if (projectId) processLogs.get(projectId)?.push(s);

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
        if (isDev) {
          trackedEntry.detachTimer = setTimeout(detach, DEV_URL_DETACH_GRACE_MS);
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
      if (isDev && !trackedEntry.portPromptAsked && projectId) {
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
    }, isDev ? DEV_SERVER_FORCE_DETACH_MS : LONG_RUNNING_FORCE_DETACH_MS);

    child.on('close', (code) => {
      // Clear BOTH timers — the URL-grace detach timer used to survive a natural exit or a
      // "stop server", firing after the close handler had already sent its end and emitting a
      // second, contradictory "still running in the background" end (audit 2026-08-06, Phase 2).
      if (trackedEntry.detachTimer) clearTimeout(trackedEntry.detachTimer);
      if (trackedEntry.forceDetachTimer) clearTimeout(trackedEntry.forceDetachTimer);
      // Confirmed live 2026-07-30 (Matchday Exchange transcript): "stop server" reported "No
      // running server" seconds after "what's the link?" confirmed the dev server was still
      // serving requests. Root cause — this used to delete the runningProcesses entry
      // unconditionally on 'close', including after detach() had already run. On at least some
      // Windows npm/vite invocations, the tracked `child` (the shell wrapper around `npm run
      // dev`) can fire its own 'close' well before the actual dev server process it spawned
      // stops serving, orphaning the real server from the handle we were tracking it under —
      // wiping the map entry at that point permanently breaks "stop server" for a process that's
      // still very much alive. Once detached, "stop server" (connection.js) is the only code
      // that should ever remove this entry.
      if (!detached) {
        // Delete only this command's own slot — sibling processes of the same project keep
        // their tracking, so a short build exiting next to a dev server can't orphan it.
        const removed = removeTrackedProcess(projectId, child.pid);
        if (removed) {
          broadcast({ type: 'dashboard_update' });
          broadcast({ type: 'processes_update' });
        }
        stdoutSender.flush();
        stderrSender.flush();
        // Requested explicitly (2026-07-29, in response to the LF/CRLF flood): don't just stream
        // the raw log and stop — always look at what the command actually produced and call out
        // the parts that matter (errors, package counts, commit/push results). Heuristic/regex-
        // based (see outputSummarizer.js), not an LLM call. Returns null for short/uninteresting
        // output — nothing extra is sent in that case.
        const summary = summarizeCommandOutput({ command: finalCommand, stdout, stderr, exitCode: code });
        if (summary) sendEvent('answer', summary);

        // Hard port-conflict failure — the process crashed outright instead of prompting or
        // auto-retrying (e.g. a plain Node/Express server with no built-in port fallback). Offer a
        // one-click retry on the next port through the normal confirm-before-run flow, same as any
        // other command — this never runs anything without the user approving it.
        offerPortRetry({ ws, projectId, command: finalCommand, stdout, stderr, isDev, exitCode: code });

        sendEvent('end', `\nProcess exited with code ${code}`);
        resolve({
          success: code === 0,
          data: {
            code,
            stdout: stdout.length > STDOUT_SUMMARY_CAP ? `...${stdout.slice(-STDOUT_SUMMARY_CAP)}` : stdout,
            stderr: stderr.length > STDERR_SUMMARY_CAP ? `...${stderr.slice(-STDERR_SUMMARY_CAP)}` : stderr
          }
        });
        return;
      }

      // Detached process exited on its own (crashed, or killed outside the console). The tracked
      // child can also close early while the real server keeps serving (Windows npm wrapper
      // above), so don't clean up immediately — probe the last-known dev URL after a short delay
      // and only drop the entry when nothing answers. Previously the entry (and its recorded URL)
      // lived on forever, reporting a phantom "running" server with a dead PID (audit 2026-08-06).
      if (!projectId) return;
      const lastUrl = state.lastDevUrls.get(projectId);
      if (!lastUrl) return; // never had a URL — nothing to probe; keep the entry conservatively
      setTimeout(async () => {
        const probe = await probeUrl(lastUrl, DETACHED_EXIT_PROBE_TIMEOUT_MS);
        if (probe.alive) return; // real server still serving (wrapper-close-early case)
        const removed = removeTrackedProcess(projectId, child.pid);
        if (removed) {
          // The recorded URL can belong to a sibling process still running (serve + watch) —
          // only forget it when this project no longer has anything tracked.
          if (!runningProcesses.has(projectId)) forgetDevUrl(projectId);
          broadcast({ type: 'dashboard_update' });
          broadcast({ type: 'processes_update' });
          console.log(`[Executor] Detached process for ${projectId} exited and its server is down — tracked entry cleaned up.`);
        }
      }, DETACHED_EXIT_PROBE_DELAY_MS);
    });

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
