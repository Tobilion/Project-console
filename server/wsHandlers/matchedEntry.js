import crypto from 'crypto';
import { executeCommand } from '../executor.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { pendingConfirmations } from '../state.js';

/** Handles a project.config.json trigger match: runs an "answer" or executes/confirms a "command". */
export async function handleMatchedEntry(ws, entry, input, matchedTrigger, project, sessionContext) {
  sessionContext.lastTriggeredEntry = entry;

  if (entry.type === 'command' && isCommandBlocked(entry.action)) {
    ws.send(JSON.stringify({
      type: 'error_output',
      data: `SAFETY BLOCK: Command "${entry.action}" matches a dangerous pattern and is prohibited.\n`
    }));
    return;
  }

  if (entry.type === 'answer') {
    ws.send(JSON.stringify({ type: 'answer', data: entry.response }));
  } else if (entry.type === 'command') {
    if (entry.risky) {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
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
}
