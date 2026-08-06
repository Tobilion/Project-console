// Phase 12 leaf: port-in-use handling for executor.js (verbatim moves + two extracted helpers).
// Dev servers hit an already-occupied port in two different shapes, and neither used to be
// handled: (1) tools like Create React App's `react-scripts start` print an interactive
// "Would you like to run the app on another port instead? (Y/n)" prompt and then just wait —
// since stdin was previously `'ignore'`, the process would hang forever with no way to answer
// it; (2) tools with no auto-retry (custom Node/Express servers, some configs) just crash with
// EADDRINUSE and exit. Vite's own default behavior (auto-increment + report the real port) needs
// no special handling — the existing URL detection already captures whatever port it actually
// lands on.

import crypto from 'crypto';
import { pendingConfirmations } from './state.js';

// CRA/react-scripts' prompt text, matched loosely (port number can appear a little before the
// "(Y/n)" marker, with framing text in between).
export const PORT_PROMPT_RE = /port\s+(\d{2,5})[\s\S]{0,300}\(Y\/n\)/i;

const PORT_IN_USE_HARD_RE = /EADDRINUSE|address already in use/i;

/** Best-effort port extraction from whichever line actually mentions the conflict. */
export function extractBusyPort(text) {
  const line = text.split('\n').find((l) => PORT_IN_USE_HARD_RE.test(l));
  if (!line) return null;
  const m = line.match(/:(\d{2,5})\b/) || line.match(/port\s+(\d{2,5})/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Builds a best-effort retry command on the next port up. If the original command already has
 * an explicit `--port` flag (Vite's style — matches this project's own confirmed-live case),
 * increment that. Otherwise fall back to setting the PORT env var, which covers CRA and any
 * Node http server that reads `process.env.PORT` (including this console's own server — see
 * index.js) — cross-platform, matching the same process.platform branching convention already
 * used in commandGuesser.js.
 */
export function buildPortRetryCommand(command, busyPort) {
  const nextPort = busyPort + 1;
  if (/--port[= ]\d+/i.test(command)) {
    return command.replace(/--port[= ]\d+/i, `--port=${nextPort}`);
  }
  const isWindows = process.platform === 'win32';
  return isWindows ? `set PORT=${nextPort}&& ${command}` : `PORT=${nextPort} ${command}`;
}

/**
 * Detects an interactive "port already in use, run on another one instead? (Y/n)" prompt in a
 * command's output and asks the user rather than guessing on their behalf, then relays their
 * choice into the still-running process's stdin once they respond (see connection.js's
 * handleConfirmResponse pending.stdinWrite branch). Returns true when the prompt was found and
 * the confirmation was queued — the caller is responsible for the closure-bound bookkeeping it
 * replaced (setting `portPromptAsked` and cancelling the force-detach timer, so the console
 * doesn't claim "Dev server is running" while it's actually just sitting at this prompt).
 */
export function buildPortPromptConfirmation({ ws, projectId, cleanInput, triggerCommand }) {
  const promptMatch = cleanInput.match(PORT_PROMPT_RE);
  if (!promptMatch) return false;
  const busyPort = parseInt(promptMatch[1], 10);
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId,
    stdinWrite: { yes: 'Y\n', no: 'n\n' },
    command: `Respond to dev server port prompt (port ${busyPort} busy)`,
    trigger: triggerCommand,
    createdAt: Date.now(),
  });
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'confirm_prompt',
      token,
      command: `Port ${busyPort} is already in use. Run this dev server on the next available port instead?`,
      trigger: 'port_conflict',
    }));
  }
  return true;
}

/**
 * After a hard port-conflict failure — the process crashed outright instead of prompting or
 * auto-retrying (e.g. a plain Node/Express server with no built-in port fallback) — offer a
 * one-click retry on the next port through the normal confirm-before-run flow, same as any
 * other command; this never runs anything without the user approving it. Returns true when a
 * retry confirmation was queued.
 */
export function offerPortRetry({ ws, projectId, command, stdout, stderr, isDev, exitCode }) {
  if (exitCode === 0 || !isDev || !projectId) return false;
  const busyPort = extractBusyPort(`${stdout}\n${stderr}`);
  if (!busyPort) return false;
  const retryCommand = buildPortRetryCommand(command, busyPort);
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId,
    command: retryCommand,
    trigger: command,
    createdAt: Date.now(),
  });
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'confirm_prompt',
      token,
      command: `${retryCommand}  (port ${busyPort} was already in use — retry on the next port)`,
      trigger: 'port_conflict_retry',
    }));
  }
  return true;
}
