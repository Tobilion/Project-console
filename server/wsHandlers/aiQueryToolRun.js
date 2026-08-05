import crypto from 'crypto';
import { createProjectTools, resolveToolGate, isCommandAllowed } from '../tools.js';
import { executeCommand } from '../executor.js';
import { createCheckpoint } from '../gitSafety.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { pendingToolConfirmations } from '../state.js';
import { commandMatchesTemplate } from '../paramCommand.js';
import { computeFileEditPreview } from '../diffPreview.js';

// Phase 5 (PASS 5.4): the tool-call cap is env-overridable so heavy multi-step workflows don't
// hit an artificial wall — defaults to 6, the original constant. Owned here since it bounds the
// tool loop in aiQuery.js.
export const MAX_TOOL_ROUNDS = Number.parseInt(process.env.MAX_TOOL_ROUNDS ?? '', 10) || 6;

/** Waits for the user to approve/reject a gated tool call, driven by an incoming confirm_response. */
export function requestToolConfirmation(ws, tool, args, preview) {
  const token = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingToolConfirmations.set(token, { resolve, createdAt: Date.now() });
    ws.send(JSON.stringify({ type: 'tool_confirm_prompt', token, tool, args, preview }));
  });
}

export async function runGatedExecuteCommand(ws, project, args) {
  const command = args?.command;
  if (!command) return { success: false, error: 'command is required.' };
  if (isCommandBlocked(command)) {
    return { success: false, error: `SAFETY BLOCK: "${command}" matches a dangerous pattern and is prohibited.` };
  }
  if (!isCommandAllowed(command)) {
    return { success: false, error: `Command not allowed: "${command.split(/\s+/)[0]}" is not in the allowed commands list.` };
  }
  if (args.risky) {
    const cp = await createCheckpoint(project.path, command);
    ws.send(JSON.stringify({ type: 'tool_start', data: `[GIT SAFETY] ${cp.message}\n` }));
  }
  // Dev server processes (npm run dev/start) keep running indefinitely. Add a 6s timeout
  // so the AI tool loop doesn't hang — the URL will have been sent as a server_url event
  // during stdout streaming. If the process exits before the timeout, we get the real result.
  const TIMEOUT_MS = 6000;
  const cmdPromise = executeCommand(command, project.path, ws, project.id);
  const result = await Promise.race([
    cmdPromise,
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), TIMEOUT_MS))
  ]);
  if (result?.timeout) {
    return { success: true, data: { code: null, timeout: true, message: 'Command started (long-running process detached after 6s timeout).' } };
  }
  // Confirmed live 2026-07-29 (requested directly): the system prompt already tells the model to
  // offer saving a newly-discovered command into console.config.json, but that was left entirely
  // to the model remembering a long instruction on its own — unreliable in practice. This makes
  // the nudge structural instead of hoped-for: whenever a command actually succeeds and isn't
  // already covered by an existing entry (exact match, or shape match against a {param}
  // template), the tool RESULT itself carries a reminder, so the model sees it fresh on every
  // successful command rather than only when it happens to recall the rule.
  if (result?.success) {
    const entries = project?.config?.entries || [];
    const alreadySaved = entries.some((e) => e.type === 'command' && commandMatchesTemplate(command, e.action));
    if (!alreadySaved) {
      result.note = 'This command is not yet in console.config.json. If it worked, consider offering to save it as a real entry (see your instructions) so trigger mode can run it without AI next time.';
    }
  }
  return result;
}

/**
 * Executes a single parsed tool call. Gating goes through resolveToolGate (tools.js) — the single
 * Phase 5 decision point that consults the project's permissions policy AND the session grant set
 * (sessionContext.toolGrants, fed in as `sessionGrants`). Hierarchy: policy 'deny' → tool error;
 * ungated → runs immediately; runTests/stopProcess/risky executeCommand → always the confirm flow;
 * an existing session grant (including one just granted by "Approve this task") → auto-runs with
 * an "auto-approved" label; otherwise → today's unchanged ask flow, and if the policy is
 * allow-after-first-ask the grant is recorded once the user approves so later calls this session
 * run without asking.
 */
export async function runToolCall(ws, project, tools, call, workspaceTools = {}, workspaceProjects = [], sessionGrants = null) {
  const { tool, args } = call;

  // If the AI specified a projectId, use that project's tools instead — gates resolve against
  // THAT project's root so permissions policy is always evaluated in the target project, never
  // the calling one.
  const targetProjectId = args?.projectId;
  let resolvedTools = tools;
  let resolvedProject = project;
  if (targetProjectId && workspaceTools[targetProjectId]) {
    resolvedTools = workspaceTools[targetProjectId];
    resolvedProject = workspaceProjects.find(p => p.id === targetProjectId) || project;
  }

  if (tool === 'executeCommand') {
    const gate = await resolveToolGate(tool, args, resolvedProject?.path, sessionGrants);
    if (gate.action === 'deny') {
      return { success: false, error: `Tool "${tool}" is denied by this project's permissions policy.` };
    }
    if (gate.action === 'ask') {
      ws.send(JSON.stringify({ type: 'tool_start', data: `Requesting approval to run: ${args?.command}` }));
      const approved = await requestToolConfirmation(ws, tool, args);
      if (!approved) return { success: false, error: 'Command rejected by user.' };
    } else {
      const prefix = gate.autoApproved ? 'Auto-approved ' : '';
      ws.send(JSON.stringify({ type: 'tool_start', data: `${prefix}Running: ${args?.command}` }));
    }
    return runGatedExecuteCommand(ws, resolvedProject, args);
  }

  if (!resolvedTools[tool]) {
    return { success: false, error: `Unknown tool: ${tool}` };
  }

  const gate = await resolveToolGate(tool, args, resolvedProject?.path, sessionGrants);
  const loc = targetProjectId ? ` (${targetProjectId})` : '';
  if (gate.action === 'deny') {
    return { success: false, error: `Tool "${tool}" is denied by this project's permissions policy.` };
  }
  if (gate.action === 'ask') {
    ws.send(JSON.stringify({ type: 'tool_start', data: `Requesting approval for ${tool}${loc}: ${args?.path || args?.content || ''}` }));
    // Phase 14 PASS 3a: attach a best-effort before/after diff to file-edit approvals so the
    // user sees exactly what the AI-proposed change does (computeFileEditPreview returns null
    // on any failure — the confirm prompt must never be delayed or blocked by preview work).
    const preview = tool !== 'executeCommand' ? await computeFileEditPreview(resolvedProject?.path, tool, args) : null;
    const approved = await requestToolConfirmation(ws, tool, args, preview);
    if (!approved) return { success: false, error: `${tool} rejected by user.` };
    // allow-after-first-ask policy: record the grant so the remaining calls this session skip the
    // prompt. executeCommand/runTests/stopProcess never reach here with a grantKey (see
    // resolveToolGate), so this can't soften the always-confirm tools.
    if (sessionGrants && gate.grantKey) sessionGrants.add(gate.grantKey);
  } else {
    const prefix = gate.autoApproved ? 'Auto-approved: ' : '';
    ws.send(JSON.stringify({ type: 'tool_start', data: `${prefix}Running ${tool}${loc}...` }));
  }

  const result = await resolvedTools[tool](args);
  // PASS 5.3 self-check nudge: the model can't see the filesystem, so after a successful write
  // its job isn't done — a read-back is the only thing that can confirm what actually landed on
  // disk. Ride the existing `note` field (same channel the console.config.json save-nudge uses)
  // so it shows up fresh in every tool result, not as a remembered instruction.
  if (result?.success && ['writeFile', 'editFile', 'insertAtLine', 'appendToFile'].includes(tool)) {
    result.note = 'You cannot see the file on disk directly — verify the change by calling readFile right after this unless the user says otherwise.';
  }
  return result;
}
