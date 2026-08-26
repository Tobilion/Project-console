import crypto from 'crypto';
import path from 'path';
import { metrics } from '../metrics.js';
import { state, pendingToolConfirmations } from '../state.js';
import { createCheckpoint } from '../gitSafety.js';
import { createProjectTools, isCommandAllowed, resolveToolGate } from '../tools.js';
import { isCommandBlocked } from '../dangerousPatterns';
import { isDestructiveCommand } from '../commandRisk';
import { executeCommand } from '../executor.js';
import { computeFileEditPreview } from '../diffPreview.js';
import { validateToolCall, withFileLock, FILE_MUTATING_TOOLS } from '../aiGuardrails.js';
import { scheduleVerification } from '../verifyHarness.js';
import { appendAction } from '../actionHistory.js';
import { getCommandDir } from '../commandDir.js';
import { isAskModeBlocked } from '../toolGate';
import { readProfile } from '../routes/profileRoutes.js';

/** Direct tool invocation from the frontend (not via AI chat). Scoped to the client's active project. */
export async function handleToolCall(ws, parsed, sessionContext) {
  const tStart = Date.now();
  const { tool, args } = parsed.payload || {};
  if (!tool) {
    metrics.inc('tool_call.error');
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'Missing tool name.' } }));
    return;
  }
  // Round-6 audit (2026-08-24): read-only "Ask" mode applies to the direct path exactly like
  // the AI path — a mutating/executing tool is blocked with a plain tool_result, no prompt.
  if (readProfile().permissionMode === 'ask' && isAskModeBlocked(tool)) {
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `Ask mode is on — "${tool}" is a mutating or executing tool and is blocked. Only read-only tools run in Ask mode.` } }));
    return;
  }
  metrics.inc(`tool_call.${tool}`);

  const projectId = args?.projectId || sessionContext.activeProjectId;
  const project = state.activeProjectsCache.find((p) => p.id === projectId);
  if (!project) {
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'No active project. Select a project first.' } }));
    return;
  }

  if (tool === 'executeCommand') {
    const { command, risky } = args || {};
    if (!command) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'command is required.' } }));
      return;
    }
    // Server-side effective risk: the caller's flag can only add risk, never waive it (audit
    // 2026-08-17 — the frontend chip path sends risky: false unconditionally). Checkpoint,
    // sandbox, and journaling all key off this value.
    const effectiveRisky = !!risky || isDestructiveCommand(command);
    if (isCommandBlocked(command)) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'SAFETY BLOCK: Dangerous pattern detected.' } }));
      return;
    }
    if (!isCommandAllowed(command)) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `Command not allowed: "${command.split(/\s+/)[0]}" is not in the allowed commands list.` } }));
      return;
    }
    // Same single gate as the AI path (aiQueryToolRun.js) and the generic tool path below:
    // `risky: true` executeCommand can never be auto-approved by any policy or session grant —
    // it always waits for an explicit tool_confirm_prompt approval before anything runs.
    const gate = await resolveToolGate(tool, args, project.path, sessionContext.toolGrants);
    if (gate.action === 'deny') {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `Tool "${tool}" is denied by this project's permissions policy.` } }));
      return;
    }
    if (gate.action === 'ask') {
      const token = crypto.randomUUID();
      const confirmed = await new Promise((resolve) => {
        pendingToolConfirmations.set(token, { owner: ws, resolve, createdAt: Date.now() });
        ws.send(JSON.stringify({ type: 'tool_confirm_prompt', token, tool, args, preview: null }));
      });
      if (!confirmed) {
        ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'executeCommand rejected by user.' } }));
        return;
      }
    }
    if (effectiveRisky) {
      const cp = await createCheckpoint(project.path, command);
      ws.send(JSON.stringify({ type: 'tool_start', data: `[GIT SAFETY] ${cp.message}\n` }));
    }
    // Phase 3: risky direct tool calls are confirm-gated by the gate above (same standard as the
    // AI path) — approved risky commands are flagged for the sandbox; non-risky ones stay
    // env-complete. Runs in the effective command dir so wrapper projects (scriptless root + one
    // sub-package) execute where the package.json actually lives — commandDir.js.
    const sub = await getCommandDir(project);
    executeCommand(command, sub ? path.join(project.path, sub) : project.path, ws, project.id, { sandboxed: effectiveRisky });
    // Phase 4 (2026-08-10): same logging rule as the AI path — risky direct commands are the
    // confirm-worthy set, so they land in the action history.
    if (effectiveRisky) {
      appendAction(project.path, {
        type: /^git\s/i.test(command.trim()) ? 'git' : 'command',
        description: `Ran: ${command}`,
        command,
      });
    }
    return;
  }

  const tools = await createProjectTools(project);
  if (!tools[tool]) {
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `Unknown tool: ${tool}` } }));
    return;
  }

  // Phase 5: direct tool calls consult the same resolveToolGate as the AI path — permissions
  // policy (deny / allow-after-first-ask), session grants ("Approve this task"), and the
  // always-confirm set all apply identically whichever path invokes the tool.
  const gate = await resolveToolGate(tool, args, project?.path, sessionContext.toolGrants);
  if (gate.action === 'deny') {
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `Tool "${tool}" is denied by this project's permissions policy.` } }));
    return;
  }
  if (gate.action === 'ask') {
    const token = crypto.randomUUID();
    const preview = tool !== 'executeCommand' ? await computeFileEditPreview(project.path, tool, args) : null;
    const confirmed = await new Promise((resolve) => {
      pendingToolConfirmations.set(token, { owner: ws, resolve, createdAt: Date.now() });
      ws.send(JSON.stringify({ type: 'tool_confirm_prompt', token, tool, args, preview }));
    });
    if (!confirmed) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `${tool} rejected by user.` } }));
      return;
    }
    // allow-after-first-ask policy: record the grant so later calls this session skip the prompt.
    if (gate.grantKey) sessionContext.toolGrants.add(gate.grantKey);
  } else {
    const prefix = gate.autoApproved ? 'Auto-approved: ' : '';
    ws.send(JSON.stringify({ type: 'tool_start', data: `${prefix}Running ${tool}...` }));
  }

  // Phase 1, Part 1.2 (aiGuardrails): snapshot the pre-edit state for file mutations that would
  // break syntax — never blocks; the warning rides on the result the frontend shows.
  let guard = null;
  let result;
  const runGuardAndExecute = async () => {
    try { guard = await validateToolCall(tool, args, project.path); } catch {}
    try {
      result = await tools[tool](args || {});
    } catch (err) {
      // A tool that throws instead of returning {success:false} used to propagate out of this
      // handler — the frontend got an error_output instead of a tool_result, silently losing
      // the direct-tool-call record (audit 2026-08-06, Phase 2).
      result = { success: false, error: `Tool error: ${err.message}` };
    }
  };
  // Serialize concurrent edits to the same file across different connections/AI turns (audit
  // 2026-08-10 — see withFileLock's doc comment in aiGuardrails.js; same lock the AI tool path
  // in aiQueryToolRun.js uses, so a direct frontend edit and an AI edit to the same file also
  // can't race each other).
  const lockKey = FILE_MUTATING_TOOLS.has(tool) && args?.path && project?.path
    ? path.resolve(project.path, args.path)
    : null;
  if (lockKey) {
    await withFileLock(lockKey, runGuardAndExecute);
  } else {
    await runGuardAndExecute();
  }
  metrics.observe('tool_call.duration', Date.now() - tStart);
  metrics.event({ type: 'tool_call_complete', tool, duration: Date.now() - tStart, success: result?.success !== false });
  if (result?.success && guard?.warning) {
    result.warning = guard.warning;
  }
  // Phase 1, Part 1.4: background type-check on successful file writes (never blocks).
  if (result?.success && FILE_MUTATING_TOOLS.has(tool)) {
    void scheduleVerification(project.path);
  }
  ws.send(JSON.stringify({ type: 'tool_result', data: result }));
}
