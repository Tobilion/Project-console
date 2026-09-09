import crypto from 'crypto';
import { pendingConfirmations } from '../../state.js';

// Confirm-gate helper shared by the mutating general-files handlers (tidy/duplicates_delete/
// rename/move). Mirrors the pendingConfirmations record shape consumed by the `generalFileOp`
// branch in connectionConfirm.js — checkpoint + start first, then the perform* call, exactly
// like every risky op. The owner/command/trigger fields match what the web confirm card and
// the CLI option list both render.
export function queueGeneralOp(ws, project, input, payload, commandText, trigger) {
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId: project.id,
    command: commandText,
    trigger: input,
    createdAt: Date.now(),
    generalFileOp: payload,
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: `${commandText}?\n\nReversible via "revert action <id>" after it runs.`,
    trigger,
  }));
  return true;
}