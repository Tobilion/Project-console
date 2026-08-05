// Phase 12: orchestrator for command execution. Pure logic lives in the Phase 12 leaves:
//   - executorOutput.js      ANSI/URL/LF-CRLF transforms + createBufferedSender
//   - executorPorts.js       port-conflict detection, prompt ask, retry offer
//   - executorProcesses.js   runningProcesses map + ring buffer + stopTrackedProcess
//   - executorDevServer.js   dev-server pattern detection + detach message builder
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { broadcast } from './wsServer.js';
import { recordDevUrl } from './devUrlStore.js';
import { summarizeCommandOutput } from './outputSummarizer.js';
import {
  runningProcesses,
  processLogs,
  LineRingBuffer,
  MAX_LOG_LINES,
  getProcessLog,
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

    sendEvent('start', `Executing: ${finalCommand}\n`);

    // Register so user can stop the server later
    if (projectId) {
      runningProcesses.set(projectId, { child, command: finalCommand, startedAt: Date.now() });
      processLogs.set(projectId, new LineRingBuffer(MAX_LOG_LINES));
      broadcast({ type: 'dashboard_update' });
      broadcast({ type: 'processes_update' });
    }

    function detach() {
      if (detached) return;
      detached = true;
      if (detachTimer) clearTimeout(detachTimer);
      if (forceDetachTimer) clearTimeout(forceDetachTimer);
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
          detachTimer = setTimeout(detach, 500);
        }
      }

      // Interactive "port already in use, run on another one instead? (Y/n)" prompt — ask the
      // user rather than guessing on their behalf, then relay their choice into the still-running
      // process's stdin once they respond (see connection.js's handleConfirmResponse pending.
      // stdinWrite branch). Cancel the force-detach timer while this is pending so the console
      // doesn't claim "Dev server is running" while it's actually just sitting at this prompt.
      if (isDev && !portPromptAsked && projectId) {
        const asked = buildPortPromptConfirmation({
          ws, projectId, cleanInput: clean, triggerCommand: finalCommand,
        });
        if (asked) {
          portPromptAsked = true;
          if (forceDetachTimer) clearTimeout(forceDetachTimer);
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
    forceDetachTimer = setTimeout(() => {
      if (!detached) detach();
    }, isDev ? 10000 : 20000);

    child.on('close', (code) => {
      if (forceDetachTimer) clearTimeout(forceDetachTimer);
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
        runningProcesses.delete(projectId);
        processLogs.delete(projectId);
        broadcast({ type: 'dashboard_update' });
        broadcast({ type: 'processes_update' });
      }
      if (detached) return;
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
          stdout: stdout.length > 4000 ? `...${stdout.slice(-4000)}` : stdout,
          stderr: stderr.length > 2000 ? `...${stderr.slice(-2000)}` : stderr
        }
      });
    });

    child.on('error', (err) => {
      if (forceDetachTimer) clearTimeout(forceDetachTimer);
      runningProcesses.delete(projectId);
      processLogs.delete(projectId);
      broadcast({ type: 'dashboard_update' });
      broadcast({ type: 'processes_update' });
      sendEvent('error_output', `Failed to start process: ${err.message}`);
      sendEvent('end', `\nProcess failed.`);
      resolve({ success: false, error: err.message });
    });
  });
}
