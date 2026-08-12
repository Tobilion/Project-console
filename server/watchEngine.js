// Phase 15 (2026-08-12): the file-watch notification engine. Watches folders named in
// watch-rules (file-changed/file-added), debounces bursts, and runs a once-per-day-per-rule
// folder-stale sweep from the scheduler's tick (reused — no second interval timer). Fires
// through notify.js's existing channels only — notification-only, never a command trigger.
import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { getWatchRules, getWatchRule } from './watchRules.js';
import { notify } from './notify.js';

// Folders a watch rule can name must resolve to a real directory; rules pointing nowhere
// are skipped (the user may have renamed the folder — better a silent skip than a crash loop).
const IGNORE_DIRS = new Set(['node_modules', '.git', '.console', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv']);
const EVENT_DEBOUNCE_MS = 1000;
const STALE_DAILY_KEY = 'watchRulesLastStaleCheck';

let watchers = new Map(); // folder -> chokidar watcher
let lastStaleCheck = {}; // ruleId -> dayKey

const todayKey = () => new Date().toISOString().slice(0, 10);

function fire(projectId, event, { title, body }) {
  notify(projectId, event, { title, body }).catch(() => {});
}

function isIgnored(p) {
  const parts = p.split(/[\\/]/);
  return parts.some((part) => IGNORE_DIRS.has(part));
}

/** Attach a chokidar watcher for one folder, firing file-changed / file-added rules. */
function attachWatcher(rule) {
  if (watchers.has(rule.folder)) return;
  let lastFire = 0;
  const watcher = chokidar.watch(rule.folder, {
    ignoreInitial: true,
    ignored: (p) => isIgnored(p),
  });
  const debouncedFire = (event) => {
    const now = Date.now();
    if (now - lastFire < EVENT_DEBOUNCE_MS) return;
    lastFire = now;
    const ruleId = rule.id;
    const r = getWatchRule(ruleId);
    if (!r) return;
    fire(r.projectId, event, {
      title: `${r.projectName || 'Watched folder'}: ${event === 'file-changed' ? 'file changed' : 'new file added'}`,
      body: `${r.folder}`,
    });
  };
  watcher.on('change', () => debouncedFire('file-changed'));
  watcher.on('add', () => debouncedFire('file-added'));
  watcher.on('error', () => { /* EPERM etc. — skip, never crash the engine */ });
  watchers.set(rule.folder, watcher);
}

/** One folder-stale sweep pass — called from the scheduler tick, guarded to once per day. */
export function checkStaleFolders() {
  const key = todayKey();
  if (lastStaleCheck[STALE_DAILY_KEY] === key) return;
  lastStaleCheck[STALE_DAILY_KEY] = key;
  for (const rule of getWatchRules()) {
    if (rule.event !== 'folder-stale' || !rule.days) continue;
    const day = todayKey();
    if (lastStaleCheck[rule.id] === day) continue;
    lastStaleCheck[rule.id] = day;
    const folder = rule.folder;
    if (!fs.existsSync(folder)) continue;
    let newest = 0;
    const stack = [folder];
    while (stack.length) {
      const dir = stack.pop();
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (IGNORE_DIRS.has(name)) continue;
        const p = path.join(dir, name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) { stack.push(p); continue; }
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
    if (newest > 0 && Date.now() - newest > rule.days * 24 * 60 * 60 * 1000) {
      fire(rule.projectId, 'folder-stale', {
        title: `${rule.projectName || 'Watched folder'}: no changes for ${rule.days} days`,
        body: `${folder} — last change was ${new Date(newest).toLocaleString()}`,
      });
    }
  }
}

/** Sync watchers to the current rule set (called after every add/remove + at startup). */
export function syncWatchRules() {
  const folders = new Set(getWatchRules().filter((r) => r.event === 'file-changed' || r.event === 'file-added').map((r) => r.folder));
  for (const [folder, watcher] of watchers) {
    if (!folders.has(folder)) {
      watcher.close().catch(() => {});
      watchers.delete(folder);
    }
  }
  for (const rule of getWatchRules()) {
    if (rule.event === 'file-changed' || rule.event === 'file-added') attachWatcher(rule);
  }
}

/** Called once from server/index.js after notifications init. */
export function initWatchRules() {
  syncWatchRules();
}
