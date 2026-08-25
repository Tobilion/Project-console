// Server discovery + resume-session lookup (2026-08-24, split out of cli-client.js). Pure
// fetch logic: find which port the server actually bound to, and resolve a --resume/--last
// session from the server's session index.

import { BASE_PORT, HOST, MAX_PORT_ATTEMPTS, CONNECT_TIMEOUT_MS, RETRY_INTERVAL_MS, WANT_LAST, RESUME_ID } from './cliOptions.js';

export function stripMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/### /g, '');
}

export async function tryFetchProjects(port) {
  try {
    // 5s, not 2s: measured live 2026-08-10 — this machine's /api/projects takes ~1.7s on a
    // freshly booted server (project discovery rescans 15 folders), so a 2s abort fired on
    // most retry cycles and the CLI reported "could not connect" against a healthy server.
    const res = await fetch(`http://${HOST}:${port}/api/projects`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return { projects: data.projects || [], port };
  } catch {
    return null;
  }
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
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const result = await tryFetchProjects(BASE_PORT + i);
      if (result) {
        if (printedDots) process.stdout.write('\n');
        return result;
      }
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

/** Resolves the session a --resume/--last should continue, from the server's session index. */
export async function pickResumeSession(port) {
  let sessions = [];
  try {
    const res = await fetch(`http://${HOST}:${port}/api/sessions`, { signal: AbortSignal.timeout(8000) });
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