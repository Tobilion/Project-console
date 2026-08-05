import crypto from 'crypto';
import { metrics } from '../metrics.js';
import { state, pendingToolConfirmations } from '../state.js';
import { createCheckpoint } from '../gitSafety.js';
import { createProjectTools, isCommandAllowed, resolveToolGate } from '../tools.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { executeCommand } from '../executor.js';
import { computeFileEditPreview } from '../diffPreview.js';

/** Direct tool invocation from the frontend (not via AI chat). Scoped to the client's active project. */
export async function handleToolCall(ws, parsed, sessionContext) {
  const tStart = Date.now();
  const { tool, args } = parsed.payload || {};
  if (!tool) {
    metrics.inc('tool_call.error');
    ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'Missing tool name.' } }));
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
    if (isCommandBlocked(command)) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: 'SAFETY BLOCK: Dangerous pattern detected.' } }));
      return;
    }
    if (!isCommandAllowed(command)) {
      ws.send(JSON.stringify({ type: 'tool_result', data: { success: false, error: `Command not allowed: "${command.split(/\s+/)[0]}" is not in the allowed commands list.` } }));
      return;
    }
    if (risky) {
      const cp = await createCheckpoint(project.path, command);
      ws.send(JSON.stringify({ type: 'tool_start', data: `[GIT SAFETY] ${cp.message}\n` }));
    }
    executeCommand(command, project.path, ws, project.id);
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
      pendingToolConfirmations.set(token, { resolve, createdAt: Date.now() });
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

  const result = await tools[tool](args || {});
  metrics.observe('tool_call.duration', Date.now() - tStart);
  metrics.event({ type: 'tool_call_complete', tool, duration: Date.now() - tStart, success: result?.success !== false });
  ws.send(JSON.stringify({ type: 'tool_result', data: result }));
}
