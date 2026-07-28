// Shared, process-wide mutable state for the console server. Kept in one small module so
// routes and WS handlers reference the same instances instead of each holding their own copy.

import { Mutex } from 'async-mutex';

export const projectsMutex = new Mutex();

export const state = {
  currentScanDirectory: process.env.PROJECTS_DIR || 'C:\\Users\\tobil\\Desktop\\Projects',
  activeProjectsCache: [],
  // projectId -> last detected dev server URL (e.g. "http://localhost:5173")
  lastDevUrls: new Map(),
};

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
