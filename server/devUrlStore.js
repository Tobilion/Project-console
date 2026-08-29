import fs from 'fs';
import path from 'path';
import { resolveData } from './dataPath.js';
import { state } from './state.js';

// Persists the last-known dev-server URLs (state.lastDevUrls) across server restarts so
// "is the server running" can liveness-probe a URL even when the process was started outside
// the console or before a restart. The runtime source of truth stays state.lastDevUrls; this
// module only mirrors it to disk, debounced, so the URL-tracking hot path never pays an fs
// write per stdout chunk.
//
// Persistence is deliberately best-effort: a missing/corrupt file means a fresh start, and a
// failed write is swallowed rather than crashing the server.

// Env-overridable for harness isolation (2026-08-18): checkHandlerCoverage's
// dev_server_status row probes live candidate ports and records hits — without a redirect it
// wrote fixture ids (p1) into the REAL data/dev-urls.json. Same pattern as WATCH_RULES_FILE /
// SCHEDULES_FILE / EDITORS_FILE.
const DEV_URLS_FILE = process.env.DEV_URLS_FILE || resolveData('dev-urls.json');

let saveTimer = null;

// A stored URL on the console's own port can never be a project's dev server (the console
// itself holds that port). Refused at record AND load time so a URL captured while the console
// ran on another port can't falsely claim a project is live after the console moves there —
// confirmed live 2026-08-10: Matchday Exchange's stored :3001 stayed "live" in the dashboard
// after the console itself took over port 3001.
function collidesWithConsole(url) {
  try {
    return Number(new URL(url).port) === Number(state.serverPort);
  } catch {
    return false;
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(DEV_URLS_FILE), { recursive: true });
    fs.writeFileSync(DEV_URLS_FILE, JSON.stringify(Object.fromEntries(state.lastDevUrls), null, 2));
  } catch {
    // best-effort only
  }
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 500);
}

/** Load persisted dev URLs into state.lastDevUrls. Call once at server startup. */
export function loadDevUrls() {
  try {
    if (!fs.existsSync(DEV_URLS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(DEV_URLS_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [projectId, url] of Object.entries(parsed)) {
        if (typeof url === 'string' && /^https?:\/\//.test(url) && !collidesWithConsole(url)) {
          state.lastDevUrls.set(projectId, url);
        }
      }
    }
  } catch {
    // corrupt file — fresh start
  }
}

/** Record a detected dev URL (executor.js's URL scan) and persist it. Refuses URLs on the
 *  console's own port — that port belongs to the console, not to any project. */
export function recordDevUrl(projectId, url) {
  if (collidesWithConsole(url)) return;
  state.lastDevUrls.set(projectId, url);
  schedulePersist();
}

/** Forget a project's dev URL (stop/detach cleanup) and persist the removal. */
export function forgetDevUrl(projectId) {
  if (state.lastDevUrls.delete(projectId)) schedulePersist();
}
