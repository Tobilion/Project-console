import { createCheckpoint } from '../gitSafety.js';
import { createProjectTools, isCommandAllowed } from '../tools.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { executeCommand, runningProcesses } from '../executor.js';
import { updateNearMiss } from '../nearMissLogger.js';
import { updateTelemetryEntry } from '../intentTelemetry.js';
import { retrainConfidenceModel } from '../confidenceModel.js';
import { trackCommand, trackFileEdit } from '../projectMemory.js';
import { state, pendingConfirmations, pendingToolConfirmations } from '../state.js';
import { pendingMemorySuggestions } from './connectionState.js';

/** User reply to a risky-command / AI-tool confirm card (routeMessage 'confirm_response'). */
export async function handleConfirmResponse(ws, parsed) {
  const { token, confirmed } = parsed.payload;

  if (!token) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token is invalid or expired.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // AI tool-call confirmations (writeFile/editFile/risky executeCommand from the AI path)
  if (pendingToolConfirmations.has(token)) {
    const pending = pendingToolConfirmations.get(token);
    pendingToolConfirmations.delete(token);
    pending.resolve(!!confirmed);
    return;
  }

  // Manual project-trigger risky-command confirmations
  if (!pendingConfirmations.has(token)) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token is invalid or expired.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  const pending = pendingConfirmations.get(token);
  pendingConfirmations.delete(token);

  // Interactive port-conflict prompt from a still-running dev server (see executor.js's
  // PORT_PROMPT_RE detection) — there's no new command to run here, just a reply to write into
  // the already-spawned child's stdin. Handled before the near-miss/telemetry bookkeeping below
  // since those fields don't apply to this pending-confirmation shape.
  if (pending.stdinWrite) {
    const proc = runningProcesses.get(pending.projectId);
    const reply = confirmed ? pending.stdinWrite.yes : pending.stdinWrite.no;
    if (proc?.child?.stdin?.writable) {
      proc.child.stdin.write(reply);
      ws.send(JSON.stringify({
        type: 'answer',
        data: confirmed
          ? 'Told the dev server to run on another port — watch for the new URL.'
          : "Told the dev server not to switch ports — it may exit now if the port is still busy.",
      }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: "That process isn't running anymore — nothing to respond to." }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Track near-miss accept/reject + update linked telemetry entry
  if (pending.nearMissId) {
    updateNearMiss(pending.projectId, pending.nearMissId, { accepted: !!confirmed });
  }
  if (pending.telemetryEntryId) {
    updateTelemetryEntry(pending.projectId, pending.telemetryEntryId, {
      falsePositive: !confirmed,
      resolvedByGuess: confirmed ? pending.command : null,
    });
    // Stage 1 ML work (2026-07-29): every confirm/reject response is a fresh labeled example for
    // confidenceModel.js's logistic regression. Retrain right away rather than waiting for the
    // next server restart, so the learned floor in suggestThresholds() reflects real usage as it
    // happens — fire-and-forget since retraining is fast (a few hundred gradient steps over a
    // small feature vector) but there's no reason to make the user wait on it.
    Promise.resolve().then(() => retrainConfidenceModel()).catch(() => {});
  }

  if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token expired.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  if (!confirmed) {
    ws.send(JSON.stringify({ type: 'answer', data: `Cancelled: "${pending.command}"` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  const project = state.activeProjectsCache.find((p) => p.id === pending.projectId);
  if (!project) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Project not found.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Direct file-tool confirmations from trigger mode (file_create/file_append — see
  // queueFileOpConfirmation in builtinIntents.js) — there's no shell command here, just a
  // sandboxed tools.js function call, so this skips the shell allow/block checks entirely.
  if (pending.fileOp) {
    const cp = await createCheckpoint(project.path, pending.trigger);
    ws.send(JSON.stringify({ type: 'start', data: `[GIT SAFETY] ${cp.message}\n` }));
    const tools = await createProjectTools(project);
    const fn = tools[pending.fileOp.tool];
    if (!fn) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Unknown file operation: ${pending.fileOp.tool}\n` }));
    } else {
      const result = await fn(pending.fileOp.args);
      if (result.success) {
        ws.send(JSON.stringify({ type: 'answer', data: `✅ ${result.data || 'Done.'}` }));
        const suggestion = trackFileEdit(project.path, pending.fileOp.args?.path || 'unknown');
        if (suggestion) {
          pendingMemorySuggestions.set(project.id, suggestion);
          ws.send(JSON.stringify({ type: 'memory_suggestion', data: suggestion }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `${result.error}\n` }));
      }
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  if (isCommandBlocked(pending.command)) {
    ws.send(JSON.stringify({ type: 'error_output', data: `SAFETY BLOCK: Command "${pending.command}" is prohibited.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  if (!isCommandAllowed(pending.command)) {
    ws.send(JSON.stringify({ type: 'error_output', data: `Command not allowed: "${pending.command.split(/\s+/)[0]}" is not in the allowed commands list.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Skip the auto-checkpoint when the user is already making a git commit — the commit
  // itself is the checkpoint and we'd otherwise get a duplicate console-checkpoint commit.
  const isGitCommit = pending.command.trim().startsWith('git add -A && git commit');
  if (!isGitCommit) {
    const cp = await createCheckpoint(project.path, pending.trigger);
    ws.send(JSON.stringify({ type: 'start', data: `[GIT SAFETY] ${cp.message}\n` }));
  }

  executeCommand(pending.command, project.path, ws, project.id);

  // Track the command in project memory
  const suggestion = trackCommand(project.path, pending.command);
  if (suggestion) {
    pendingMemorySuggestions.set(project.id, suggestion);
    ws.send(JSON.stringify({ type: 'memory_suggestion', data: suggestion }));
  }
}
