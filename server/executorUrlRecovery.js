// Post-detach dev-URL recovery (2026-08-24, split out of executor.js — same concern, single
// module). Fire-and-forget fallback for a dev server that detached without printing a URL
// (2026-08-18, Matchday Exchange: vite's "Local:" banner arrived after the 10s force-detach on
// a loaded machine, and detach() used to drop every stdout listener, so the URL was lost
// forever — no recordDevUrl, no server_url event, no Live Sites row or open-site chip). The
// stdout data handler now stays attached post-detach and scans for late banners; this probe
// covers servers that NEVER print a URL at all (or print it to a stream we can't see).
//
// Probes the project's candidate ports (package.json --port hints first, COMMON_DEV_PORTS
// fallback — see candidateDevUrls), bounded: one delay + up to 3 candidates at ~1s each, never
// blocks the turn. A hit is recorded through the SAME path as live URL detection (recordDevUrl
// + server_url event + broadcasts), so Live Sites and the click-chip light up for servers the
// force-detach window missed. The server_url event also posts a chat bubble, matching what the
// user would have seen had the banner been caught in time.

import { recordDevUrl } from './devUrlStore.js';
import { state, allKnownProjects } from './state.js';
import { probeUrl, candidateDevUrls } from './livenessProbe.js';
import { broadcast } from './wsServer.js';
import {
  DEV_URL_RECOVERY_PROBE_DELAY_MS,
  DEV_URL_RECOVERY_PROBE_TIMEOUT_MS,
  DEV_URL_RECOVERY_MAX_CANDIDATES,
} from './executorConstants.js';

export async function recoverDevUrlAfterDetach(projectId, ws) {
  try {
    const project = allKnownProjects().find((p) => p.id === projectId);
    if (!project) return;
    const candidates = candidateDevUrls(project).slice(0, DEV_URL_RECOVERY_MAX_CANDIDATES);
    if (candidates.length === 0) return;
    // Give a slow cold start a moment to finish binding before probing.
    await new Promise((r) => setTimeout(r, DEV_URL_RECOVERY_PROBE_DELAY_MS));
    // The stdout URL scan (kept alive after detach) may have caught the banner meanwhile —
    // or the user stopped the process — so re-check between probes. Deliberately NO
    // runningProcesses guard here: the Windows npm wrapper can close early (removing the
    // tracked entry in the close handler) while the real server keeps serving — this probe
    // is that server's only chance to be discovered (same philosophy as connectionDevServer's
    // on-demand candidate scan for servers started outside the console).
    if (state.lastDevUrls.has(projectId)) return;
    for (const url of candidates) {
      if (state.lastDevUrls.has(projectId)) return;
      const probe = await probeUrl(url, DEV_URL_RECOVERY_PROBE_TIMEOUT_MS);
      if (probe.alive) {
        recordDevUrl(projectId, url);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'server_url', data: url }));
        }
        broadcast({ type: 'dashboard_update' });
        broadcast({ type: 'processes_update' });
        return;
      }
    }
  } catch {
    // Best-effort recovery — never crash the turn it runs behind.
  }
}