// Close-handler factory for the command executor (2026-08-24, split out of executor.js —
// the 'close' event carries ~120 lines of cleanup, probe, retry and notification logic that
// kept the orchestrator over the 400-line convention). Returns the callback wired to
// `child.on('close', ...)`. The context bundle is built by executor.js from its closures —
// everything the handler needs is explicit, so behavior is a pure move, not a rewrite.

import { broadcast } from './wsServer.js';
import { forgetDevUrl } from './devUrlStore.js';
import { state } from './state.js';
import { probeUrl } from './livenessProbe.js';
import { summarizeCommandOutput } from './outputSummarizer.js';
import { runningProcesses, removeTrackedProcess } from './executorProcesses.js';
import { offerPortRetry } from './executorPorts.js';
import { offerUpstreamRetry } from './executorGitRetry.js';
import { notify } from './notify.js';
import { getTuning } from './tuningStore.js';
import {
  DETACHED_EXIT_PROBE_DELAY_MS,
  DETACHED_EXIT_PROBE_TIMEOUT_MS,
  STDOUT_SUMMARY_CAP,
  STDERR_SUMMARY_CAP,
} from './executorConstants.js';

/**
 * @param {object} ctx  Closure bridge built by executor.js:
 *   trackedEntry   — the shared handle (timers, forceDetach, portPromptAsked)
 *   child          — the spawned ChildProcess
 *   projectId      — active project id (may be null — no tracking)
 *   finalCommand   — the exact command that ran (after venv/port rewrites)
 *   sendEvent      — (type, data) -> ws.send when the socket is open
 *   resolve        — the executeCommand promise resolver
 *   getDetached    — () -> bool, current detach flag (a `let` in executor.js's closure)
 *   getStdout      — () -> string, raw stdout accumulator
 *   getStderr      — () -> string, raw stderr accumulator
 *   stdoutSender   — buffered live-stream sender ('output' channel)
 *   stderrSender   — buffered live-stream sender ('error_output' channel)
 */
export function createCloseHandler(ctx) {
  return (code) => {
    const { trackedEntry, child, projectId, finalCommand, sendEvent, resolve } = ctx;
    const detached = ctx.getDetached();

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
      ctx.stdoutSender.flush();
      ctx.stderrSender.flush();
      // Requested explicitly (2026-07-29, in response to the LF/CRLF flood): don't just stream
      // the raw log and stop — always look at what the command actually produced and call out
      // the parts that matter (errors, package counts, commit/push results). Heuristic/regex-
      // based (see outputSummarizer.js), not an LLM call. Returns null for short/uninteresting
      // output — nothing extra is sent in that case.
      const summary = summarizeCommandOutput({ command: finalCommand, stdout: ctx.getStdout(), stderr: ctx.getStderr(), exitCode: code });
      if (summary) sendEvent('answer', summary);

      // Hard port-conflict failure — the process crashed outright instead of prompting or
      // auto-retrying (e.g. a plain Node/Express server with no built-in port fallback). Offer a
      // one-click retry on the next port through the normal confirm-before-run flow, same as any
      // other command — this never runs anything without the user approving it.
      // Gated (audit 2026-08-17): a deliberately CANCELLED run (code === null — taskkill/
      // SIGTERM via stopTrackedProcess) must never get a "retry?" card, and an AI-run command
      // (turnKey set) owns its retries inside the AI tool loop — a confirm card interrupting
      // the turn would go stale before the user could meaningfully act on it.
      if (code !== null && !ctx.turnKey) {
        offerPortRetry({ ws: ctx.ws, projectId, command: finalCommand, stdout: ctx.getStdout(), stderr: ctx.getStderr(), isDev: ctx.isDev, exitCode: code });
        offerUpstreamRetry({ ws: ctx.ws, projectId, command: finalCommand, stdout: ctx.getStdout(), stderr: ctx.getStderr(), exitCode: code });
      }

      sendEvent('end', `\nProcess exited with code ${code}`);
      resolve({
        success: code === 0,
        data: {
          code,
          stdout: ctx.getStdout().length > getTuning('STDOUT_SUMMARY_CAP', STDOUT_SUMMARY_CAP) ? `...${ctx.getStdout().slice(-getTuning('STDOUT_SUMMARY_CAP', STDOUT_SUMMARY_CAP))}` : ctx.getStdout(),
          stderr: ctx.getStderr().length > getTuning('STDERR_SUMMARY_CAP', STDERR_SUMMARY_CAP) ? `...${ctx.getStderr().slice(-getTuning('STDERR_SUMMARY_CAP', STDERR_SUMMARY_CAP))}` : ctx.getStderr()
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
    // A detached process that never emitted a URL can't be probed — the old "keep the entry
    // conservatively" return left its dock entry (and the project's log buffer) in
    // runningProcesses forever (audit 2026-08-17). The wrapper-close-early concern only
    // matters when there IS a URL to verify; a URL-less run has nothing that can be orphaned
    // behind a probe, so clean it up after the same probe delay. POSIX keeps the entry when
    // the tracked child is still alive (a still-running detached script); Windows always
    // cleans up (the shell wrapper's pid is dead by definition of 'close' having fired).
    if (!lastUrl) {
      setTimeout(() => {
        if (!runningProcesses.has(projectId)) return;
        if (process.platform !== 'win32') {
          try { process.kill(child.pid, 0); return; } catch {}
        }
        const removed = removeTrackedProcess(projectId, child.pid);
        if (removed) {
          broadcast({ type: 'dashboard_update' });
          broadcast({ type: 'processes_update' });
        }
      }, DETACHED_EXIT_PROBE_DELAY_MS);
      return;
    }
    setTimeout(async () => {
      // 2026-08-18: a single probe timeout is NOT proof the server is dead — a busy machine
      // or cold JIT can exceed the 1.5s bound while the site still serves (same class as the
      // dashboard forget fix). Only a definitive refusal — or two consecutive timeouts —
      // declares death; a timeout gets one retry after the same delay. This used to
      // removeTrackedProcess + forgetDevUrl + fire a false `dev-server-crash` notification
      // on the first timeout, silently dropping the open-site chip for a live server.
      let probe = await probeUrl(lastUrl, DETACHED_EXIT_PROBE_TIMEOUT_MS);
      if (!probe.alive && probe.error === 'timeout') {
        await new Promise((r) => setTimeout(r, DETACHED_EXIT_PROBE_DELAY_MS));
        probe = await probeUrl(lastUrl, DETACHED_EXIT_PROBE_TIMEOUT_MS);
      }
      if (probe.alive) return; // real server still serving (wrapper-close-early case)
      const removed = removeTrackedProcess(projectId, child.pid);
      if (removed) {
        // The recorded URL can belong to a sibling process still running (serve + watch) —
        // only forget it when this project no longer has anything tracked.
        if (!runningProcesses.has(projectId)) forgetDevUrl(projectId);
        broadcast({ type: 'dashboard_update' });
        broadcast({ type: 'processes_update' });
        console.log(`[Executor] Detached process for ${projectId} exited and its server is down — tracked entry cleaned up.`);
        // Phase 2: an entry that was still tracked when the process died means it was never
        // deliberately stopped (stopTrackedProcess removes entries first) — that's a crash,
        // so surface it through the notify dispatcher. Fire-and-forget by design.
        notify(projectId, 'dev-server-crash', {
          title: 'Dev server stopped',
          body: `\`${finalCommand}\` exited with code ${code} and no longer answers at ${lastUrl}.`,
        });
      }
    }, DETACHED_EXIT_PROBE_DELAY_MS);
  };
}