// Shared, process-wide mutable state for the console server. Kept in one small module so
// routes and WS handlers reference the same instances instead of each holding their own copy.

import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getDataDir } from './dataPath.js';
import { Mutex } from 'async-mutex';

export const projectsMutex = new Mutex();

export const state = {
  currentScanDirectory: process.env.PROJECTS_DIR || path.join(os.homedir(), 'Desktop', 'Projects'),
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

// Reserved pseudo-project id for the General workspace when NO real project is selected
// (2026-08-12): lets a user open the app and chat/tool immediately without picking a project
// first. Deliberately NOT in activeProjectsCache (never shows in the project grid/dashboard);
// resolved lazily by resolveProject(). Its path is a console-owned, gitignored data/ folder —
// never the scan root, so "tidy this folder"/file tools can never touch real user folders.
export const GENERAL_PROJECT_ID = '__general__';

let generalProject = null;

export function getGeneralProject() {
  if (generalProject) return generalProject;
  generalProject = {
    id: GENERAL_PROJECT_ID,
    folderName: 'General',
    name: 'General',
    path: path.join(getDataDir(), 'general-workspace'),
    config: { projectName: 'General', entries: [] },
    workspaceType: 'general',
    contextFiles: [],
    parsedKnowledge: {},
    codebaseIndex: { languages: [], keyFiles: {}, entryPoints: [] },
  };
  return generalProject;
}

/** Resolve a projectId to the scanned project, or the synthetic General workspace for the
 *  reserved id (used by handleExecute and every project-scoped REST route, so the General
 *  workspace's own file tools/notes/PDFs work without a real project). Phase T (2026-08-14):
 *  `tabId` optionally scopes the lookup to that tab's workspace cache — callers without a tab
 *  (CLI, out-of-band work, legacy clients) fall back to the global cache, unchanged. */
export function resolveProject(projectId, tabId) {
  if (projectId === GENERAL_PROJECT_ID) return getGeneralProject();
  const cache = tabId && tabWorkspaces.has(tabId)
    ? tabWorkspaces.get(tabId).projectsCache
    : state.activeProjectsCache;
  return cache.find((p) => p.id === projectId) || null;
}

// Phase T (2026-08-14): per-tab workspaces — Map<tabId, { scanDirectory, projectsCache }>.
// A browser tab addresses its own workspace via ?tab=<id> on REST routes / tabId in the WS
// execute payload, so two tabs can scan different folders without clobbering each other
// (the global state.currentScanDirectory/activeProjectsCache stay the no-tab default).
// Session-lifetime by design: tabs are recreated on reload from the client's localStorage.
export const tabWorkspaces = new Map();

export function getTabWorkspace(tabId) {
  if (!tabId) return null;
  return tabWorkspaces.get(tabId) || null;
}

export function setTabWorkspace(tabId, workspace) {
  tabWorkspaces.set(tabId, workspace);
}

export function deleteTabWorkspace(tabId) {
  tabWorkspaces.delete(tabId);
}

/** Every project from the global cache plus every tab's cache, last-write-wins by id. Used
 *  where a global consumer needs the full set regardless of which tab scanned last — the
 *  semantic-matcher project intents, the NLP retrain, and the code-index watcher sync must
 *  see projects from ALL tabs, or one tab's scan would silently drop another tab's projects
 *  from those global views. */
export function allKnownProjects() {
  const byId = new Map();
  for (const p of state.activeProjectsCache) byId.set(p.id, p);
  for (const ws of tabWorkspaces.values()) {
    for (const p of ws.projectsCache) byId.set(p.id, p);
  }
  return [...byId.values()];
}

function pathHash(p) {
  return crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 8);
}

/** Resolve duplicate folder-name slug ids within a single project cache (audit 2026-08-17).
 *  Two same-named folders under one scan root (e.g. A/beta and B/beta) both scan to id
 *  'beta' — the session-lock path check already refuses wrong-folder chat, but REST routes
 *  and id lookups would silently serve the FIRST match, leaving the second folder
 *  unreachable. Fix: when an id repeats, later projects get '<slug>-<8-char path hash>'.
 *  Deterministic across restarts (path-derived, not scan-order-derived — readdir order
 *  varies): a sorted copy decides who keeps the plain slug, so a restart can never swap
 *  which folder owns it. First-folder sessions persist unchanged; only pre-existing sessions
 *  on the duplicate folder fail the path check with a clear error. */
export function dedupeProjectIds(projects) {
  const taken = new Set();
  for (const p of [...projects].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!taken.has(p.id)) {
      taken.add(p.id);
      continue;
    }
    let suffix = pathHash(p.path);
    while (taken.has(`${p.id}-${suffix}`)) suffix = pathHash(`${p.path}#${suffix}`);
    p.id = `${p.id}-${suffix}`;
    taken.add(p.id);
  }
  return projects;
}

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

// token -> { projectId, command, trigger, createdAt, fileOp?, stdinWrite?, sandbox? }
// (manual risky-trigger confirmations). `sandbox` defaults to true at execution time
// (connectionConfirm) when the Phase 3 setting is on — only explicitly non-risky executions
// (the dev-server port-conflict retry, executorPorts.js) set `sandbox: false`.
export const pendingConfirmations = new Map();

// token -> { resolve, createdAt }  (AI-initiated writeFile/editFile/risky executeCommand confirmations)
export const pendingToolConfirmations = new Map();

// ws -> { activeProjectId, currentSessionId, ... }  (Phase 1: connection->sessionContext map
// so out-of-band work like scheduled fires can find "a live session for project X". The
// sessionContext itself is a per-connection closure in connectionLifecycle.js — it registers
// here on connect and unregisters on close; entries are only ever read, never mutated here.)
export const connectionRegistry = new Map();

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
