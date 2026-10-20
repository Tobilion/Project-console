// Shared "is a console server already running on this port" check (Phase B.2 dedup,
// 2026-09-08). Three launch paths each need to answer the same question before deciding
// whether to start a new server or hand off to an existing one: bin/cli.js's W/C/Q menu,
// scripts/daemon.mjs's start command, and desktop/main.cjs's boot sequence. Before this
// module the loop and the "does this response actually look like our server" shape check
// were copy-pasted three times and had drifted: bin/cli.js additionally required
// `data.projects.length > 0`, so a freshly-scanned console with zero projects (a genuinely
// common state — a fresh install, or a scan root with nothing in it yet) was invisible to
// the CLI launcher's probe and a second, duplicate server would get started alongside it.
//
// desktop/main.cjs is CommonJS and boots before its own module graph can safely await a
// dynamic import of an ESM module on the hot path, so it keeps its own probePort()
// implementation rather than importing this file directly — that implementation must stay
// byte-for-byte equivalent to probeConsolePort() below (fetch /api/projects, treat anything
// but Array.isArray(data.projects) as "not our server", same timeout). Keep the two in sync
// by eye when either changes; this file is the source of truth for the contract.

/**
 * Probes one port for a running console server. Resolves to `port` when something answers
 * `/api/projects` with a body shaped like `{ projects: [...] }` (empty array included — a
 * console with no discovered projects yet is still a running console), or `null` otherwise
 * (connection refused, timeout, non-2xx, or a response from some unrelated local service).
 * Phase I (2026-09-09): an ARMED server (accounts exist) answers 401 +
 * `{ ok: false, error: 'Login required.' }` — that is still our server, so it resolves
 * the port too (otherwise launchers would start an open duplicate next to it).
 */
export async function probeConsolePort(port, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (Array.isArray(data?.projects)) return port;
    if (res.status === 401 && data?.ok === false && data?.error === 'Login required.') return port;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cheap liveness probe: asks a port for /api/ping, which answers with a couple of bytes.
 *
 * The /api/projects probe above is the AUTHORITATIVE "is this a console?" check (it
 * verifies the response shape), but it is also a ~2MB document that the server builds and
 * serializes on every request. Polling it in a wait loop saturates the console's event
 * loop — measured during the 2026-10-20 hardening pass: two waiting clients polling it
 * every 500ms made the console so slow that the clients' own discovery timed out with
 * "Could not connect" while the console was running. The ping is for POLLING; the projects
 * probe is for identifying.
 *
 * An ARMED console answers 401 + { ok:false, error:'Login required.' } — that is still our
 * server, so it counts as alive.
 */
export async function probeConsolePing(port, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: controller.signal });
    if (res.status === 401) return port; // armed console — still alive
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.ok === true ? port : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness probe that requires a READY console.
 *
 * The port is bound before the console finishes its boot (the matcher, the project scan and
 * the classifier load after the bind), so a console that answers /api/ping can still be
 * unable to answer a real request for several seconds. A client that attaches to that
 * console can then time out and report "Could not connect" while the console is right there
 * (measured 2026-10-20: 4 of 5 concurrent CLI launches died that way against a console
 * that was serving the fifth). `ready: true` is the console's own signal that it has
 * finished booting.
 */
export async function probeConsoleReady(port, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: controller.signal });
    if (res.status === 401) return port; // armed console — alive, and it is up
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data?.ok !== true) return null;
    return data.ready === false ? null : port;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Scans the range concurrently and returns the LOWEST port that answers the ping. */
export async function findConsolePingPort(basePort, maxAttempts, timeoutMs = 2000) {
  const ports = [];
  for (let port = basePort; port < basePort + maxAttempts; port++) ports.push(port);
  const results = await Promise.all(ports.map((port) => probeConsolePing(port, timeoutMs)));
  for (let i = 0; i < ports.length; i++) {
    if (results[i] !== null) return ports[i];
  }
  return null;
}

/** Scans the range concurrently and returns the LOWEST port whose console is READY (not
 *  merely bound). */
export async function findConsoleReadyPort(basePort, maxAttempts, timeoutMs = 2000) {
  const ports = [];
  for (let port = basePort; port < basePort + maxAttempts; port++) ports.push(port);
  const results = await Promise.all(ports.map((port) => probeConsoleReady(port, timeoutMs)));
  for (let i = 0; i < ports.length; i++) {
    if (results[i] !== null) return ports[i];
  }
  return null;
}

/** Scans `basePort .. basePort + maxAttempts - 1` and returns the first port that answers
 *  as a running console, or `null` if none does.
 *
 *  The ports are probed CONCURRENTLY, not one after the other. The serial version cost one
 *  full timeout per unresponsive port: with 20 ports and a 5s timeout a single hung port
 *  could burn 100s of a launcher's startup before it even decided whether a console was
 *  running, and the CLI paid that cost on every retry cycle. Probing in parallel bounds the
 *  whole scan by ONE timeout, and a machine where every port is closed still resolves in
 *  milliseconds (a closed localhost port refuses the connection immediately).
 *
 *  The "lowest answering port wins" contract is unchanged: the parallel results are read
 *  back in ascending port order and the first hit is returned. */
export async function findRunningConsole(basePort, maxAttempts, timeoutMs = 5000) {
  const ports = [];
  for (let port = basePort; port < basePort + maxAttempts; port++) ports.push(port);
  const results = await Promise.all(ports.map((port) => probeConsolePort(port, timeoutMs)));
  for (let i = 0; i < ports.length; i++) {
    if (results[i] !== null) return ports[i];
  }
  return null;
}
