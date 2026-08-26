// Phase 18 (UPGRADE-ROADMAP.md, 2026-08-12): Project Console desktop shell — Electron.
// Decision (per the roadmap's stated default): Electron over Tauri because this codebase is
// 100% JS/TS and Electron gives direct Node/npm parity with the existing tooling; Tauri would
// add a Rust toolchain to the build environment for no benefit at this scope.
//
// This shell wraps the EXISTING server — it does not rearchitect it:
//  - Reuses bin/cli.js's port-probing rule (ports 3000-3019): if a console already responds
//    on any of them, the shell just attaches to it (no duplicate instance, ever).
//  - Otherwise spawns the server as a CHILD process (node server/index.js, or the esbuild
//    dist/server.js bundle when present) rather than importing it in-process — a renderer or
//    shell crash can never take the server down, and the server's own process-exit cleanup
//    (executorProcesses.js's process.on('exit'/'SIGTERM')) handles tracked processes.
//  - Waits for the bound port exactly like the CLI launcher does (polls /api/projects), then
//    shows the app's OWN Electron window pointed at that URL (2026-08-26: the shell used to
//    open the default browser — a desktop app must open as a desktop app, so the UI now lives
//    in a BrowserWindow; external https links opened from the UI still go to the browser).
//    A minimal splash page covers the server's cold-boot window (up to ~90s), then the window
//    navigates to the console once the port answers.
//  - Runs a system tray icon whose Quit stops the server cleanly; closing the window quits
//    the app (which stops the server child via before-quit).
//  - First run inside the packaged app triggers the SAME onboarding wizard the browser gets
//    (FirstRunSetup.tsx) — there is no packaged-app-only onboarding flow.
//  - AI mode: the packaged app does NOT bundle or auto-install Ollama — the in-app message
//    (FirstRunSetup's Ollama note + the AI toggle's own guidance) points at ollama.com. A
//    separate, optional install, per the roadmap's explicit instruction.
// This file is main.cjs (NOT main.js) on purpose: desktop/package.json has no "type" field,
// so Electron loads it as CommonJS — an ESM import statement would throw a parse-time
// SyntaxError and the shell could never start (audit 2026-08-17, Phase 7).
const { app, Tray, Menu, nativeImage, dialog, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BASE_PORT = 3000;
const MAX_PORT_ATTEMPTS = 20; // 3000-3019, same rule as start.bat / bin/cli.js (widened 2026-08-26)

let tray = null;
let serverChild = null;
let mainWindow = null;
let autoUpdater = null;

// Splash shown while the server child cold-boots (scan + NLP + embeddings can take 40-90s on
// a fresh install). A data: URL keeps this dependency-free — no extra asset to package.
const SPLASH_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;' +
    'background:#0D0D0E;color:#E5E5EA;font-family:Segoe UI,system-ui,sans-serif}' +
    'div{text-align:center}span{display:inline-block;width:14px;height:14px;border-radius:50%;' +
    'background:#64D2FF;animation:p 1s infinite ease-in-out}@keyframes p{50%{transform:scale(.6);opacity:.4}}' +
    '</style></head><body><div><span></span><p>Project Console — starting the local server…</p></div></body></html>'
  );

// Fatal-startup error page (2026-08-26): a clear, specific message instead of a silent hang or
// an unexplained quit. Shown in the window AND as a native dialog with Retry/Quit — the dialog
// carries the action, the page carries the detail (incl. the server's own stderr tail).
function errorPageHtml(message, detail) {
  const safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;' +
      'background:#0D0D0E;color:#E5E5EA;font-family:Segoe UI,system-ui,sans-serif}' +
      'div{max-width:640px;padding:32px}pre{background:#161618;padding:12px;border-radius:8px;' +
      'overflow:auto;font-size:12px;color:#FF9F0A;white-space:pre-wrap}' +
      'h2{color:#FF453A;margin:0 0 8px}</style></head><body><div>' +
      `<h2>${safe(message)}</h2>` +
      `<p style="color:#86868B">${safe(detail)}</p>` +
      (detail ? `<pre>${safe(detail)}</pre>` : '') +
      '<p style="color:#64D2FF">Click Retry in the dialog to try again.</p>' +
      '</div></body></html>'
    )
  );
}

let quitting = false; // set in before-quit so the child-exit handler doesn't fire error UI on shutdown
let serverReady = false; // true once the port answered — later child exits are normal stops

/** The app's own window, pointed at the console. Created once; later calls focus it. */
function createWindow(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0D0D0E',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // External links (target=_blank from the web UI, e.g. the GitHub repo or ollama.com) open in
  // the user's browser; everything else stays in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) require('electron').shell.openExternal(target);
    return { action: 'deny' };
  });
  // Keep the web UI's own navigation in the window (a link to the console itself must not
  // spawn a second window / browser).
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) event.preventDefault();
  });
  mainWindow.loadURL(url);
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// Auto-update lifecycle (2026-08-25): electron-updater against the GitHub Releases publish
// config in desktop/package.json (build.publish). Design decisions:
//  - Installer-only: autoUpdater is only initialized on packaged builds — the repo / unpacked
//    build has no update metadata, and dev must never check.
//  - User-confirmed downloads (autoDownload=false) and an explicit restart prompt — the update
//    flow lives in native dialogs, which work identically with the app's own window open.
//  - Failures are silent by design (offline first-run, no release published yet): an update
//    check must never make the shell look broken.
function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater: au } = require('electron-updater');
    autoUpdater = au;
    autoUpdater.autoDownload = false; // download only after the user confirms
    autoUpdater.autoInstallOnAppQuit = false; // install only via the explicit restart prompt
    // Local update-cycle test hook (documented, never used in production): point the feed at
    // a local dir of `electron-builder --publish never` output and observe the flow through
    // the log file instead of native dialogs (CONSOLE_UPDATE_URL=<http://host/dir>).
    const testFeed = process.env.CONSOLE_UPDATE_URL;
    const testLog = testFeed ? path.join(app.getPath('userData'), 'update-test.log') : null;
    const log = testFeed
      ? (msg) => { try { fs.appendFileSync(testLog, `${new Date().toISOString()} ${msg}\n`); } catch {} }
      : null;
    if (testFeed) {
      autoUpdater.setFeedURL({ provider: 'generic', url: testFeed });
    }
    autoUpdater.on('update-available', (info) => {
      console.log('[auto-update] update available:', info && info.version);
      if (testFeed) {
        log(`update-available ${info && info.version} — downloading`);
        autoUpdater.downloadUpdate();
        return;
      }
      dialog.showMessageBox({
        type: 'info',
        title: 'Update available',
        message: `Project Console ${info.version} is available.`,
        detail: 'Download and install it now? You will be asked to restart the app to finish.',
        buttons: ['Download & install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[auto-update] update downloaded:', info && info.version);
      if (testFeed) {
        log(`update-downloaded ${info && info.version} — quitAndInstall`);
        setTimeout(() => autoUpdater.quitAndInstall(), 500);
        return;
      }
      dialog.showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: 'The update has been downloaded.',
        detail: 'Restart now to install it (the console server stops with the app).',
        buttons: ['Restart & install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });
    autoUpdater.on('error', (err) => {
      console.error('[auto-update]', err && err.message ? err.message : err);
    });
  } catch (err) {
    console.error('[auto-update] unavailable:', err.message);
  }
}

function checkForUpdates() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[auto-update] check failed (silent):', err && err.message ? err.message : err);
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/projects`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? port : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Is a console already running on 3000-3019? (No duplicate instance — same rule as the
 *  batch/CLI launchers.) */
async function findRunningConsole() {
  for (let p = BASE_PORT; p < BASE_PORT + MAX_PORT_ATTEMPTS; p++) {
    const found = await probePort(p);
    if (found) return found;
  }
  return null;
}

/** Surface a fatal startup failure: error page in the window + Retry/Quit dialog. */
function showFatalError(message, detail) {
  const page = errorPageHtml(message, detail);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(page);
    mainWindow.focus();
  } else {
    createWindow(page);
  }
  try {
    dialog.showMessageBox({
      type: 'error',
      title: 'Project Console failed to start',
      message,
      detail: detail || 'See the window for the full error.',
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        // Restart the whole shell (the server child is already dead in every path that
        // reaches here, or is killed by before-quit on the way out).
        app.relaunch();
        app.exit(0);
      } else {
        app.quit();
      }
    }).catch(() => {});
  } catch {
    // Dialog unavailable (headless) — the window page still shows the error.
  }
}

function startServer() {
  // Packaged: the staged runtime (server source, built frontend, prod node_modules) lives in
  // resources/ via extraResources — `node <entry>` cannot execute a script from inside the
  // asar, so the server root is process.resourcesPath, never the app bundle. Dev: the repo
  // root, exactly like bin/cli.js.
  const rootDir = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
  const bundlePath = path.join(rootDir, 'dist', 'server.js');
  const serverPath = path.join(rootDir, 'server', 'index.js');
  const entry = fs.existsSync(bundlePath) ? bundlePath : serverPath;
  // ELECTRON_RUN_AS_NODE=1 is MANDATORY: process.execPath is the Electron binary itself, and
  // without the flag Electron relaunches the child as ANOTHER app instance (crash-looping
  // helper processes — verified live 2026-08-24) instead of running server/index.js as plain
  // Node. PORT is inherited from the environment; the server's own fallback loop handles
  // collisions.
  serverChild = spawn(process.execPath, [entry], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
      // Marks the child as the desktop build: the server suppresses the npm-CLI update check
      // (updateChecker.js) — the desktop app is a separate product with its own update channel
      // (electron-updater), and the npm banner would point users at `npm install -g`.
      CONSOLE_DESKTOP: '1',
    },
    // stderr is piped (not inherited) so a startup failure can be shown to the user verbatim —
    // before this, "Failed to start server: ..." went to an invisible console and the app
    // waited out the full 90s probe window before quitting with no message at all (2026-08-26).
    stdio: ['ignore', 'inherit', 'pipe'],
    windowsHide: true,
  });
  let serverStderrTail = '';
  serverChild.stderr && serverChild.stderr.on('data', (d) => {
    serverStderrTail = (serverStderrTail + String(d)).slice(-4000);
  });
  serverChild.on('error', (err) => {
    console.error('Server failed to start:', err.message);
    if (!quitting) showFatalError('Could not launch the console server.', err.message);
  });
  serverChild.on('exit', (code) => {
    // A non-zero exit BEFORE the port answered is a startup failure (no port, model crash,
    // missing module) — surface it immediately instead of waiting out the probe window.
    if (!quitting && code !== 0 && !serverReady) {
      showFatalError(
        'The console server stopped during startup.',
        serverStderrTail || `Exit code ${code}.`
      );
    }
  });
}

/** Poll the bound port until /api/projects answers (cold boot ~30-45s). */
async function waitForServer(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function openConsole(port) {
  const url = `http://127.0.0.1:${port}`;
  // The console lives in the app's own BrowserWindow (2026-08-26) — never the default browser.
  // The window may already exist showing the splash: re-point it at the real console URL.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(url);
    mainWindow.focus();
  } else {
    createWindow(url);
  }
  if (!tray) {
    // Minimal tray icon with a quit action — closing the shell must stop the server cleanly.
    try {
      const emptyImg = nativeImage.createEmpty();
      tray = new Tray(emptyImg);
      tray.setToolTip('Project Console');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: `Open console (${url})`, click: () => createWindow(url) },
        { type: 'separator' },
        { label: 'Check for updates', click: () => checkForUpdates() },
        { type: 'separator' },
        { label: 'Quit (stops the server)', click: () => app.quit() },
      ]));
    } catch {
      // Tray is best-effort — a headless CI box or some Linux DEs can't create one.
    }
  }
}

app.whenReady().then(async () => {
  // If a console is already running, just attach — never start a second instance.
  const existing = await findRunningConsole();
  if (existing) {
    openConsole(existing);
    return;
  }
  startServer();
  // The window shows immediately with a splash while the server cold-boots, then navigates
  // to the real console URL once the port answers — a 40-90s first boot must not look broken.
  createWindow(SPLASH_HTML);
  // Auto-update init + a delayed first check: boot stays snappy, and by the time the check
  // runs the server is usually up so a "Restart & install" loses as little work as possible.
  initAutoUpdater();
  setTimeout(() => checkForUpdates(), 30000);
  // The server binds 3000-3019 via its own fallback loop; find whichever port it landed on.
  const bound = await waitForServer(BASE_PORT);
  if (!bound) {
    // The fallback loop may have bound a higher port — probe the full range.
    for (let p = BASE_PORT + 1; p < BASE_PORT + MAX_PORT_ATTEMPTS; p++) {
      if (await probePort(p)) { openConsole(p); return; }
    }
    // No port answered within the deadline — tell the user exactly that instead of quitting
    // with no message (2026-08-26). The stderr tail (if the child died) is shown as detail.
    showFatalError(
      'The console server did not become reachable in time.',
      'The server was started but never answered on ports 3000-3019 within 90 seconds.' +
        (serverStderrTail ? `\n\nServer output:\n${serverStderrTail}` : '') +
        '\n\nMake sure the ports are free (close other apps using them) and your firewall allows localhost connections.'
    );
    return;
  }
  serverReady = true;
  // Re-point the splash window at the real console (no flash of a second window) + tray.
  // waitForServer returns a BOOLEAN and only ever probes BASE_PORT — the port is the constant.
  openConsole(BASE_PORT);
});

// A desktop app with a real window: closing the window quits (before-quit stops the server
// child). The tray's Quit is the same exit path — no orphaned server either way.
app.on('window-all-closed', () => {
  app.quit();
});

// Clean shutdown: kill the server child so no orphaned background process survives the app
// closing (the same guarantee the roadmap's verification requires — stopTrackedProcess-
// equivalent cleanup on the server side handles the tracked dev servers).
app.on('before-quit', () => {
  quitting = true;
  if (serverChild && !serverChild.killed) {
    serverChild.kill();
  }
});