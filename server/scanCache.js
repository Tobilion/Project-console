/**
 * Whole-scan cache (Phase 6, 2026-08-17). discoverProjects() walks the entire container —
 * per-project config/doc reads, script-entry derivation, and a full codebase index per
 * project — and GET /api/projects fired it on EVERY fetch (tab switch, dashboard polling,
 * session opens), so a multi-tab reload with several heavy roots re-scanned everything
 * serially per tab. This caches the whole-scan result per scan root with a short TTL and
 * validates each hit against cheap per-project mtime signals (config/context-file/git-HEAD/
 * folder mtimes), so a config or doc edit applies immediately rather than after the TTL.
 *
 * Staleness contract: the signature covers config edits (atomic writes rename, which also
 * bumps the folder mtime), doc edits (context-file mtimes), git commits (.git/HEAD), and
 * new/removed files or folders (folder mtimes). Code-content-only changes inside a project
 * do not invalidate the signature — their effect (a changed repo map) is bounded by the
 * TTL, which is the deliberate trade-off that makes the cache worthwhile.
 */
import fs from 'fs';
import path from 'path';

const SCAN_CACHE_TTL_MS = 8000;
const SCAN_CACHE_MAX_ENTRIES = 12;
// D-2 (2026-09-08): a stale entry within this grace window past the TTL is still served
// immediately (stale-while-revalidate) rather than blocking the request on a full re-scan —
// the signature check still runs first, so an actually-changed project never serves stale
// data regardless of this window. Past the grace window a miss blocks as before; this only
// smooths over the common "just barely expired" case a poll/tab-switch is likely to hit.
const SCAN_CACHE_STALE_GRACE_MS = 60000;

// scanDir + includeAll -> { projects, scannedAt, signature, refreshing }
const entries = new Map();

function cacheKey(scanDir, includeAll) {
  return `${scanDir}\u0000${includeAll ? '1' : '0'}`;
}

function cacheRoot(key) {
  return key.slice(0, key.indexOf('\u0000'));
}

/** stat-or-absence marker for one file: `label:1:<mtimeMs>` when present, `label:0` when
 *  missing — the presence bit matters, because a deleted console.config.json must
 *  invalidate the entry even though nothing stat'd the file before (the folder-mtime
 *  signal misses deletions made by editors that don't rename). */
function fileMarker(parts, label, filePath) {
  try {
    const s = fs.statSync(filePath);
    parts.push(s.isFile() ? `${label}:1:${s.mtimeMs}` : `${label}:0`);
  } catch {
    parts.push(`${label}:0`);
  }
}

function projectSignature(project) {
  const parts = [];
  fileMarker(parts, 'cfg', path.join(project.path, 'console.config.json'));
  fileMarker(parts, 'pkg', path.join(project.path, 'package.json'));
  fileMarker(parts, 'head', path.join(project.path, '.git', 'HEAD'));
  const contextFiles = project.contextFiles || [];
  for (let i = 0; i < contextFiles.length; i++) {
    // Context-file entries are { filename, content } objects (projectScanHelpers.js); the
    // container scan also adopts sub-package docs wholesale, so plain strings and objects
    // can both appear here — path.join would crash on the object shape.
    const name = typeof contextFiles[i] === 'string' ? contextFiles[i] : contextFiles[i].filename;
    fileMarker(parts, `ctx${i}`, path.join(project.path, name));
  }
  try {
    parts.push(`dir:${fs.statSync(project.path).mtimeMs}`);
  } catch {
    parts.push('dir:0');
  }
  return parts.join('|');
}

function rootSignature(scanDir, projects) {
  let sig = '';
  try {
    sig = `root:${fs.statSync(scanDir).mtimeMs}`;
  } catch {
    sig = 'root:0';
  }
  const projectParts = (projects || []).map(projectSignature).join('||');
  return `${sig}|${projectParts}`;
}

/** Cache lookup, D-2 stale-while-revalidate aware. Returns `{ projects, fresh }` —
 *  `fresh: true` inside the normal TTL, `fresh: false` when the TTL has passed but the
 *  signature still matches and we're within the grace window (safe to serve immediately
 *  while the caller kicks off a background refresh). Returns null when there's no entry,
 *  the signature no longer matches (a real change — never serve this stale regardless of
 *  age), or the grace window has also elapsed (true cold miss, caller must block on a fresh
 *  scan). The signature check runs before the age check on purpose: a real edit invalidates
 *  the entry immediately, it doesn't get a grace-window reprieve just because it's recent. */
export function getCachedScanStale(scanDir, includeAll) {
  const key = cacheKey(scanDir, includeAll);
  const entry = entries.get(key);
  if (!entry) return null;
  if (rootSignature(scanDir, entry.projects) !== entry.signature) {
    entries.delete(key);
    return null;
  }
  const age = Date.now() - entry.scannedAt;
  if (age <= SCAN_CACHE_TTL_MS) return { projects: entry.projects, fresh: true };
  if (age <= SCAN_CACHE_TTL_MS + SCAN_CACHE_STALE_GRACE_MS) return { projects: entry.projects, fresh: false };
  entries.delete(key);
  return null;
}

/** Marks/reads whether a background revalidation is already in flight for this root, so a
 *  burst of requests hitting the same stale entry (multi-tab poll, rapid tab switches)
 *  triggers exactly one re-scan instead of one per request. */
export function isRevalidating(scanDir, includeAll) {
  return entries.get(cacheKey(scanDir, includeAll))?.refreshing === true;
}

export function setRevalidating(scanDir, includeAll, value) {
  const entry = entries.get(cacheKey(scanDir, includeAll));
  if (entry) entry.refreshing = value;
}

/** Store a fresh whole-scan result. Callers must pass the array they also stored in the
 *  per-tab/global project caches so every view of the scan stays object-identical. */
export function setCachedScan(scanDir, includeAll, projects) {
  const key = cacheKey(scanDir, includeAll);
  entries.set(key, { projects, scannedAt: Date.now(), signature: rootSignature(scanDir, projects) });
  while (entries.size > SCAN_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    entries.delete(oldest);
  }
}

/** Drop every cached root that contains `changedPath` — used by the config-file watcher so a
 *  console.config.json change invalidates the cache immediately even when the signature
 *  check would also have caught it (belt-and-braces; the watcher already re-scans the one
 *  changed project in place, so the cache must not serve the pre-change array meanwhile). */
export function invalidateScanCacheForPath(changedPath) {
  const norm = path.resolve(changedPath).toLowerCase();
  for (const [key] of entries) {
    const root = cacheRoot(key);
    if (norm.startsWith(path.resolve(root).toLowerCase())) entries.delete(key);
  }
}