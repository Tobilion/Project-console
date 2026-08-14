// Phase 5 (2026-08-11): self-update lifecycle — bounded, non-blocking npm-registry version
// check. The console is offline-first: EVERY failure path returns null and stays silent, so a
// machine without internet never sees an error from this module. The check runs once at boot
// (see server/index.js init) and again on demand via `check for updates`; the result is cached
// in-process so nothing re-hits the network per request.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The package root is one level up from this module both in dev (server/) and in the esbuild
// bundle (dist/) — process.cwd() is NOT reliable here because `npx local-project-console` runs
// with the user's cwd, not the package's install directory.
const PACKAGE_JSON = path.join(path.resolve(__dirname, '..'), 'package.json');

const CHECK_TIMEOUT_MS = 4000;

let cachedResult = null; // { current, latest, available } or null when the last check failed
let noticeSent = false; // the boot notice goes to exactly one connection per boot

function readPackageInfo() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));
    return {
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null,
    };
  } catch {
    return null;
  }
}

// Numeric segment compare — "1.0.10" must beat "1.0.2" (plain string compare gets this wrong).
function isNewerVersion(latest, current) {
  const a = String(latest).split('.');
  const b = String(current).split('.');
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const an = parseInt(a[i], 10) || 0;
    const bn = parseInt(b[i], 10) || 0;
    if (an !== bn) return an > bn;
  }
  return false;
}

/**
 * Checks the npm registry for the latest published version of this package. Returns
 * { current, latest, available } on success, null on ANY failure (offline, timeout,
 * non-200, unparseable registry payload, missing local package.json). Cached: a second
 * call with force=false returns the last result without touching the network.
 */
export async function checkForUpdates(force = false) {
  if (cachedResult && !force) return cachedResult;
  try {
    const pkg = readPackageInfo();
    if (!pkg?.name || !pkg.version) {
      cachedResult = null;
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      cachedResult = null;
      return null;
    }
    const data = await res.json();
    const latest = typeof data?.version === 'string' ? data.version : null;
    if (!latest) {
      cachedResult = null;
      return null;
    }
    cachedResult = { current: pkg.version, latest, available: isNewerVersion(latest, pkg.version) };
    return cachedResult;
  } catch {
    // fetch threw (DNS/offline/abort) — silent by design.
    cachedResult = null;
    return null;
  }
}

/**
 * The once-per-boot update notice: returns { current, latest } the first time it's called
 * after a successful check that found a newer version, null on every later call. Consumed by
 * the WS connect path (connectionLifecycle.js) so the banner appears for one connection only.
 */
export function takeUpdateNotice() {
  if (noticeSent || !cachedResult?.available) return null;
  noticeSent = true;
  return { current: cachedResult.current, latest: cachedResult.latest };
}
