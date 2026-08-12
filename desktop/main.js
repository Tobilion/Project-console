// Phase 18 (UPGRADE-ROADMAP.md, 2026-08-12): Project Console desktop shell — Electron.
// Decision (per the roadmap's stated default): Electron over Tauri because this codebase is
// 100% JS/TS and Electron gives direct Node/npm parity with the existing tooling; Tauri would
// add a Rust toolchain to the build environment for no benefit at this scope.
//
// This shell wraps the EXISTING server — it does not rearchitect it:
//  - Reuses bin/cli.js's port-probing rule (ports 3000-3009): if a console already responds
//    on any of them, the shell just attaches to it (no duplicate instance, ever).
//  - Otherwise spawns the server as a CHILD process (node server/index.js, or the esbuild
//    dist/server.js bundle when present) rather than importing it in-process — a renderer or
//    shell crash can never take the server down, and the server's own process-exit cleanup
//    (executorProcesses.js's process.on('exit'/'SIGTERM')) handles tracked processes.
//  - Waits for the bound port exactly like the CLI launcher does (polls /api/projects), then
//    opens the user's default browser and runs a system tray icon that quits cleanly.
//  - First run inside the packaged app triggers the SAME onboarding wizard the browser gets
//    (FirstRunSetup.tsx) — there is no packaged-app-only onboarding flow.
//  - AI mode: the packaged app does NOT bundle or auto-install Ollama — the in-app message
//    (FirstRunSetup's Ollama note + the AI toggle's own guidance) points at ollama.com. A
//    separate, optional install, per the roadmap's explicit instruction.
import { app, Tray, Menu, nativeImage } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';

const BASE_PORT = 3000;
const MAX_PORT_ATTEMPTS = 10; // 3000-3009, same rule as start.bat / bin/cli.js

let tray = null;
let serverChild = null;
let openedOnce = false;

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

/** Is a console already running on 3000-3009? (No duplicate instance — same rule as the
 *  batch/CLI launchers.) */
async function findRunningConsole() {
  for (let p = BASE_PORT; p < BASE_PORT + MAX_PORT_ATTEMPTS; p++) {
    const found = await probePort(p);
    if (found) return found;
  }
  return null;
}

function startServer() {
  const rootDir = path.resolve(__dirname, '..');
  const bundlePath = path.join(rootDir, 'dist', 'server.js');
  const serverPath = path.join(rootDir, 'server', 'index.js');
  const entry = fs.existsSync(bundlePath) ? bundlePath : serverPath;
  // PORT is inherited from the environment; the server's own fallback loop handles collisions.
  serverChild = spawn(process.execPath, [entry], {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
    windowsHide: true,
  });
  serverChild.on('error', (err) => {
    console.error('Server failed to start:', err.message);
    app.quit();
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
  if (openedOnce) return;
  openedOnce = true;
  // Open the default browser (same "app feel" decision as start.bat: a tray icon + the
  // browser, NOT an embedded webview — an embedded webview would duplicate the browser for
  // no benefit, and the browser is where the app already lives).
  require('electron').shell.openExternal(url);
  if (!tray) {
    // Minimal tray icon with a quit action — closing the shell must stop the server cleanly.
    try {
      const emptyImg = nativeImage.createEmpty();
      tray = new Tray(emptyImg);
      tray.setToolTip('Project Console');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: `Open console (${url})`, click: () => require('electron').shell.openExternal(url) },
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
  // The server binds 3000-3009 via its own fallback loop; find whichever port it landed on.
  const bound = await waitForServer(BASE_PORT);
  if (!bound) {
    // The fallback loop may have bound a higher port — probe the full range.
    for (let p = BASE_PORT + 1; p < BASE_PORT + MAX_PORT_ATTEMPTS; p++) {
      if (await probePort(p)) { openConsole(p); return; }
    }
    console.error('Server did not become reachable within 90s.');
    app.quit();
    return;
  }
  openConsole(BASE_PORT);
});

// Clean shutdown: kill the server child so no orphaned background process survives the app
// closing (the same guarantee the roadmap's verification requires — stopTrackedProcess-
// equivalent cleanup on the server side handles the tracked dev servers).
app.on('before-quit', () => {
  if (serverChild && !serverChild.killed) {
    serverChild.kill();
  }
});
