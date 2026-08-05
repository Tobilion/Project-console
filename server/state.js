// Shared, process-wide mutable state for the console server. Kept in one small module so
// routes and WS handlers reference the same instances instead of each holding their own copy.

import { Mutex } from 'async-mutex';

export const projectsMutex = new Mutex();

export const state = {
  currentScanDirectory: process.env.PROJECTS_DIR || 'C:\\Users\\tobil\\Desktop\\Projects',
  activeProjectsCache: [],
  // projectId -> last detected dev server URL (e.g. "http://localhost:5173")
  lastDevUrls: new Map(),
  // The port this console server itself actually bound to (set once in index.js after the
  // PORT..PORT+10 fallback loop succeeds) — null until then. Used to warn when a project's own
  // dev server happens to report a URL on this exact same port, which otherwise looks
  // indistinguishable from the console app the user is already looking at (confirmed live
  // 2026-07-29: SportSim Pro's `vite --port=3000` collided with the console's own default port).
  serverPort: null,
};

/**
 * True if a detected dev-server URL's port matches the port this console server itself is
 * running on — that URL will look identical to the console app itself in the browser, which is
 * confusing rather than wrong. Returns false (not a collision) if the console's own port isn't
 * known yet or the URL doesn't parse.
 */
export function isSamePortAsConsole(devUrl) {
  if (!state.serverPort || !devUrl) return false;
  const m = devUrl.match(/:(\d+)\/?$/);
  return !!m && parseInt(m[1], 10) === state.serverPort;
}

/** Appends a heads-up to a dev-server URL answer when it collides with the console's own port. */
export function withPortCollisionWarning(text, devUrl) {
  if (!isSamePortAsConsole(devUrl)) return text;
  return `${text}\n\n⚠ Heads up — that's the same port Project Console itself is running on right now. If the page you land on looks like this console instead of the project, the project's dev server may not actually be reachable there; check its terminal output or change its configured port.`;
}

// token -> { projectId, command, trigger, createdAt }  (manual risky-trigger confirmations)
export const pendingConfirmations = new Map();

// token -> { resolve, createdAt }  (AI-initiated writeFile/editFile/risky executeCommand confirmations)
export const pendingToolConfirmations = new Map();

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Periodic sweep so abandoned confirmation prompts don't sit in memory forever. */
export function sweepExpiredConfirmations() {
  const now = Date.now();
  for (const [token, pending] of pendingConfirmations) {
    if (now - pending.createdAt > CONFIRMATION_TTL_MS) pendingConfirmations.delete(token);
  }
  for (const [token, pending] of pendingToolConfirmations) {
    if (now - pending.createdAt > CONFIRMATION_TTL_MS) {
      try { pending.resolve(false); } catch {}
      pendingToolConfirmations.delete(token);
    }
  }
}
