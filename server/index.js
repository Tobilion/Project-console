import express from 'express';
import compression from 'compression';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';

import { discoverProjects } from './projectScanner.js';
import { nlpEngine } from './nlpEngine.js';
import { semanticMatcher } from './semanticMatcher.js';
import { watchProjectConfigs } from './fileWatcher.js';
import { setupMockProjectsIfMissing } from './mockProjects.js';
import { state, projectsMutex } from './state.js';
import { autoApplyThresholdsForAll } from './intentTelemetry.js';
import { retrainConfidenceModel } from './confidenceModel.js';
import { autoApplySuggestionsForAll } from './learningEngine.js';
import { loadLearnedIntents } from './learnedIntents.js';
import { loadDevUrls } from './devUrlStore.js';
import { initScheduler } from './schedules/scheduler.js';
import { initNotifications } from './notify.js';
import { loadAutoStart, initAutoStart } from './autoStartProjects.js';
import { checkCollisionBaseline } from './collisions.js';
import { checkForUpdates } from './updateChecker.js';
import { wss, broadcast } from './wsServer.js';
import { initWebSocketServer } from './wsHandlers/connection.js';
import { registerProjectRoutes } from './routes/projectRoutes.js';
import { registerSessionRoutes } from './routes/sessionRoutes.js';
import { registerSearchRoutes } from './routes/searchRoutes.js';
import { registerMonitoringRoutes } from './routes/monitoringRoutes.js';
import { registerProfileRoutes } from './routes/profileRoutes.js';
import { registerTuningRoutes } from './routes/tuningRoutes.js';
import { registerWorkspaceRoutes } from './routes/workspaceRoutes.js';
import { registerToolPanelRoutes } from './routes/toolPanelRoutes.js';
import { registerPdfRoutes } from './routes/pdfRoutes.js';
import { registerReminderRoutes } from './routes/reminderRoutes.js';
import { registerFileToolsRoutes } from './routes/fileToolsRoutes.js';
import { registerNoteRoutes } from './routes/noteRoutes.js';
import { registerCsvRoutes } from './routes/csvRoutes.js';
import { loadTuning } from './tuningStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
// Binds to localhost only by default — this server can execute arbitrary shell commands
// and (with AI mode on) read/write files, so it should not be reachable from the LAN
// unless you explicitly opt in via HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';

app.use(compression());
app.use(express.json());

registerProjectRoutes(app, __dirname);
registerSessionRoutes(app);
registerSearchRoutes(app);
registerMonitoringRoutes(app);
registerProfileRoutes(app);
registerTuningRoutes(app);
registerWorkspaceRoutes(app);
registerToolPanelRoutes(app);
registerPdfRoutes(app);
registerReminderRoutes(app);
registerFileToolsRoutes(app);
registerNoteRoutes(app);
registerCsvRoutes(app);
// Tuning overrides (data/tuning.json) must be in memory before any consumer reads a knob —
// the first Fuse build happens during semanticMatcher.initialize() a few lines below.
loadTuning();

initWebSocketServer();

// Created once up front (rather than implicitly via app.listen()) so it can be handed to Vite's
// dev server below — Vite needs the actual http.Server instance to attach its own HMR websocket
// upgrade listener to when running in middlewareMode on the same port. Without this, Vite's
// client never gets a live HMR connection, so the *only* recovery path the browser has after any
// transient client-side hiccup is a hard full-page reload instead of an in-place patch — which
// looks exactly like "the whole page goes white and reloads" from a user's perspective.
const httpServer = http.createServer(app);

async function init() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
        // Vite's own file watcher (chokidar) watches the whole project root by default, which
        // includes `data/` — this app's own runtime-written state (conversation index,
        // near-miss logs, telemetry, distillation records). Every session created / message
        // sent / command run rewrites one of those JSON files, and before the HMR websocket fix
        // above, Vite's resulting "full reload" signal silently failed to reach the browser (so
        // this went unnoticed). Now that HMR actually works, without this exclusion *any* of
        // those writes would force a full-page reload — which looked exactly like "clicking New
        // Chat makes the page go white and reload," since creating a session is one of the things
        // that writes to `data/conversations/index.json`.
        watch: { ignored: ['**/data/**', '**/.cache/**', '**/*.console/**'] },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = __dirname;
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/stream')) return next();
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Discover projects and train NLP once, before accepting connections
  const dirToScan = setupMockProjectsIfMissing(state.currentScanDirectory, __dirname);
  await projectsMutex.runExclusive(async () => {
    state.activeProjectsCache = await discoverProjects(dirToScan);
  });
  await nlpEngine.train(state.activeProjectsCache);
  console.log(`NLP training complete. ${state.activeProjectsCache.length} project(s) loaded.`);

  // Restore any phrases learned (and confirmed) in previous runs before the semantic matcher
  // builds its embeddings, so restarts don't silently forget cross-project learning.
  loadLearnedIntents();

  // Restore last-known dev-server URLs so "is the server running" can probe servers that were
  // started outside the console or before this restart.
  loadDevUrls();

  // Phase 1: restore persisted schedules and start the scheduler tick (loadSchedules runs
  // before any connection can create a schedule; activeProjectsCache is populated above).
  initScheduler();

  // Phase 2: restore notification rules and register the taskQueue completion hook. Rules load
  // before any connection arrives, and defaults are all-off, so this is a no-op until the user
  // opts in via the notify/admin commands.
  initNotifications();

  // Initialize semantic matcher (embedding + Fuse.js)
  await semanticMatcher.initialize().catch((err) => console.error('SemanticMatcher init failed:', err.message));
  semanticMatcher.addProjectIntents(state.activeProjectsCache).catch(() => {});

  // Phase 7: restore auto-start config and schedule boot-time runs (needs the matcher above
  // for its launch-phrase re-match; loadAutoStart runs before any connection can configure).
  loadAutoStart();
  initAutoStart();

  // Phase 7: baseline intent-collision sweep — fire-and-forget, never blocks boot. Alerts
  // via the opt-in 'collision-found' notification event when new overlaps appeared since
  // the previous boot (needs initNotifications' rules loaded above, hence its position).
  checkCollisionBaseline().catch(() => {});

  // Phase 5: bounded, non-blocking npm-registry version check — fire-and-forget, 4s timeout,
  // silent on any failure (offline-first). The result feeds the once-per-boot update banner
  // (takeUpdateNotice in connectionLifecycle.js) and the `check for updates` admin command.
  checkForUpdates(false).catch(() => {});

  // Start file watcher for console.config.json changes
  try {
    if (fs.existsSync(dirToScan)) {
      watchProjectConfigs(dirToScan, async (updated, isNew, removedName) => {
        await projectsMutex.runExclusive(async () => {
          if (removedName) {
            state.activeProjectsCache = state.activeProjectsCache.filter((p) => p.folderName !== removedName);
          } else if (isNew) {
            const existing = state.activeProjectsCache.findIndex((p) => p.id === updated.id);
            if (existing >= 0) state.activeProjectsCache[existing] = updated;
            else state.activeProjectsCache.push(updated);
          } else {
            const idx = state.activeProjectsCache.findIndex((p) => p.id === updated.id);
            if (idx >= 0) state.activeProjectsCache[idx] = updated;
          }
        });
        nlpEngine.train(state.activeProjectsCache).catch(() => {});
        semanticMatcher.clearProjectIntents().catch(() => {});
        semanticMatcher.addProjectIntents(state.activeProjectsCache).catch(() => {});
        broadcast({ type: 'projects_updated', data: state.activeProjectsCache });
      });
      console.log('File watcher active for console.config.json changes.');
    }
  } catch (err) {
    console.error('File watcher failed to start:', err.message);
  }

  // Stage 1 ML work (2026-07-29, requested directly): retrain the learned confidence model from
  // every project's accept/reject telemetry before the threshold auto-apply sweep below runs, so
  // that sweep uses the freshest learned floor (see confidenceModel.js / intentTelemetry.js's
  // suggestThresholds()) rather than whatever was cached from the last server run. Below
  // MIN_LABELED examples this is a fast no-op and the sweep falls back to the original heuristic,
  // so a fresh install / low-usage project sees zero behavior change from this.
  // The whole retrain must not take the server down on a write failure (read-only data/,
  // disk full) — a failed startup sweep is logged and skipped, not fatal.
  try {
    const modelResult = retrainConfidenceModel();
    if (modelResult.trained) {
      console.log(`Confidence model retrained from ${modelResult.sampleCount} labeled outcomes.`);
    }
  } catch (err) {
    console.error('Confidence model retrain failed (non-fatal):', err.message);
  }

  // Auto-apply telemetry-based threshold adjustments on startup
  const autoResults = autoApplyThresholdsForAll();
  if (autoResults.length > 0) {
    console.log(`Auto-applied threshold adjustments for ${autoResults.length} project(s):`);
    for (const r of autoResults) {
      console.log(`  ${r.projectId}: ${r.applied} adjustment(s)`);
    }
  }

  // Auto-promote high-confidence near-miss patterns (5+ occurrences, >=80% acceptance) into
  // real intent examples on startup, instead of requiring a manual `review learning` +
  // `approve suggestions` round trip for patterns the engine is already sure about.
  try {
    const learningResults = autoApplySuggestionsForAll();
    if (learningResults.length > 0) {
      console.log(`Auto-applied near-miss learning for ${learningResults.length} project(s):`);
      for (const r of learningResults) {
        console.log(`  ${r.projectId}: ${r.applied}/${r.total} suggestion(s) promoted`);
      }
    }
  } catch (err) {
    console.error('Auto-apply near-miss learning failed (non-fatal):', err.message);
  }

  // Port fallback: try PORT through PORT+10 like start.bat does. Reuses the single `httpServer`
  // created above (rather than a fresh server per attempt) so Vite's HMR upgrade listener,
  // already attached to it, stays valid once we actually bind.
  const MAX_PORT_ATTEMPTS = 10;
  let server = null;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const tryPort = PORT + attempt;
    try {
      await new Promise((resolve, reject) => {
        const onListening = () => {
          httpServer.removeListener('error', onError);
          state.serverPort = tryPort;
          globalThis.__consoleServerPort = tryPort;
          console.log(`Console Server running on http://${HOST}:${tryPort}`);
          console.log(`Default scan path: ${state.currentScanDirectory}`);
          if (HOST === '0.0.0.0') {
            console.log('WARNING: bound to 0.0.0.0 — reachable from your LAN. This server can run shell commands with no authentication.');
          }
          resolve();
        };
        const onError = (err) => {
          httpServer.removeListener('listening', onListening);
          if (err.code === 'EADDRINUSE') {
            console.log(`Port ${tryPort} in use, trying ${tryPort + 1}...`);
          }
          reject(err);
        };
        httpServer.once('listening', onListening);
        httpServer.once('error', onError);
        httpServer.listen(tryPort, HOST);
      });
      server = httpServer;
      break; // succeeded
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= MAX_PORT_ATTEMPTS - 1) {
        console.error(`Failed to start server: ${err.message}`);
        process.exit(1);
      }
      // continue to next port — httpServer isn't listening yet, so it's safe to retry .listen()
    }
  }

  if (server) {
    // Sockets that error while the upgrade/request handshake is still in flight (a client that
    // connected then vanished mid-upgrade, an abrupt ECONNRESET) surface as 'error' on the
    // httpServer itself, not on any ws client object — the listen-loop's temporary error listener
    // was removed after binding, so without a permanent one this event crashes the whole server.
    // Observed live: killing a WS test client mid-connection took the console down.
    server.on('error', (err) => {
      console.error('HTTP server error (non-fatal, connection dropped):', err.message);
    });
    server.on('upgrade', (request, socket, head) => {
      // Sockets that arrive via 'upgrade' leave the http server's normal per-connection error
      // handling — if no listener accepts the upgrade (this listener's pathname check, Vite's
      // HMR listener, or a client that died mid-handshake), the socket emits 'error' with no
      // listener attached, which crashes the whole process (observed live twice: a WS client
      // that connected to a non-/stream path and was then killed took the console down).
      socket.on('error', () => {});
      // Origin check: only allow connections from the local server itself
      const origin = request.headers.origin;
      if (origin && !origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
        socket.destroy();
        return;
      }
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
      if (pathname === '/stream' || pathname === '/stream/') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
      // Anything else (notably Vite's own HMR websocket, which registers its own 'upgrade'
      // listener on this same httpServer via `hmr: { server: httpServer }` above) is left alone
      // instead of being unconditionally destroyed — this used to kill Vite's HMR socket, so the
      // dev client had no live-reload path and fell back to a full page reload on any hiccup.
    });
  }
}

// Process-level safety net: a rejected promise that slips past every `.catch` (an async route
// handler missed by asyncHandler, a callback inside a library we don't control, init() itself)
// would otherwise terminate the whole console via Node's default unhandledRejection=throw —
// the same crash class as the HTTP/upgrade socket errors above. Log and keep serving; the
// console is a single-user local tool whose in-flight state survives individual failures.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (non-fatal, state preserved):', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (non-fatal, state preserved):', err.stack);
});

// A rejection inside init() (discoverProjects, NLP training, watcher setup) used to be absorbed
// by the unhandledRejection handler above, leaving a live process with NO HTTP listener — the
// CLI client retries for 90s and gives up, the daemon scripts report a live process, and it
// looks like a hung app instead of a crash (audit 2026-08-06, Phase 2). Fail loudly instead:
// the listen loop only ever ran at the end of init(), so there's nothing worth preserving.
init().catch((err) => {
  console.error('Fatal init failure:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
