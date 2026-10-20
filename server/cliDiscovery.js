// Server discovery + resume-session lookup (2026-08-24, split out of cli-client.js). Pure
// fetch logic: find which port the server actually bound to, and resolve a --resume/--last
// session from the server's session index.

import fs from 'fs';
import { BASE_PORT, HOST, MAX_PORT_ATTEMPTS, CONNECT_TIMEOUT_MS, RETRY_INTERVAL_MS, WANT_LAST, RESUME_ID } from './cliOptions.js';
import { findConsolePingPort } from './portProbe.js';

export function stripMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/### /g, '');
}

// Phase I (2026-09-09): CLI auth cookie jar. Set once after the CLI login prompt (or
// left null on open servers); every fetch helper below attaches it, and cli-client.js
// reads it for the WS upgrade headers. Module state, same pattern as the file's other
// shared discovery state.
let cliAuthCookie = null;
export function setCliAuthCookie(cookie) {
  cliAuthCookie = cookie || null;
}
export function getCliAuthCookie() {
  return cliAuthCookie;
}
function authHeaders() {
  return cliAuthCookie ? { Cookie: cliAuthCookie } : {};
}

export async function tryFetchProjects(port) {
  try {
    // The SUMMARY form of the project list (id/name/path per project) — a few KB instead of
    // the ~2MB full document. The full response is built and serialized synchronously per
    // request, so using it as a discovery probe saturated the server's event loop when
    // several clients attached at once, and the clients then timed out and reported "Could
    // not connect" while the console was running (measured 2026-10-20).
    // 30s: the summary is fast, but the console may be busy with another turn.
    const res = await fetch(`http://${HOST}:${port}/api/projects?summary=1`, {
      signal: AbortSignal.timeout(30000),
      headers: authHeaders(),
    });
    // Phase I: an armed server answers 401 + { ok:false, error:'Login required.' } — that
    // is still a live console (see server/portProbe.js), so report the port as armed
    // instead of null; the CLI login flow follows. Anything else non-OK stays null.
    if (res.status === 401) {
      const data = await res.json().catch(() => null);
      if (data?.ok === false && data?.error === 'Login required.') {
        return { projects: [], port, armed: true };
      }
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    return { projects: data.projects || [], port };
  } catch {
    return null;
  }
}

/**
 * Probes every port in the range CONCURRENTLY and returns the result for the LOWEST port
 * that answered, or null when none did. The serial version this replaces cost one full
 * timeout per unresponsive port — with 20 ports a single hung port could stall a
 * discovery cycle for 100 seconds. Probing in parallel bounds a cycle by one timeout, and a
 * machine with every port closed still resolves in milliseconds because a closed localhost
 * port refuses the connection immediately.
 *
 * The heavy /api/projects document is only fetched for the ports that answered the cheap
 * /api/ping probe: fetching 2MB from every candidate would load the console for nothing.
 */
/**
 * Discovery trace (CONSOLE_CLI_TRACE=1): one line per discovery cycle on stderr, so a
 * "Could not connect" can be attributed to a step (no port answered / the project list did
 * not answer / the console answered) instead of guessed at.
 */
function traceDiscovery(message) {
  if (process.env.CONSOLE_CLI_TRACE !== '1') return;
  try { process.stderr.write(`[cli-trace] ${message}\n`); } catch { /* stderr closed */ }
}

async function findServerOnAnyPort() {
  const candidates = await findConsolePingPort(BASE_PORT, MAX_PORT_ATTEMPTS);
  if (candidates === null) {
    traceDiscovery(`no port answered the ping (${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1})`);
    return null;
  }
  // The ping found a live console; fetch its project list from THAT port only.
  //
  // There is deliberately no "fetch from every port" fallback any more: the full project
  // list is a heavy request (it can trigger a rescan of every project), and with several
  // clients discovering at once the fallback turned into a rescan storm — the console's
  // event loop was saturated by those scans, so even the cheap ping could not get a window
  // and the clients never attached (measured 2026-10-20: 2 of 5 concurrent launches died
  // with "Could not connect" while the console was serving the others).
  const result = await tryFetchProjects(candidates);
  if (result) {
    traceDiscovery(`attached to port ${candidates} (${result.projects.length} project(s))`);
    return result;
  }
  traceDiscovery(`ping answered on port ${candidates} but the project list did not — retrying`);
  return null;
}

/**
 * Finds which port the server actually bound to and waits out its startup time, instead of the
 * old single-shot fetch that failed instantly if the server wasn't listening yet on the exact
 * moment this ran (confirmed live: "npm run dev" starting via start.bat is not instant — route
 * registration, Vite middleware setup, and the embedding model used by semanticMatcher.js all
 * take real time) or if it had fallen back off BASE_PORT.
 */
export async function discoverServer(onCycle) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();
  let printedDots = false;
  while (Date.now() < deadline) {
    const result = await findServerOnAnyPort();
    if (result) {
      if (printedDots) process.stdout.write('\n');
      return result;
    }
    // TTY path: main() drives a @clack/prompts spinner via this callback; the non-TTY path
    // keeps the original dot-printing so piped/redirected output stays readable.
    if (onCycle) {
      onCycle(Math.floor((Date.now() - startedAt) / 1000));
    } else {
      process.stdout.write('.');
      printedDots = true;
    }
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }
  if (printedDots) process.stdout.write('\n');
  return null;
}

/**
 * Tail of the last server boot logs (repo-root server.log / server.err.log — start.bat's
 * Start-Process redirects land there; the 2026-09-03 rotation keeps the previous failed boot
 * in the .prev files). Printed when discovery fails so a server that died during boot
 * explains itself instead of a bare "could not connect". Read-only, never throws; the CLI's
 * cwd under start.bat is the repo root, so the relative paths resolve there.
 */
export function readBootLogTail(maxLines = 12) {
  const out = [];
  for (const name of ['server.err.log', 'server.log', 'server.err.log.prev', 'server.log.prev']) {
    try {
      if (!fs.existsSync(name)) continue;
      const text = fs.readFileSync(name, 'utf8');
      const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(-maxLines);
      if (lines.length) out.push(`--- ${name} (last ${lines.length} lines) ---`, ...lines);
    } catch {
      // unreadable log must never break the failure path
    }
  }
  return out;
}

/** Resolves the session a --resume/--last should continue, from the server's session index. */
export async function pickResumeSession(port) {
  let sessions = [];
  try {
    const res = await fetch(`http://${HOST}:${port}/api/sessions`, {
      signal: AbortSignal.timeout(8000),
      headers: authHeaders(),
    });
    if (res.ok) sessions = (await res.json()).sessions || [];
  } catch {
    return null;
  }
  if (WANT_LAST) {
    if (sessions.length === 0) return null;
    return [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  }
  return sessions.find((s) => s.id === RESUME_ID) || null;
}