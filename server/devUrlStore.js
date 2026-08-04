import fs from 'fs';
import path from 'path';
import { state } from './state.js';

// Persists the last-known dev-server URLs (state.lastDevUrls) across server restarts so
// "is the server running" can liveness-probe a URL even when the process was started outside
// the console or before a restart. The runtime source of truth stays state.lastDevUrls; this
// module only mirrors it to disk, debounced, so the URL-tracking hot path never pays an fs
// write per stdout chunk.
//
// Persistence is deliberately best-effort: a missing/corrupt file means a fresh start, and a
// failed write is swallowed rather than crashing the server.

const DEV_URLS_FILE = path.join(process.cwd(), 'data', 'dev-urls.json');

let saveTimer = null;

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
        if (typeof url === 'string' && /^https?:\/\//.test(url)) {
          state.lastDevUrls.set(projectId, url);
        }
      }
    }
  } catch {
    // corrupt file — fresh start
  }
}

/** Record a detected dev URL (executor.js's URL scan) and persist it. */
export function recordDevUrl(projectId, url) {
  state.lastDevUrls.set(projectId, url);
  schedulePersist();
}

/** Forget a project's dev URL (stop/detach cleanup) and persist the removal. */
export function forgetDevUrl(projectId) {
  if (state.lastDevUrls.delete(projectId)) schedulePersist();
}
