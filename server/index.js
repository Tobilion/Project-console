import express from 'express';
import compression from 'compression';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

import { setupMockProjectsIfMissing } from './mockProjects.js';
import { state } from './state.js';
import { loadLearnedIntents } from './learnedIntents.js';
import { loadDevUrls } from './devUrlStore.js';
import { initScheduler } from './schedules/scheduler.js';
import { loadUsers } from './auth/userStore.js';
import { requireAuth } from './auth/authGate.js';
import { initNotifications } from './notify.js';
import { loadAutoStart, initAutoStart } from './autoStartProjects.js';
import { syncClipboardPolling } from './clipboardHistory.js';
import { loadWatchRules } from './watchRules.js';
import { initWatchRules } from './watchEngine.js';
import { checkCollisionBaseline } from './collisions.js';
import { checkForUpdates } from './updateChecker.js';
import { initWebSocketServer } from './wsHandlers/connection.js';
import { sweepOrphanedTmpFiles } from './sessionIndex.js';
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
import { registerClipboardRoutes } from './routes/clipboardRoutes.js';
import { registerCalculateRoutes } from './routes/calculateRoutes.js';
import { registerBackupRoutes } from './routes/backupRoutes.js';
import { registerCommandDocsRoutes } from './routes/commandDocsRoutes.js';
import { registerNotificationsRoutes } from './routes/notificationsRoutes.js';
import { registerKnowledgeRoutes } from './routes/knowledgeRoutes.js';
import { registerDoctorRoutes } from './routes/doctorRoutes.js';
import { registerMarketplaceRoutes } from './routes/marketplaceRoutes.js';
import { registerConnectedUsersRoutes } from './routes/connectedUsersRoutes.js';
import { registerBrowseRoutes } from './routes/browseRoutes.js';
import { registerEditorRoutes } from './routes/editorRoutes.js';
import { registerLogRoutes } from './routes/logRoutes.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { loadTuning } from './tuningStore.js';
import { loadEditors } from './editorsStore.js';
import { log } from './logger.js';

// Boot leaves — each is a self-contained module for one startup phase.
import { setupDevServer, setupProdStatic } from './boot/viteSetup.js';
import { discoverAndInitializeProjects } from './boot/projectDiscovery.js';
import { startConfigWatcher } from './boot/configWatcher.js';
import { runMlStartupWork } from './boot/mlStartup.js';
import { bindPort } from './boot/portBind.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// HOST binds to localhost only by default — this server can execute shell commands
// and (with AI mode on) read/write files, so it should not be reachable from the LAN
// unless you explicitly opt in via HOST=0.0.0.0. BASE_PORT/HOST are from portConfig.js.

app.use(compression());
app.use(express.json());

// Phase I (2026-09-09): login gate — open server while no accounts exist (today's
// behavior, byte-identical), 401 on /api (except /api/auth/*) once armed. Static assets
// and Vite dev middleware mount later and are never gated (the login page must load).
app.use('/api', requireAuth);

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
registerDoctorRoutes(app);
registerMarketplaceRoutes(app);
registerConnectedUsersRoutes(app);
registerBrowseRoutes(app);
registerEditorRoutes(app);
registerLogRoutes(app);
registerAuthRoutes(app);
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
    await setupDevServer(app, httpServer);
  } else {
    setupProdStatic(app, __dirname);
  }

  // Discover projects and train NLP once, before accepting connections
  const dirToScan = setupMockProjectsIfMissing(state.currentScanDirectory, __dirname);
  // Restore any phrases learned (and confirmed) in previous runs BEFORE the semantic matcher
  // builds its embeddings, so restarts don't silently forget cross-project learning.
  loadLearnedIntents();
  // Restore last-known dev-server URLs so "is the server running" can probe servers that were
  // started outside the console or before this restart.
  loadDevUrls();

  // A-6 (2026-09-08): sweep orphaned *.tmp files from interrupted atomic writes. Fire-and-forget.
  sweepOrphanedTmpFiles(state.activeProjectsCache.map(p => p.path)).catch(() => {});

  // Boot-state markers: printed to stderr so the Electron desktop shell can show live loading
  // progress on the splash screen instead of a static "Starting..." message (Phase 1.3).
  const emitBootState = (state) => process.stderr.write(`[boot-state]${state}\n`);

  // Phase 6: project scan + matcher init (concurrent), then NLP training + project intents.
  await discoverAndInitializeProjects(dirToScan, emitBootState);

  // Phase 1: restore persisted schedules and start the scheduler tick.
  initScheduler();
  // Phase I: restore local user accounts (no enforcement yet — see authRoutes.js).
  loadUsers();
  // Phase 2: restore notification rules and register the taskQueue completion hook.
  initNotifications();
  // Phase 15: restore file-watch notification rules and attach their folder watchers.
  loadWatchRules();
  initWatchRules();
  // Phase 7: restore auto-start config and schedule boot-time runs.
  loadAutoStart();
  initAutoStart();
  // Phase 8: sync clipboard polling with the profile.
  syncClipboardPolling();
  // Phase 7: baseline intent-collision sweep — fire-and-forget.
  checkCollisionBaseline().catch(() => {});
  // Phase 5: bounded, non-blocking npm-registry version check — fire-and-forget.
  checkForUpdates(false).catch(() => {});

  // Start file watcher for console.config.json changes
  startConfigWatcher(dirToScan);

  // Stage 1 ML work: confidence retrain + threshold adjustments + near-miss learning.
  await runMlStartupWork();

  // Port fallback + server event wiring.
  const server = await bindPort(httpServer, emitBootState);

  if (server) {
    // A rejection inside init() (discoverProjects, NLP training, watcher setup) used to be
    // absorbed by the unhandledRejection handler, leaving a live process with NO HTTP listener
    // — the CLI client retries for 90s and gives up, the daemon scripts report a live process,
    // and it looks like a hung app instead of a crash (audit 2026-08-06, Phase 2).
    // No-op here — the process-level handlers below cover init() failures too.
  }
}

// Process-level safety net: a rejected promise that slips past every `.catch` would otherwise
// terminate the whole console via Node's default unhandledRejection=throw.
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

// Fail loudly on init() rejection — the listen loop only ever ran at the end of init(),
// so there's nothing worth preserving.
init().catch((err) => {
  const stack = err instanceof Error ? err.stack : String(err);
  try { console.error('Fatal init failure:', stack); } catch {}
  log.error({ err: stack }, 'Fatal init failure');
  log.error('Fatal init failure:', stack);
  process.exit(1);
});
