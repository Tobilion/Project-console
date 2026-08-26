import path from 'path';
import { createCheckpoint } from '../gitSafety.js';
import { createProjectTools, isCommandAllowed } from '../tools.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { executeCommand, runningProcesses, PORT_PROMPT_ANSWER_TIMEOUT_MS } from '../executor.js';
import { updateNearMiss } from '../nearMissLogger.js';
import { updateTelemetryEntry } from '../intentTelemetry.js';
import { retrainConfidenceModel } from '../confidenceModel.js';
import { trackCommand, trackFileEdit } from '../projectMemory.js';
import { appendAction, revertAction } from '../actionHistory.js';
import { performTidy, performDuplicateDeletes, performRename, performMove } from './builtinGeneralFiles.js';
import { mergePdfs, splitPdf, extractPages, watermarkPdf } from '../pdfKit.js';
import { state, pendingConfirmations, pendingToolConfirmations, connectionRegistry } from '../state.js';
import { pendingMemorySuggestions } from './connectionState.js';
import { log as logger } from '../logger.js';

/** User reply to a risky-command / AI-tool confirm card (routeMessage 'confirm_response'). */
export async function handleConfirmResponse(ws, parsed) {
  const { token, confirmed } = parsed.payload || {};

  if (!token) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token is invalid or expired.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // AI tool-call confirmations (writeFile/editFile/risky executeCommand from the AI path)
  if (pendingToolConfirmations.has(token)) {
    const pending = pendingToolConfirmations.get(token);
    pendingToolConfirmations.delete(token);
    // Same expiry rule as pendingConfirmations below (5 minutes), plus the owner check: a
    // stale card resolved long after the fact, or a token resolved from a DIFFERENT connection
    // than the one that sent the prompt, must never execute the gated tool. Resolving false
    // rejects the pending promise so the calling turn sees a clean rejection.
    if (Date.now() - pending.createdAt > 5 * 60 * 1000 || (pending.owner && pending.owner !== ws)) {
      try { pending.resolve(false); } catch {}
      ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token is invalid or expired.\n' }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
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

  // Expiry gate for every branch below — checked BEFORE the stdinWrite branch so an expired
  // confirm can't write Y/n into a running child's stdin (it previously ran only after that
  // branch, which consumed expired port-prompt replies).
  if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Confirmation token expired.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Interactive port-conflict prompt from a still-running dev server (see executor.js's
  // PORT_PROMPT_RE detection) — there's no new command to run here, just a reply to write into
  // the already-spawned child's stdin. Handled before the near-miss/telemetry bookkeeping below
  // since those fields don't apply to this pending-confirmation shape. The pending record's
  // trigger is the spawned command, so the matching tracked entry is found by it — a project
  // can have several processes running concurrently, and the reply must reach the one that's
  // actually sitting at the prompt.
  if (pending.stdinWrite) {
    const proc = [...(runningProcesses.get(pending.projectId)?.values() || [])]
      .find((p) => p.command === pending.trigger) || null;
    const reply = confirmed ? pending.stdinWrite.yes : pending.stdinWrite.no;
    if (proc?.child?.stdin?.writable) {
      // Re-arm the prompt-pending force-detach bound and allow a repeat prompt: executor's
      // closure cleared the force-detach timer when it asked the question, and nothing re-armed
      // it — an unanswered (or twice-asked) port conflict left the command hung forever (audit
      // 2026-08-06, Phase 2). The timers/flag live on the tracked entry so this handler can
      // reach them.
      if (proc.forceDetachTimer) clearTimeout(proc.forceDetachTimer);
      if (typeof proc.forceDetach === 'function') {
        proc.forceDetachTimer = setTimeout(proc.forceDetach, PORT_PROMPT_ANSWER_TIMEOUT_MS);
      }
      if (proc.portPromptAsked !== undefined) proc.portPromptAsked = false;
      const wrote = proc.child.stdin.write(reply);
      // A write returning false on a dead stream (child exited between the check and the
      // write) means the reply never landed — say so instead of the optimistic "told it to
      // switch ports" message.
      if (wrote === false && !proc.child.stdin.writable) {
        ws.send(JSON.stringify({ type: 'answer', data: "That process isn't running anymore — nothing to respond to." }));
      } else {
        ws.send(JSON.stringify({
          type: 'answer',
          data: confirmed
            ? 'Told the dev server to run on another port — watch for the new URL.'
            : "Told the dev server not to switch ports — it may exit now if the port is still busy.",
        }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: "That process isn't running anymore — nothing to respond to." }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Track near-miss accept/reject + update linked telemetry entry. These are synchronous fs
  // writes; a failure (read-only data/, disk full) must NOT fail the confirm turn after the
  // command already ran — log and continue instead of a spurious "Error processing request".
  try {
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
  } catch (err) {
    logger.error('Confirm bookkeeping failed (non-fatal):', err.message);
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
        // Additive actionIds (2026-08-24): the web client's answer case fires an undo toast
        // whose Undo sends `revert action <id>` — same additive-field contract as openPanel;
        // the CLI ignores it permanently.
        ws.send(JSON.stringify({
          type: 'answer',
          data: `✓ ${result.data || 'Done.'}`,
          ...(result.actionId ? { actionIds: [result.actionId] } : {}),
        }));
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

  // Phase 4 (2026-08-10): confirmed `revert action <id>` (see connectionHistoryAdmin.js).
  // Same safety shape as the fileOp branch — a checkpoint first, then the restore, which is
  // performed by revertAction (never here) and meta-logged there as a 'revert' action.
  // Batch form (2026-08-24): `pending.revert.actionIds` — the undo toast's batch revert
  // (multi-file tidy/dedupe ops journal one action per file). Reverts in the given order,
  // newest-first by construction (the toast sends the ids in journal order), and reports
  // every per-id result — a failure stops the loop and names the failing id.
  if (pending.revert) {
    const cp = await createCheckpoint(project.path, pending.trigger);
    ws.send(JSON.stringify({ type: 'start', data: `[GIT SAFETY] ${cp.message}\n` }));
    const ids = pending.revert.actionIds || [pending.revert.actionId];
    const results = [];
    for (const id of ids) {
      const result = await revertAction(project.path, id);
      results.push({ ok: result.ok, id, text: result.ok ? result.data : result.error });
      if (!result.ok) break;
    }
    if (ids.length === 1) {
      // Single revert keeps the historical channel contract: success is an answer,
      // failure is an error_output.
      ws.send(JSON.stringify(results[0].ok
        ? { type: 'answer', data: results[0].text }
        : { type: 'error_output', data: `${results[0].text}\n` }));
    } else {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Reverted ${results.length} action(s):\n\n${results.map((r) => `- ${r.ok ? r.text : `\`${r.id}\`: ${r.text}`}`).join('\n')}`,
      }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Phase 2 (UPGRADE-ROADMAP.md, 2026-08-11): confirmed general-file operations (tidy moves /
  // duplicate deletes from builtinGeneralFiles.js). No shell command is involved — the moves/
  // deletes are plain sandboxed fs calls journaled through appendAction, so this skips the
  // shell allow/block checks exactly like the fileOp and revert branches above.
  if (pending.generalFileOp) {
    const op = pending.generalFileOp;
    const cp = await createCheckpoint(project.path, pending.trigger);
    ws.send(JSON.stringify({ type: 'start', data: `[GIT SAFETY] ${cp.message}\n` }));
    let result;
    if (op.kind === 'tidy') {
      result = await performTidy(project.path, op.moves);
    } else if (op.kind === 'duplicates_delete') {
      result = await performDuplicateDeletes(project.path, op.files);
    } else if (op.kind === 'rename') {
      result = await performRename(project.path, op.from, op.to);
    } else if (op.kind === 'move') {
      result = await performMove(project.path, op.file, op.targetDir);
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: `Unknown file operation: ${op.kind}\n` }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
    if (result.ok) {
      const note = result.skippedJournal
        ? ` (${result.skippedJournal} over the history pre-image size cap weren't logged for revert)`
        : '';
      const detail = op.kind === 'rename'
        ? `Renamed \`${result.from}\` → \`${result.to}\``
        : op.kind === 'move'
          ? `Moved \`${result.from}\` into \`${path.dirname(result.to).replace(/\\/g, '/')}\``
          : `Done — ${result.deleted ?? result.moved} file(s) ${op.kind === 'tidy' ? 'moved' : 'deleted'}${note}. Undo with \`revert action <id>\` or "show history".`;
      ws.send(JSON.stringify({
        type: 'answer',
        data: `${detail}. Undo with \`revert action <id>\` or "show history".`,
        ...(result.actionIds?.length ? { actionIds: result.actionIds } : {}),
      }));
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: `${result.error}\n` }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Phase 3 (UPGRADE-ROADMAP.md, 2026-08-11): confirmed PDF toolkit operations (merge/split/
  // extract-pages/watermark from builtinPdfTools.js). Same safety shape as the branches above
  // — no shell command, plain sandboxed pdf-lib calls whose journaling happens inside
  // pdfKit.js, so the shell allow/block checks are skipped exactly like generalFileOp.
  if (pending.pdfOp) {
    const op = pending.pdfOp;
    const cp = await createCheckpoint(project.path, pending.trigger);
    ws.send(JSON.stringify({ type: 'start', data: `[GIT SAFETY] ${cp.message}\n` }));
    let result;
    try {
      if (op.kind === 'merge') {
        result = await mergePdfs(project.path, op.inputs, op.output);
      } else if (op.kind === 'split') {
        result = await splitPdf(project.path, op.input, op.spec);
      } else if (op.kind === 'extract_pages') {
        result = await extractPages(project.path, op.input, op.range.from, op.range.to, op.output);
      } else if (op.kind === 'watermark') {
        result = await watermarkPdf(project.path, op.input, op.text, op.output);
      } else {
        result = { ok: false, error: `Unknown PDF operation: ${op.kind}` };
      }
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result.ok) {
      const firstOutput = result.output || (result.outputs && result.outputs[0] && result.outputs[0].path);
      const detail = op.kind === 'merge'
        ? `${result.pages} page(s), ${Math.max(1, Math.round(result.bytes / 1024))}KB`
        : op.kind === 'split'
          ? result.outputs.map((o) => `${o.path} (${o.pages} page(s))`).join(', ')
          : `${result.pages} page(s)`;
      const link = firstOutput
        ? `\n\nDownload: [${firstOutput}](/api/projects/${project.id}/file?path=${encodeURIComponent(firstOutput)})`
        : '';
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Done — ${detail}. Undo with \`revert action <id>\` or "show history".${link}`,
        ...(result.actionIds?.length ? { actionIds: result.actionIds } : {}),
      }));
    } else {
      // Same answer channel as the pdf handler's own refusals ("Could not find these PDFs",
      // "Merge needs at least two PDFs") — a refused output name is a normal refusal, not an
      // execution error, and the frontend renders answers as readable bubbles.
      ws.send(JSON.stringify({ type: 'answer', data: result.error }));
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

  // Phase 3 (2026-08-10): everything that reaches this point went through the confirm gate —
  // config entries with risky: true, git mutations, guessed commands — so it runs sandboxed
  // when the user opted in (see executor.js's opts.sandboxed). The one non-risky shape, the
  // dev-server port-conflict retry, opts out explicitly with `sandbox: false` (executorPorts).
  executeCommand(pending.command, project.path, ws, project.id, { sandboxed: pending.sandbox !== false });

  // Phase 4 (2026-08-10): log the confirmed action. The dev-server port-conflict retry is the
  // only non-risky shape that reaches here and marks itself `sandbox: false` (executorPorts) —
  // exactly the ones that shouldn't pollute the history. git commands are flagged so `revert
  // action` can give them checkpoint-aware git advice instead of the generic answer.
  if (pending.sandbox !== false) {
    // Phase 19: attribute the action to the confirming connection's display name ("local"
    // default — single-user history shape unchanged).
    const ownerCtx = connectionRegistry.get(pending.owner);
    appendAction(project.path, {
      type: /^git\s/i.test(pending.command.trim()) ? 'git' : 'command',
      description: `Ran: ${pending.command}`,
      command: pending.command,
      createdBy: ownerCtx?.displayName || 'local',
    });
  }

  // Track the command in project memory
  const suggestion = trackCommand(project.path, pending.command);
  if (suggestion) {
    pendingMemorySuggestions.set(project.id, suggestion);
    ws.send(JSON.stringify({ type: 'memory_suggestion', data: suggestion }));
  }
}
