// Phase 15 (2026-08-12): the file-watch notification engine. Watches folders named in
// watch-rules (file-changed/file-added), debounces bursts, and runs a once-per-day-per-rule
// folder-stale sweep from the scheduler's tick (reused — no second interval timer). Fires
// through notify.js's existing channels only — notification-only, never a command trigger.
import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { getWatchRules } from './watchRules.js';
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
  const folder = rule.folder;
  let lastFire = 0;
  const watcher = chokidar.watch(folder, {
    ignoreInitial: true,
    ignored: (p) => isIgnored(p),
  });
  const debouncedFire = (event) => {
    const now = Date.now();
    if (now - lastFire < EVENT_DEBOUNCE_MS) return;
    lastFire = now;
    // Fire EVERY rule for this folder whose event type matches (audit 2026-08-17): the old
    // closure captured only the first rule for the folder, so a second rule for the same
    // folder (a different project/name) was silently shadowed — and that captured rule fired
    // on BOTH chokidar events, so a file-changed rule also fired when a file was added.
    // Disabled rules (per-rule toggle, audit 2026-08-17) never fire; lastFiredAt rides the
    // store object so the panel can show when a rule last fired.
    for (const r of getWatchRules()) {
      if (r.folder !== folder || r.event !== event) continue;
      if (r.enabled === false) continue;
      r.lastFiredAt = Date.now();
      fire(r.projectId, event, {
        title: `${r.projectName || 'Watched folder'}: ${event === 'file-changed' ? 'file changed' : 'new file added'}`,
        body: `${folder}`,
      });
    }
  };
  watcher.on('change', () => debouncedFire('file-changed'));
  watcher.on('add', () => debouncedFire('file-added'));
  watcher.on('error', () => { /* EPERM etc. — skip, never crash the engine */ });
  watchers.set(folder, watcher);
}

/** One folder-stale sweep pass — async walk so a huge watched folder can never block the
 *  scheduler tick (audit 2026-08-17: the old synchronous readdir/stat loop froze the event
 *  loop for seconds on large trees). Called from the scheduler tick, guarded to once per day
 *  per rule; the tick runs it fire-and-forget with a catch. */
export async function checkStaleFolders() {
  const key = todayKey();
  if (lastStaleCheck[STALE_DAILY_KEY] === key) return;
  for (const rule of getWatchRules()) {
    if (rule.event !== 'folder-stale' || !rule.days) continue;
    if (rule.enabled === false) continue;
    const day = todayKey();
    if (lastStaleCheck[rule.id] === day) continue;
    const folder = rule.folder;
    if (!fs.existsSync(folder)) {
      // A missing folder is a terminal state for the day — don't re-probe every tick.
      lastStaleCheck[rule.id] = day;
      continue;
    }
    let newest = 0;
    const stack = [folder];
    while (stack.length) {
      // Bounded concurrency (32 dirs per batch) so a huge tree can't hit EMFILE.
      const batch = stack.splice(0, 32);
      const walked = await Promise.all(batch.map(async (dir) => {
        let names = [];
        try { names = await fs.promises.readdir(dir); } catch { return { dirs: [], mtimes: [] }; }
        const stats = await Promise.all(names.map(async (name) => {
          if (IGNORE_DIRS.has(name)) return null;
          const p = path.join(dir, name);
          try { return { p, st: await fs.promises.stat(p) }; } catch { return null; }
        }));
        const dirs = [];
        const mtimes = [];
        for (const item of stats) {
          if (!item) continue;
          if (item.st.isDirectory()) dirs.push(item.p);
          else mtimes.push(item.st.mtimeMs);
        }
        return { dirs, mtimes };
      }));
      for (const w of walked) {
        stack.push(...w.dirs);
        const localMax = Math.max(0, ...w.mtimes);
        if (localMax > newest) newest = localMax;
      }
    }
    if (newest > 0 && Date.now() - newest > rule.days * 24 * 60 * 60 * 1000) {
      rule.lastFiredAt = Date.now();
      fire(rule.projectId, 'folder-stale', {
        title: `${rule.projectName || 'Watched folder'}: no changes for ${rule.days} days`,
        body: `${folder} — last change was ${new Date(newest).toLocaleString()}`,
      });
    }
    // Mark the rule done only AFTER a successful sweep (audit 2026-08-17): marking up
    // front meant a throw mid-walk skipped the rule for the rest of the day.
    lastStaleCheck[rule.id] = day;
  }
  // Same latched-gate rule for the whole pass — it only sticks when the pass completed,
  // so a transient error retries on the next tick instead of silencing every rule today.
  lastStaleCheck[STALE_DAILY_KEY] = key;
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
