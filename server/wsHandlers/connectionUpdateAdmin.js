// Phase 5 (2026-08-11): self-update admin commands — `check for updates` (on-demand version
// check answered in chat) and `update console` (installs the latest published version through
// the SAME confirm-gated risky-command flow as any other mutating action — the user approves
// the exact npm command before anything runs, and with sandboxRiskyCommands on it inherits the
// Phase 3 sandboxed env like every other confirmed command). Dispatched from the same
// pre-matcher admin tier as notify/health/auto-start commands (connectionExecute.js).
import crypto from 'crypto';
import { state, pendingConfirmations } from '../state.js';
import { checkForUpdates } from '../updateChecker.js';

const UPDATE_COMMAND = 'npm install -g local-project-console@latest';

/** "check for updates" / "update console" — returns true when the input matched. */
export async function handleUpdateCommand(ws, project, lowerInput) {
  if (lowerInput === 'check for updates' || lowerInput === 'is there an update' || lowerInput === 'any updates') {
    const info = await checkForUpdates(true);
    if (!info) {
      ws.send(JSON.stringify({
        type: 'answer',
        data: "Couldn't reach the npm registry — the console is offline-first, so this check fails silently. Try again when you're online.",
      }));
    } else if (!info.available) {
      ws.send(JSON.stringify({ type: 'answer', data: `You're on the latest version (${info.current}).` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `Update available: ${info.current} → ${info.latest}. Say "update console" to install it (you'll be asked to confirm).` }));
    }
    return true;
  }

  if (lowerInput === 'update console' || lowerInput === 'update the console' || lowerInput === 'upgrade console') {
    const info = await checkForUpdates(false);
    if (info?.available) {
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        owner: ws,
        projectId: project.id,
        command: UPDATE_COMMAND,
        trigger: 'update console',
        createdAt: Date.now(),
      });
      ws.send(JSON.stringify({
        type: 'confirm_prompt',
        token,
        command: `${UPDATE_COMMAND}  (updates the console to ${info.latest})`,
        trigger: 'direct_command',
      }));
      return true;
    }
    if (info && !info.available) {
      ws.send(JSON.stringify({ type: 'answer', data: `You're already on the latest version (${info.current}).` }));
      return true;
    }
    // The version check failed (offline or transient) — still let the user try: npm itself
    // will fail honestly if the registry is unreachable, and the confirm gate stays in place.
    ws.send(JSON.stringify({
      type: 'answer',
      data: "Couldn't verify the latest version (offline?). The update will install the registry's latest published version if you confirm — run 'update console' again to retry the check.",
    }));
    return true;
  }

  return false;
}
