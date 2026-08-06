import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { executeCommand } from '../executor.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { pendingConfirmations } from '../state.js';
import { extractParamValue, isSafeParamValue, substituteParams } from '../paramCommand.js';

/**
 * Runs (or queues confirmation for) a fully-resolved command entry — i.e. one with no remaining
 * {placeholder} params. Shared by the normal single-shot path below and by connection.js's
 * pending-parameter follow-up flow, so both go through the exact same safety checks
 * (isCommandBlocked runs again here on the SUBSTITUTED command, not just the template) and the
 * exact same risky/non-risky confirm behavior.
 */
export async function runCommandEntry(ws, entry, input, matchedTrigger, project, sessionContext) {
  if (entry.requires?.length) {
    for (const rel of entry.requires) {
      try {
        await fs.access(path.join(project.path, rel));
      } catch {
        ws.send(JSON.stringify({
          type: 'answer',
          data: entry.requiresMessage || `Missing required file "${rel}" — this project needs a one-time setup step before this command will work.`,
        }));
        return;
      }
    }
  }
  if (isCommandBlocked(entry.action)) {
    ws.send(JSON.stringify({
      type: 'error_output',
      data: `SAFETY BLOCK: Command "${entry.action}" matches a dangerous pattern and is prohibited.\n`
    }));
    return;
  }
  // Optional `followUp` on an entry (2026-08-03, requested directly): ask the user a plain
  // question BEFORE this command starts — e.g. NetPulse's "start netpulse" asks "also watch the
  // network? reply with an interval". The reply is handled by connection.js's pendingFollowUp
  // branch (same interception point as pendingParam), which runs this entry and, when an interval
  // was given, the follow-up entry with it substituted in. Skipped when the input that matched
  // already contains the follow-up entry's parameter value ("start netpulse and watch at interval
  // of 5 minutes" — the value is already there, no question needed).
  if (entry.followUp && sessionContext) {
    const target = project.config?.entries?.find((e) => e.triggers?.includes(entry.followUp.entry));
    const param = target?.params?.find((p) => p.name === entry.followUp.param);
    if (target && param && !extractParamValue(input, param.pattern)) {
      sessionContext.pendingFollowUp = {
        // Strip followUp from the stored entry so re-running it after the reply can't re-ask.
        entry: { ...entry, followUp: undefined },
        target,
        followUp: entry.followUp,
        projectId: project.id,
      };
      ws.send(JSON.stringify({
        type: 'answer',
        data: `${entry.followUp.ask} (reply "no" to skip it, or "cancel" to stop)`,
      }));
      return;
    }
  }
  if (entry.risky) {
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      owner: ws,
      projectId: project.id,
      command: entry.action,
      trigger: input,
      createdAt: Date.now()
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt',
      token,
      command: entry.action,
      trigger: matchedTrigger || input
    }));
  } else {
    executeCommand(entry.action, project.path, ws, project.id);
  }
}

/**
 * Handles a "command" entry that declares {placeholder} params (see paramCommand.js). Tries to
 * resolve every param straight from the phrase that matched (e.g. "watch every 15 minutes"
 * already contains the interval); anything left unresolved gets asked as a plain follow-up
 * question via sessionContext.pendingParam, which connection.js's handleExecute checks before
 * running the normal matching pipeline on the user's next message. No AI/LLM involved — this is
 * what lets parameterized commands work the same whether AI mode is on or off.
 */
async function resolveParamsAndRun(ws, entry, input, matchedTrigger, project, sessionContext) {
  const values = {};
  for (const p of entry.params) {
    const extracted = extractParamValue(input, p.pattern);
    if (extracted && isSafeParamValue(extracted)) values[p.name] = extracted;
  }
  const missing = entry.params.find((p) => values[p.name] === undefined);
  if (missing) {
    sessionContext.pendingParam = {
      entry, projectId: project.id, values, paramName: missing.name,
      params: entry.params, matchedTrigger: matchedTrigger || input,
    };
    ws.send(JSON.stringify({ type: 'answer', data: missing.prompt }));
    return;
  }
  const resolvedEntry = { ...entry, action: substituteParams(entry.action, values) };
  await runCommandEntry(ws, resolvedEntry, input, matchedTrigger, project, sessionContext);
}

/** Handles a project.config.json trigger match: runs an "answer" or executes/confirms a "command". */
export async function handleMatchedEntry(ws, entry, input, matchedTrigger, project, sessionContext) {
  sessionContext.lastTriggeredEntry = entry;

  if (entry.type === 'answer') {
    ws.send(JSON.stringify({ type: 'answer', data: entry.response }));
  } else if (entry.type === 'command' && entry.params?.length) {
    await resolveParamsAndRun(ws, entry, input, matchedTrigger, project, sessionContext);
  } else if (entry.type === 'command') {
    await runCommandEntry(ws, entry, input, matchedTrigger, project, sessionContext);
  }
}
