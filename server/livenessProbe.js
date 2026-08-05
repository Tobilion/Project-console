import { isProbeableUrl } from './urlSafety.js';
import { state } from './state.js';
import { recordDevUrl } from './devUrlStore.js';

// On-demand liveness probing for dev-server URLs. Runs ONLY when the user asks — nothing
// scans or polls in the background, so the system cost is zero unless a question triggers it.
// Same SSRF discipline as webSearch's external allowlist (reversed): only localhost/private
// http(s) URLs can ever be probed, never public sites or link-local metadata endpoints.

// Port hints recognized in package.json script strings (Vite/webpack/next/react-scripts/etc.).
// Deliberately narrow: explicit flags and env-prefix assignments only — never free text.
const PORT_HINT_RES = [
  /--port[= ](\d+)/i,
  /-p (\d+)/i,
  /(?:^|[;&])\s*PORT=(\d+)/i,
];

// Default dev-server ports for projects that give NO port hint at all (2026-08-05, reported
// directly — NetPulse is a pure-Python project with no package.json, so candidateDevUrls()
// returned zero candidates and a live server the console never spawned was never found).
// Ordered by popularity so the first 3 (the per-project cap) are the most likely hits:
// Node 3000, Vite 5173, Flask 5000, Django/Plane 8000, react-scripts 3001, 8080, 4400, 8888.
const COMMON_DEV_PORTS = [3000, 5173, 5000, 8000, 8001, 8080, 4400, 8888];

// A project's package.json scripts is the most-current source of run-command truth (see the
// 2026-08-03 ordering decision in CLAUDE.md), so a server started OUTSIDE the console that the
// console never observed can be discovered by probing the ports its own scripts reference.
export function candidateDevUrls(project) {
  const pkg = project?.codebaseIndex?.keyFiles?.['package.json'];
  const seen = new Set();
  const ports = [];
  const tryPort = (port) => {
    // The console itself listens on state.serverPort — probing it would always return 200
    // and falsely claim a project's site is up (SportSim Pro's vite --port=3000 collides
    // with the console's own default; see state.js's withPortCollisionWarning).
    if (Number.isInteger(port) && port > 0 && port <= 65535 && port !== state.serverPort && !seen.has(port)) {
      seen.add(port);
      ports.push(port);
      return true;
    }
    return false;
  };
  let parsed = null;
  if (pkg) {
    try {
      // readKeyFiles truncates at 2000 chars with a "\n... (truncated)" tail — strip before
      // parse, same as detectFrameworks/findTestCommand (a large package.json otherwise breaks).
      parsed = JSON.parse(pkg.replace(/\n\.\.\. \(truncated\)$/, ''));
    } catch {}
  }
  const scripts = parsed?.scripts;
  if (scripts && typeof scripts === 'object') {
    for (const value of Object.values(scripts)) {
      if (typeof value !== 'string') continue;
      for (const re of PORT_HINT_RES) {
        const m = value.match(re);
        if (m) {
          tryPort(Number(m[1]));
          if (ports.length >= 3) break;
        }
      }
      if (ports.length >= 3) break;
    }
  }
  // No port hints anywhere (no package.json, or scripts without --port/PORT=): fall back to
  // the common default dev-server ports so Python/other no-manifest projects can still be
  // found when a server the console never observed is genuinely live.
  if (ports.length === 0) {
    for (const port of COMMON_DEV_PORTS) {
      tryPort(port);
      if (ports.length >= 3) break;
    }
  }
  return ports.map((port) => `http://localhost:${port}`);
}

/**
 * One bounded HTTP probe. Returns { alive: true, status } or { alive: false, error }.
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function probeUrl(url, timeoutMs = 3000) {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    return { alive: false, error: `Not a valid URL: "${url}"` };
  }
  if (!isProbeableUrl(urlObj)) {
    return { alive: false, error: `Refusing to probe "${url}" — only localhost/private http(s) URLs are allowed.` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(urlObj.toString(), { method: 'GET', redirect: 'follow', signal: controller.signal });
    return { alive: true, status: res.status };
  } catch (err) {
    return { alive: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes the last-known dev URL of every project that has one, bounded by a per-URL timeout
 * and a small worker pool. Only projects WITH a recorded URL are ever touched — for a typical
 * console that's one or two, so a scan finishes in a couple of seconds.
 *
 * Projects WITHOUT a recorded URL get a cheap best-effort pass instead (2026-08-04, reported
 * directly): their package.json scripts are inspected for port hints (vite --port=N etc.) and
 * the resulting candidate ports are probed with a shorter timeout, up to a global cap — this
 * is what lets "scan for servers" find a server the user started outside the console that the
 * console never observed. A candidate that answers is recorded via devUrlStore so later "what
 * is the link"/status questions know it too.
 * @param {Array<{id: string, name: string}>} projects
 * @returns {Promise<Array<{projectId, projectName, url, alive, status, viaCandidate}>>}
 */
export async function scanProjectServers(projects, { timeoutMs = 2000, concurrency = 3, candidateTimeoutMs = 1000, maxCandidates = 10 } = {}) {
  const recorded = [];
  const candidateTargets = [];
  let candidateBudget = maxCandidates;
  for (const project of projects) {
    const url = state.lastDevUrls.get(project.id);
    if (url) {
      recorded.push({ project, url });
    } else if (candidateBudget > 0) {
      const candidates = candidateDevUrls(project).slice(0, candidateBudget);
      candidateBudget -= candidates.length;
      for (const candidate of candidates) candidateTargets.push({ project, url: candidate });
    }
  }
  const results = [];
  let recIdx = 0;
  let candIdx = 0;
  async function worker() {
    while (recIdx < recorded.length) {
      const { project, url } = recorded[recIdx++];
      const probe = await probeUrl(url, timeoutMs);
      results.push({
        projectId: project.id,
        projectName: project.name,
        url,
        alive: probe.alive,
        status: probe.status ?? null,
        viaCandidate: false,
      });
    }
  }
  async function candidateWorker() {
    while (candIdx < candidateTargets.length) {
      const target = candidateTargets[candIdx++];
      const probe = await probeUrl(target.url, candidateTimeoutMs);
      if (probe.alive) recordDevUrl(target.project.id, target.url);
      results.push({
        projectId: target.project.id,
        projectName: target.project.name,
        url: target.url,
        alive: probe.alive,
        status: probe.status ?? null,
        viaCandidate: true,
      });
    }
  }
  await Promise.all([
    ...Array.from({ length: Math.min(concurrency, recorded.length) }, worker),
    ...Array.from({ length: Math.min(concurrency, candidateTargets.length) }, candidateWorker),
  ]);
  return results;
}
