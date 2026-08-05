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
