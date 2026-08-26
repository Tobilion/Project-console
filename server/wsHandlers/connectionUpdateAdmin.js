// Phase 5 (2026-08-11): self-update admin commands — `check for updates` (on-demand version
// check answered in chat) and `update console` (installs the latest published version through
// the SAME confirm-gated risky-command flow as any other mutating action — the user approves
// the exact npm command before anything runs, and with sandboxRiskyCommands on it inherits the
// Phase 3 sandboxed env like every other confirmed command). Dispatched from the same
// pre-matcher admin tier as notify/health/auto-start commands (connectionExecute.js).
//
// Answer branches must send a trailing `end` (the frontend only clears its commandPending flag
// on `end`); the confirm_prompt branch must NOT — the confirm flow sends its own `end` after
// approval/rejection.

import crypto from 'crypto';
import { state, pendingConfirmations } from '../state.js';
import { checkForUpdates } from '../updateChecker.js';

const UPDATE_COMMAND = 'npm install -g local-project-console@latest';

const end = (ws) => ws.send(JSON.stringify({ type: 'end' }));

/** "check for updates" / "update console" — returns true when the input matched. */
export async function handleUpdateCommand(ws, project, lowerInput) {
  if (lowerInput === 'check for updates' || lowerInput === 'is there an update' || lowerInput === 'any updates') {
    if (process.env.CONSOLE_DESKTOP === '1') {
      // The desktop build is a separate product — the npm CLI registry check is suppressed
      // (updateChecker.js). Its updates come through the app's built-in electron-updater.
      ws.send(JSON.stringify({
        type: 'answer',
        data: 'This is the desktop app — it has its own update channel (the in-app auto-update, coming with the desktop release pipeline), separate from the npm CLI package. The npm registry check is disabled here on purpose.',
      }));
      end(ws);
      return true;
    }
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
    end(ws);
    return true;
  }

  if (lowerInput === 'update console' || lowerInput === 'update the console' || lowerInput === 'upgrade console') {
    if (process.env.CONSOLE_DESKTOP === '1') {
      // Never offer the npm-CLI update path on the desktop build — it would install the CLI
      // package, not the desktop app (see the check branch above). Desktop updates come from
      // electron-updater (tray menu → Check for updates, or the auto prompt ~30s after launch).
      ws.send(JSON.stringify({
        type: 'answer',
        data: 'This is the desktop app — updates install through the app itself (tray icon → "Check for updates", or the automatic prompt shortly after launch), never through npm. The npm update command is disabled here on purpose.',
      }));
      end(ws);
      return true;
    }
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
      end(ws);
      return true;
    }
    // The version check failed (offline or transient) — still let the user try: npm itself
    // will fail honestly if the registry is unreachable, and the confirm gate stays in place.
    ws.send(JSON.stringify({
      type: 'answer',
      data: "Couldn't verify the latest version (offline?). The update will install the registry's latest published version if you confirm — run 'update console' again to retry the check.",
    }));
    end(ws);
    return true;
  }

  return false;
}