// Phase 12 leaf: dev-server detection + detach message builder for executor.js (verbatim moves).

import { state, withPortCollisionWarning } from './state.js';

// Patterns that indicate a long-running dev server — we auto-detach after URL / timeout
const DEV_SERVER_PATTERNS = [
  /npx serve/i,
  /python -m http\.server/i,
  /npm run (dev|start|serve)/i,
  /vite/i,
  /tsx (dev|serve)/i,
  /next dev/i,
  /astro dev/i,
  /node (server|app|index|main)\./i,
];

export function isDevServerCommand(command) {
  return DEV_SERVER_PATTERNS.some(p => p.test(command));
}

/**
 * Site-shaped commands for STOP SCOPING (2026-10-18). Deliberately stricter than
 * DEV_SERVER_PATTERNS above: the `serve` alternative there is unanchored, so `npm run server` —
 * the commonest BACKEND script name — counts as a dev server. That looseness is harmless for the
 * force-detach timer (a `npm run server` really is long-running, so the shorter deadline is
 * right), but it is wrong for "which process did the user mean": it classifies the backend as the
 * site, so "stop the api" matches nothing, falls back to every process, and kills the site too —
 * reintroducing the exact bug this scoping exists to fix. Every pattern here is word-bounded so
 * `serve` never matches `server`, and `npm run dev` / `npm run start` / `npm run serve` stay
 * site-shaped.
 */
const SITE_COMMAND_PATTERNS = [
  /npx serve\b/i,
  /python -m http\.server\b/i,
  /npm run (?:dev|start|serve)\b/i,
  /\bvite\b/i,
  /tsx (?:dev|serve)\b/i,
  /next dev\b/i,
  /astro dev\b/i,
  /node (?:server|app|index|main)\./i,
];

export function isSiteCommand(command) {
  return SITE_COMMAND_PATTERNS.some(p => p.test(command));
}

/**
 * Builds the "still running" detach message and its metadata. The label only says "Dev server"
 * when there's actually a detected URL or the command matched a known dev-server pattern —
 * something like a watch loop with no URL at all gets the neutral "This command" phrasing
 * (see the force-detach comment in executor.js for why this matters).
 */
export function buildDetachMessage(projectId, isDev) {
  const detachedUrl = state.lastDevUrls.get(projectId);
  const label = (isDev || detachedUrl) ? 'Dev server' : 'This command';
  return {
    text: withPortCollisionWarning(
      `\n${label} is still running${detachedUrl ? ` at ${detachedUrl}` : ' in the background'} — you can keep chatting. Use "stop server" to shut it down.\n`,
      detachedUrl
    ),
    url: detachedUrl,
    devServer: isDev || !!detachedUrl,
  };
}
