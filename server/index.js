import express from 'express';
import compression from 'compression';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { discoverProjects } from './projectScanner.js';
import { nlpEngine } from './nlpEngine.js';
import { semanticMatcher } from './semanticMatcher.js';
import { watchProjectConfigs } from './fileWatcher.js';
import { setupMockProjectsIfMissing } from './mockProjects.js';
import { state, projectsMutex, dedupeProjectIds } from './state.js';
import { autoApplyThresholdsForAll } from './intentTelemetry.js';
import { retrainConfidenceModel } from './confidenceModel.js';
import { autoApplySuggestionsForAll } from './learningEngine.js';
import { loadLearnedIntents } from './learnedIntents.js';
import { loadDevUrls } from './devUrlStore.js';
import { initScheduler } from './schedules/scheduler.js';
import { initNotifications } from './notify.js';
import { loadAutoStart, initAutoStart } from './autoStartProjects.js';
import { syncClipboardPolling } from './clipboardHistory.js';
import { loadWatchRules } from './watchRules.js';
import { initWatchRules } from './watchEngine.js';
import { checkCollisionBaseline } from './collisions.js';
import { checkForUpdates } from './updateChecker.js';
import { wss, broadcast } from './wsServer.js';
import { initWebSocketServer } from './wsHandlers/connection.js';
import { registerProjectRoutes } from './routes/projectRoutes.js';
import { registerSessionRoutes } from './routes/sessionRoutes.js';
import { registerSearchRoutes } from './routes/searchRoutes.js';
import { registerMonitoringRoutes } from './routes/monitoringRoutes.js';
import { registerProfileRoutes, readProfile } from './routes/profileRoutes.js';
import { registerTuningRoutes } from './routes/tuningRoutes.js';
import { registerWorkspaceRoutes } from './routes/workspaceRoutes.js';
import { registerToolPanelRoutes } from './routes/toolPanelRoutes.js';
import { registerPdfRoutes } from './routes/pdfRoutes.js';
import { registerReminderRoutes } from './routes/reminderRoutes.js';
import { registerFileToolsRoutes } from './routes/fileToolsRoutes.js';
import { registerNoteRoutes } from './routes/noteRoutes.js';
import { registerCsvRoutes } from './routes/csvRoutes.js';
import { registerClipboardRoutes } from './routes/clipboardRoutes.js';
import { registerCalculateRoutes } from './routes/calculateRoutes.js';
import { registerBackupRoutes } from './routes/backupRoutes.js';
import { registerCommandDocsRoutes } from './routes/commandDocsRoutes.js';
import { registerNotificationsRoutes } from './routes/notificationsRoutes.js';
import { registerKnowledgeRoutes } from './routes/knowledgeRoutes.js';
import { registerMarketplaceRoutes } from './routes/marketplaceRoutes.js';
import { registerConnectedUsersRoutes } from './routes/connectedUsersRoutes.js';
import { registerBrowseRoutes } from './routes/browseRoutes.js';
import { registerEditorRoutes } from './routes/editorRoutes.js';
import { syncProjectWatchers } from './codeIndex/codeIndexBuilder.js';
import { loadTuning } from './tuningStore.js';
import { loadEditors } from './editorsStore.js';
import { setCachedScan, invalidateScanCacheForPath } from './scanCache.js';
import { log } from './logger.js';

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
registerClipboardRoutes(app);
registerCalculateRoutes(app);
registerBackupRoutes(app);
registerCommandDocsRoutes(app);
registerNotificationsRoutes(app);
registerKnowledgeRoutes(app);
registerMarketplaceRoutes(app);
registerConnectedUsersRoutes(app);
registerBrowseRoutes(app);
registerEditorRoutes(app);
// Final error middleware: a rejection that slips past asyncHandler (or a throw inside a sync
// handler) used to bypass Express entirely — the request never got a response and the client
// hung (see asyncHandler.js). Any async route handler wrapped with asyncHandler lands here;
// respond with JSON instead of Express's default HTML stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  log.error(`Route error (${req.method} ${req.path}):`, err?.stack || err);
  res.status(500).json({ error: err?.message || 'Server error.' });
});
// Tuning overrides (data/tuning.json) must be in memory before any consumer reads a knob —
// the first Fuse build happens during semanticMatcher.initialize() a few lines below.
loadTuning();
// Editor/IDE registry (data/editors.json) — loaded before any open_with dispatch.
loadEditors();

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
    // vite is a dev-only dependency (never staged into the packaged app's production
    // node_modules — npm ci --omit=dev skips it even when listed in both sections). It is
    // imported dynamically HERE, inside the dev branch, because a static top-level import
    // crashed the packaged server at module load: ERR_MODULE_NOT_FOUND "Cannot find package
    // 'vite'" from resources/server/index.js on the installed app (2026-08-25, P0).
    const { createServer: createViteServer } = await import('vite');
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
        // that writes to `data/conversations/index.json`. Phase 6: `logs/` (daemon + schedule
        // logs), `*.pid` (server.pid), and `dist/` (the shadowing bundle) are runtime
        // artifacts too — keep this list in sync with vite.config.ts.
        watch: { ignored: ['**/data/**', '**/.cache/**', '**/*.console/**', '**/logs/**', '**/*.pid', '**/dist/**'] },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production the frontend is served from __dirname when running as
    // server/index.js (dev source or staged server/), but the esbuild bundle
    // lives at dist/server.js — its __dirname is `dist`, which has no
    // index.html (the built frontend is at `server/` next to it). Resolve to
    // the correct static root regardless of entry point.
    const candidatePaths = [
      __dirname,
      path.resolve(__dirname, '..', 'server'),
      path.resolve(__dirname, 'server'),
    ];
    const distPath = candidatePaths.find((p) => fs.existsSync(path.join(p, 'index.html'))) || __dirname;
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/stream')) return next();
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Discover projects and train NLP once, before accepting connections
  const dirToScan = setupMockProjectsIfMissing(state.currentScanDirectory, __dirname);
  // Restore any phrases learned (and confirmed) in previous runs BEFORE the semantic matcher
  // builds its embeddings, so restarts don't silently forget cross-project learning. This
  // feeds the INTENTS corpus that initialize() embeds, so it must precede the parallel block
  // below (previously it ran after NLP training — moving it earlier is safe: nlpEngine trains
  // from its own seed intents + project config entries, never from learnedIntents).
  loadLearnedIntents();
  // Restore last-known dev-server URLs so "is the server running" can probe servers that were
  // started outside the console or before this restart. Independent of scan + matcher, loaded
  // in parallel with the two heavy boot steps below.
  loadDevUrls();

  // Phase 6 (2026-08-17): the project scan and the embedding-model load are the two slowest
  // boot steps and touch disjoint state (the scan writes the project cache under the projects
  // mutex; initialize() builds intent vectors + the Fuse index from INTENTS/learned intents).
  // Running them serially made every cold boot pay both back to back; run them concurrently.
  await Promise.all([
    projectsMutex.runExclusive(async () => {
      state.activeProjectsCache = dedupeProjectIds(await discoverProjects(dirToScan, { includeAll: readProfile().scanAllFolders }));
    }),
    semanticMatcher.initialize().catch((err) => log.error('SemanticMatcher init failed:', err.message)),
  ]);
  // Prime the whole-scan cache with the boot scan so the first GET /api/projects (web
  // load) hits instead of re-walking the container (scanCache.js, Phase 6).
  setCachedScan(dirToScan, readProfile().scanAllFolders, state.activeProjectsCache);
  // NLP classifier training and the project-intent embedding pass are independent of each
  // other (nlpEngine trains from NLP_SEED_INTENTS + project config entries; addProjectIntents
  // embeds the same entries through the matcher). Both need the scan result above, so they
  // join after the Promise.all instead of delaying it.
  await Promise.all([
    nlpEngine.train(state.activeProjectsCache),
    semanticMatcher.addProjectIntents(state.activeProjectsCache).catch((err) =>
      log.warn('Project-intent injection failed at boot (matching/AI context degraded):', err?.message || err)),
  ]);
  log.info(`NLP training complete. ${state.activeProjectsCache.length} project(s) loaded.`);

  // Phase 1: restore persisted schedules and start the scheduler tick (loadSchedules runs
  // before any connection can create a schedule; activeProjectsCache is populated above).
  initScheduler();

  // Phase 2: restore notification rules and register the taskQueue completion hook. Rules load
  // before any connection arrives, and defaults are all-off, so this is a no-op until the user
  // opts in via the notify/admin commands.
  initNotifications();

  // Phase 15: restore file-watch notification rules and attach their folder watchers.
  loadWatchRules();
  initWatchRules();

  // Phase 7: restore auto-start config and schedule boot-time runs (needs the matcher ready —
  // initialize() already finished in the parallel block above — for its launch-phrase re-match;
  // loadAutoStart runs before any connection can configure).
  loadAutoStart();
  initAutoStart();

  // Phase 8: sync clipboard polling with the profile (default off — no polling, no OS calls
  // until the user opts in via the profile modal).
  syncClipboardPolling();

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
        // Phase 6: drop any cached whole-scan that contains the changed project, so the
        // cache never serves the pre-change array while the watcher's own single-project
        // rescan already refreshed the live caches (belt-and-braces — the mtime signature
        // in scanCache.js would also catch the edit on the next read).
        if (removedName) invalidateScanCacheForPath(path.join(dirToScan, removedName));
        else if (updated) invalidateScanCacheForPath(updated.path);
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
        // Close code-index watchers for projects the config watcher just filtered out.
        syncProjectWatchers(state.activeProjectsCache);
        nlpEngine.train(state.activeProjectsCache).catch(() => {});
        semanticMatcher.clearProjectIntents().catch(() => {});
        semanticMatcher.addProjectIntents(state.activeProjectsCache).catch((err) =>
          log.warn('Project-intent refresh failed after config change:', err?.message || err));
        broadcast({ type: 'projects_updated', data: state.activeProjectsCache });
      });
      log.info('File watcher active for console.config.json changes.');
    }
  } catch (err) {
    log.error('File watcher failed to start:', err.message);
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
      log.info(`Confidence model retrained from ${modelResult.sampleCount} labeled outcomes.`);
    }
  } catch (err) {
    log.error('Confidence model retrain failed (non-fatal):', err.message);
  }

  // Auto-apply telemetry-based threshold adjustments on startup. Same non-fatal treatment as
  // the two sibling boot steps above — its write path (telemetryThresholds.js) can throw on a
  // read-only data/ directory, which must not turn a boot into a crash.
  try {
    const autoResults = autoApplyThresholdsForAll();
    if (autoResults.length > 0) {
      log.info(`Auto-applied threshold adjustments for ${autoResults.length} project(s):`);
      for (const r of autoResults) {
        log.info(`  ${r.projectId}: ${r.applied} adjustment(s)`);
      }
    }
  } catch (err) {
    log.error('Auto-apply threshold adjustments failed (non-fatal):', err.message);
  }

  // Auto-promote high-confidence near-miss patterns (5+ occurrences, >=80% acceptance) into
  // real intent examples on startup, instead of requiring a manual `review learning` +
  // `approve suggestions` round trip for patterns the engine is already sure about.
  try {
    const learningResults = autoApplySuggestionsForAll();
    if (learningResults.length > 0) {
      log.info(`Auto-applied near-miss learning for ${learningResults.length} project(s):`);
      for (const r of learningResults) {
        log.info(`  ${r.projectId}: ${r.applied}/${r.total} suggestion(s) promoted`);
      }
    }
  } catch (err) {
    log.error('Auto-apply near-miss learning failed (non-fatal):', err.message);
  }

  // Port fallback: try PORT through PORT+10 like start.bat does. Reuses the single `httpServer`
  // created above (rather than a fresh server per attempt) so Vite's HMR upgrade listener,
  // already attached to it, stays valid once we actually bind.
  const MAX_PORT_ATTEMPTS = 20; // 3000-3019 (widened 2026-08-26: a fully-occupied 3000-3009 is rare but not impossible)
  let server = null;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const tryPort = PORT + attempt;
    try {
      await new Promise((resolve, reject) => {
        const onListening = () => {
          httpServer.removeListener('error', onError);
          state.serverPort = tryPort;
          globalThis.__consoleServerPort = tryPort;
          log.info(`Console Server running on http://${HOST}:${tryPort}`);
          log.info(`Default scan path: ${state.currentScanDirectory}`);
          if (HOST === '0.0.0.0') {
            log.info('WARNING: bound to 0.0.0.0 — reachable from your LAN. This server can run shell commands with no authentication.');
          }
          resolve();
        };
        const onError = (err) => {
          httpServer.removeListener('listening', onListening);
          if (err.code === 'EADDRINUSE') {
            log.info(`Port ${tryPort} in use, trying ${tryPort + 1}...`);
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
        // The final EADDRINUSE gets a SPECIFIC message — a user with every port in the range
        // taken must see exactly that, not a generic bind error (2026-08-26). The desktop
        // shell captures this line via the child's stderr and surfaces it in its error page.
        const message =
          err.code === 'EADDRINUSE' && attempt >= MAX_PORT_ATTEMPTS - 1
            ? `No free port between ${PORT} and ${PORT + MAX_PORT_ATTEMPTS - 1} — every port in the range is in use. Close other apps using these ports and restart the console.`
            : err.message;
        log.error(`Failed to start server: ${message}`);
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
      log.error('HTTP server error (non-fatal, connection dropped):', err.message);
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
  const stack = reason instanceof Error ? reason.stack : String(reason);
  try { console.error('Unhandled promise rejection (non-fatal, state preserved):', stack); } catch {}
  log.error({ err: stack }, 'Unhandled promise rejection (non-fatal, state preserved)');
});
process.on('uncaughtException', (err) => {
  const stack = err instanceof Error ? err.stack : String(err);
  try { console.error('Uncaught exception (non-fatal, state preserved):', stack); } catch {}
  log.error({ err: stack }, 'Uncaught exception (non-fatal, state preserved)');
});

// A rejection inside init() (discoverProjects, NLP training, watcher setup) used to be absorbed
// by the unhandledRejection handler above, leaving a live process with NO HTTP listener — the
// CLI client retries for 90s and gives up, the daemon scripts report a live process, and it
// looks like a hung app instead of a crash (audit 2026-08-06, Phase 2). Fail loudly instead:
// the listen loop only ever ran at the end of init(), so there's nothing worth preserving.
init().catch((err) => {
  const stack = err instanceof Error ? err.stack : String(err);
  try { console.error('Fatal init failure:', stack); } catch {}
  log.error({ err: stack }, 'Fatal init failure');
  // Keep the legacy string-form log for any external grep, but the structured {err} form is
  // what pino actually serializes — the old `log.error('msg:', stack)` swallowed the stack
  // because pino treats the second string arg as a separate message, not a field (found live
  // 2026-08-27: desktop's 20s splash → "Fatal init failure:" with no stack hid the vite ENOENT).
  log.error('Fatal init failure:', stack);
  process.exit(1);
});
