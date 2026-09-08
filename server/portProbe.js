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
 */
export async function probeConsolePort(port, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.projects) ? port : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Scans `basePort .. basePort + maxAttempts - 1` and returns the first port that answers
 *  as a running console, or `null` if none does. */
export async function findRunningConsole(basePort, maxAttempts, timeoutMs = 5000) {
  for (let port = basePort; port < basePort + maxAttempts; port++) {
    const found = await probeConsolePort(port, timeoutMs);
    if (found) return found;
  }
  return null;
}
