#!/usr/bin/env node

import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import readline from 'readline';
// MUST be the first import: it sets CONSOLE_LOG_TO_STDERR before the server graph (and
// therefore server/logger.js) is evaluated - see server/cliEnv.js for why the order matters.
import '../server/cliEnv.js';
import { BASE_PORT, MAX_PORT_ATTEMPTS } from '../server/portConfig.js';
import { findRunningConsole, findConsoleReadyPort } from '../server/portProbe.js';
import { acquireBootClaim, setClaimPort, releaseBootClaim } from '../server/bootClaim.js';
import { traceBoot } from '../server/bootTrace.js';

traceBoot('launcher:module-loaded');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

process.on('uncaughtException', (err) => {
  console.error(`\nCLI launcher crashed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  console.error(`\nCLI launcher unhandled rejection: ${msg}`);
  process.exit(1);
});

/**
 * Newest modification time (ms) across the server sources. Used to decide whether the
 * prebuilt bundle is stale: the bundle is only preferred when it is at least as new as the
 * sources it was built from.
 */
function newestSourceMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(js|ts|mjs|cjs)$/.test(entry.name)) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* unreadable file — ignore */ }
      }
    }
  }
  return newest;
}

async function startServer() {
  // Default mode: launch the server in production
  process.env.NODE_ENV = 'production';

  // Prefer the esbuild bundle (dist/server.js), fall back to the source entry.
  //
  // Staleness guard (2026-10-20): the bundle used to win whenever it merely EXISTED, so a
  // bundle built before a source edit silently shadowed every later source change (this
  // repo's own docs record that bite twice). The bundle is now only used when it is at
  // least as new as the sources it was built from; otherwise the source entry runs and the
  // user is told to rebuild. A published package ships the bundle next to the same sources
  // it was built from, so it stays newer-or-equal and keeps winning there.
  const bundlePath = path.join(rootDir, 'dist', 'server.js');
  const serverPath = path.join(rootDir, 'server', 'index.js');
  let entry = serverPath;
  if (fs.existsSync(bundlePath)) {
    let bundleMtime = 0;
    try {
      bundleMtime = fs.statSync(bundlePath).mtimeMs;
    } catch { /* fall through to source */ }
    if (bundleMtime && bundleMtime >= newestSourceMtime(path.join(rootDir, 'server'))) {
      entry = bundlePath;
    } else {
      console.log('  Note: dist/server.js is older than the server sources — starting from source.');
      console.log('        Run "npm run build:server" to rebuild the bundle (source mode costs ~8s more at startup).');
    }
  } else {
    console.log('  Note: no dist/server.js bundle — starting from source.');
    console.log('        Run "npm run build:server" to build one (source mode costs ~8s more at startup).');
  }

  // Source mode: server modules can be TypeScript (the 7 safety leaves converted 2026-08-26),
  // so plain Node needs the tsx loader registered before the import. The bundle path never
  // needs it. tsx is a devDependency — source mode only runs from a dev checkout, where it
  // is always installed; the published package always ships the bundle (files: dist/).
  if (entry === serverPath) {
    const { register } = await import('tsx/esm/api');
    register();
  }

  // Importing the server module triggers init() as a side effect (line 221 of index.js).
  // The server will set globalThis.__consoleServerPort once the port fallback loop binds.
  traceBoot('launcher:importing-server');
  await import(pathToFileURL(entry).href);
  traceBoot('launcher:server-imported');

  // Poll for the global signal set in index.js's onListening handler. D-5 (2026-09-08):
  // was 30s, but a cold boot (embedding-model download/batch-embed + NLP training +
  // discovery) can legitimately take up to ~90s the first time — 30s failed correctly-
  // booting servers, not just genuinely stuck ones. Matches the desktop shell's and the
  // daemon's own 90s boot ceiling.
  const MAX_WAIT = 120000;
  const POLL = 200;
  let waited = 0;
  while (typeof globalThis.__consoleServerPort !== 'number' && waited < MAX_WAIT) {
    await new Promise((r) => setTimeout(r, POLL));
    waited += POLL;
  }

  const port = globalThis.__consoleServerPort;
  if (!port) {
    console.error(`\nServer failed to bind to a port within ${MAX_WAIT / 1000}s. Check for port conflicts or startup errors above.`);
    process.exit(1);
  }
  return port;
}

// start.bat-equivalent helpers: probe for an already-running server, the W/C/Q menu, and a
// cross-platform browser open. All three mirror the batch launcher's behavior exactly so
// `npm run launcher` is a terminal-native replacement for the .bat file.

// A running console server answers /api/projects on one of BASE_PORT..BASE_PORT+MAX_PORT_
// ATTEMPTS-1. When one is found the launcher hands off to it instead of starting a duplicate
// instance (which would only bind a fallback port and leave a second server behind).
// probeConsolePort/findRunningConsole are the shared implementation (server/portProbe.js) —
// also used by scripts/daemon.mjs. This used to be a hand-rolled loop here that additionally
// required `data.projects.length > 0`, so a freshly-scanned console with zero discovered
// projects was invisible to this probe and a second server would start alongside it
// (Phase B.2 fix, 2026-09-08) — the shared implementation treats an empty projects array as
// a valid "yes, a console is running here" answer, matching desktop/main.cjs and daemon.mjs.
async function probeRunningPort() {
  return findRunningConsole(BASE_PORT, MAX_PORT_ATTEMPTS);
}

/**
 * Gets a console for this launcher, booting one only when nobody else is.
 *
 * The order matters. A live console is always preferred (attach). When there is none, the
 * launcher takes an ATOMIC boot claim (server/bootClaim.js): exactly one launcher may boot,
 * the others wait for that console to answer and attach to it.
 *
 * Without the claim, launchers that start at the same instant all probe, all find nothing,
 * and all boot: measured on this machine, three concurrent launches bound ports 3000, 3001
 * AND 3002 at once - three copies of the embedding model, and the losing clients' terminals
 * filled with server boot logs instead of their answer.
 *
 * Returns { port, attached, claimPath } - `attached` is true when the console was already
 * running (or was booted by another launcher), false when this process booted it.
 */
async function acquireConsole(options = {}) {
  // Bounded on purpose: a launcher must not wait forever for a console that keeps appearing
  // and dying. Two rounds of a 60s wait is enough for a cold boot (13-45s measured), and the
  // total stays under ~2 minutes even in the pathological case.
  const maxRounds = options.maxRounds || 2;
  const waitMs = options.waitMs || 60000;
  for (let round = 0; round < maxRounds; round++) {
    // 1. A live console is always preferred (attach).
    //
    // The cheap /api/ping probe comes FIRST: the authoritative /api/projects check builds a
    // document the console has to serialize per request, and when the console is busy serving
    // several clients that request can exceed the probe's timeout — the launcher then missed a
    // console that was right there and booted a second one (measured 2026-10-20: 5 clients
    // against a running console, one of them started a duplicate on port 3001). The ping is
    // our own endpoint with our own shape, so it is the better first check; the heavy probe
    // still runs second, to catch a console that predates the ping endpoint.
    const ready = await findConsoleReadyPort(BASE_PORT, MAX_PORT_ATTEMPTS);
    if (ready) return { port: ready, attached: true, claimPath: null };
    const running = await probeRunningPort();
    if (running) return { port: running, attached: true, claimPath: null };

    // 2. Take an ATOMIC boot claim: exactly one launcher may boot.
    const claim = acquireBootClaim();
    if (claim.unusable) {
      // The claim file cannot be created (read-only data dir, permissions). Booting is still
      // better than refusing to start.
      const port = await startServer();
      return { port, attached: false, claimPath: null };
    }
    if (claim.claimed) {
      try {
        const port = await startServer();
        setClaimPort(claim.path, port);
        return { port, attached: false, claimPath: claim.path };
      } catch (err) {
        releaseBootClaim(claim.path);
        throw err;
      }
    }

    // 3. Another launcher is booting right now - wait for its console instead of starting
    // a second one. The wait is bounded by the same ceiling the boot itself gets.
    const waited = await waitForConsole(waitMs);
    if (!waited) continue; // the other boot never produced a console: loop and take over

    // 4. The console we waited for may have EXITED again in the meantime: the launcher that
    // booted it runs the server IN-PROCESS, so the console dies with that launcher. Measured
    // 2026-10-20: five simultaneous launches - the first launcher answered its query in ~3s
    // and exited, taking the console with it, and the four waiters were left pointing at a
    // dead port. Re-check before handing the port over; if it is gone, loop round and take
    // the boot over ourselves.
    const stillAlive = await findConsoleReadyPort(BASE_PORT, MAX_PORT_ATTEMPTS);
    if (stillAlive) return { port: stillAlive, attached: true, claimPath: null };
    console.log('  The console that was starting exited - taking over the boot.');
  }
  throw new Error('Could not reach a console: another launcher kept starting one that exited before it was ready.');
}

/** Polls for a READY console until it answers or the deadline passes.
 *  Uses the cheap /api/ping probe: the wait loop runs every 500ms, and the authoritative
 *  /api/projects probe is a document the console has to build and serialize on every
 *  request - polling it here saturated the server and the waiting clients timed out with
 *  "Could not connect" while the console was running (measured 2026-10-20). */
async function waitForConsole(waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    // Wait for a READY console, not merely a bound port: a console that is still booting
    // can answer the ping and then fail the client's first real request.
    const port = await findConsoleReadyPort(BASE_PORT, MAX_PORT_ATTEMPTS);
    if (port) {
      // Confirm it really is a console before handing the port over.
      const confirmed = await findRunningConsole(BASE_PORT, MAX_PORT_ATTEMPTS);
      if (confirmed) return confirmed;
      return port;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Releases the boot claim when this launcher exits, so the next launch is not blocked. */
function releaseClaimOnExit(claimPath) {
  const release = () => { try { releaseBootClaim(claimPath); } catch { /* best effort */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
}

function askChoice() {
  // crlfDelay: Infinity - Windows ConPTY can otherwise emit two 'line' events per Enter.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    crlfDelay: Infinity,
  });
  return new Promise((resolve) => {
    rl.question('  Enter choice (W/C/Q): ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function openBrowser(url) {
  // Cross-platform browser open (Windows: use cmd /c start since 'start' is a cmd.exe builtin)
  const isWin = process.platform === 'win32';
  const openCmd = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const openArgs = isWin ? ['/c', 'start', '', url] : [url];
  const child = spawn(openCmd, openArgs, { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
}

async function runLauncher() {
  const header =
    '\n\x1b[36m  ================================================================\n' +
    '  \x1b[0m\x1b[1m\x1b[37m              LOCAL PROJECT CONSOLE ENGINE V4\x1b[36m\n' +
    '  ================================================================\x1b[0m\n';
  const menu =
    '\n\x1b[90m  Select execution interface:\x1b[0m\n\n' +
    '  \x1b[32m[W]\x1b[1m Web UI \x1b[0m\x1b[90m   (Opens browser canvas @ localhost:3000)\x1b[0m\n' +
    '  \x1b[33m[C]\x1b[1m CLI Chat \x1b[0m\x1b[90m   (Interactive terminal agent mode)\x1b[0m\n' +
    '  \x1b[31m[Q]\x1b[1m Quit \x1b[0m\x1b[90m   (Exit launcher)\x1b[0m\n\n' +
    '  \x1b[36m----------------------------------------------------------------\x1b[0m\n';

  let choice;
  do {
    process.stdout.write('\x1b[2J\x1b[H' + header + menu + '\n');
    choice = await askChoice();
  } while (!['w', 'c', 'q'].includes(choice));

  if (choice === 'q') {
    console.log('\x1b[90m  Exiting launcher...\x1b[0m');
    process.exit(0);
  }

  const __probeBase = parseInt(process.env.PORT, 10) || 3000;
  console.log(`\n  [+] Checking for a running server on ports ${__probeBase}-${__probeBase + 19}...`);

  if (choice === 'w') {
    const { port, attached, claimPath } = await acquireConsole();
    if (attached) {
      console.log(`\x1b[32m  [+] Server already running on port ${port} - opening browser.\x1b[0m`);
    } else {
      console.log(`\x1b[32m  [+] Server started on port ${port} - opening browser.\x1b[0m`);
    }
    if (claimPath) releaseClaimOnExit(claimPath);
    openBrowser(`http://localhost:${port}`);
    console.log(`\n  Local Project Console ready at http://127.0.0.1:${port}\n`);
    return;
  }

  // CLI chat mode - same as bin/cli.js's `cli` mode, but respects an already-running server
  // and shares the atomic boot claim, so simultaneous launches still start only one console.
  const { port, attached, claimPath } = await acquireConsole();
  if (attached) {
    console.log(`\x1b[32m  [+] Server already running on port ${port} - skipping start.\x1b[0m`);
  } else {
    console.log(`\x1b[33m  [+] Server started on port ${port}.\x1b[0m`);
  }
  if (claimPath) releaseClaimOnExit(claimPath);
  const cliClientPath = path.join(rootDir, 'server', 'cli-client.js');
  const child = spawn(process.execPath, [cliClientPath, ...process.argv.slice(3), '--port', String(port)], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error('Could not start the CLI chat:', err.message);
    process.exit(1);
  });
}

async function main() {
  // Phase 3 hook: `npx local-project-console init [targetDir]`
  if (process.argv[2] === 'init') {
    const targetDir = path.resolve(process.argv[3] || process.cwd());
    const initPath = path.resolve(rootDir, 'server', 'configInitializer.js');
    const { initConfig } = await import(pathToFileURL(initPath).href);
    await initConfig(targetDir);
    process.exit(0);
  }

  // start.bat-equivalent launcher: `node bin/cli.js launcher` (or `npm run launcher`).
  // Prompts W/C/Q exactly like the batch file, then hands off to the matching mode.
  if (process.argv[2] === 'launcher' || process.argv[2] === '--launcher') {
    await runLauncher();
    return;
  }

  // CLI chat mode: `npx local-project-console cli [--dir <path>] [--project <name>]`.
  // Starts the server in-process (same boot as the web mode), then hands the terminal to
  // server/cli-client.js instead of opening the browser — the same chat mode start.bat's
  // [C] option reaches. The client scans ports 3000-3019 and finds the in-process server;
  // when it exits, the server exits with it (no orphan).
  if (process.argv[2] === 'cli' || process.argv[2] === '--cli') {
    // Probe BEFORE booting. This path used to always boot a server in-process, even when a
    // console was already running: the new server did the full cold start (project
    // discovery, embedding model, NLP training - ~40s measured on this machine) and bound a
    // FALLBACK port, while the CLI client then attached to the older console on the base
    // port. Net effect: a minute of waiting and a duplicate server for the whole session.
    // Attaching to the running console is what the launcher's [C] option already did.
    //
    // acquireConsole() adds the atomic boot claim on top: launchers that start at the same
    // instant no longer each boot their own server.
    const { port, attached, claimPath } = await acquireConsole();
    if (attached) {
      console.log(`\n  Console already running on port ${port} - attaching to it.`);
    } else {
      console.log(`\n  Console started on port ${port}.`);
    }
    if (claimPath) releaseClaimOnExit(claimPath);
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  Local Project Console ready at ${url}`);
    console.log('  CLI chat mode — type "exit" or Ctrl+C to quit.\n');
    const cliClientPath = path.join(rootDir, 'server', 'cli-client.js');
    const child = spawn(process.execPath, [cliClientPath, ...process.argv.slice(3), '--port', String(port)], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', (err) => {
      console.error('Could not start the CLI chat:', err.message);
      process.exit(1);
    });
    return;
  }

  // `console doctor` subcommand: `node bin/cli.js doctor` (or `npm run doctor`).
  // Runs the standalone machine-side checks (ports, daemon, embedding cache, writability,
  // Ollama, update, tooling, disk) WITHOUT booting the server — the doctor must work when
  // the console itself cannot start. server/doctor.js imports no server-graph modules, so
  // this stays import-light.
  if (process.argv[2] === 'doctor' || process.argv[2] === '--doctor') {
    const { runDoctorChecks, printDoctorReport, doctorExitCode, autoFixDoctor } = await import(
      pathToFileURL(path.join(rootDir, 'server', 'doctor.js')).href
    );
    const wantFix = process.argv.includes('--fix') || process.argv.includes('-f');
    if (wantFix) {
      const fixes = await autoFixDoctor();
      if (fixes.length === 0) {
        console.log('No auto-fixable issues found.');
      } else {
        console.log('Applied fixes:');
        for (const f of fixes) console.log(`  - ${f}`);
      }
      process.exit(0);
    }
    const checks = await runDoctorChecks();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ checks, exitCode: doctorExitCode(checks) }, null, 2));
    } else {
      process.stdout.write(printDoctorReport(checks).replace(/\*\*/g, '') + '\n');
    }
    process.exit(doctorExitCode(checks));
  }

  // Phase I (local accounts): `node bin/cli.js auth reset-password <username>`.
  // The local-machine password reset — the OS-auth equivalent the spec calls for.
  // There is no email/reset-link flow (offline-first desktop app); instead, running
  // this command PROVES machine ownership through filesystem access to data/users.json
  // itself — the same trust already behind the "delete users.json to reset auth"
  // escape hatch, and the same mechanism as Electron safeStorage/DPAPI without a new
  // native dependency. Never starts the server (works when it can't boot) and is
  // deliberately NOT exposed over HTTP. Prints a fresh recovery code on success.
  if (process.argv[2] === 'auth' && process.argv[3] === 'reset-password') {
    const username = process.argv[4];
    if (!username) {
      console.error('Usage: node bin/cli.js auth reset-password <username> [--password <new-password>]');
      process.exit(1);
    }
    const { loadUsers, hasUsers, adminResetPassword } = await import(
      pathToFileURL(path.join(rootDir, 'server', 'auth', 'userStore.js')).href
    );
    loadUsers();
    if (!hasUsers()) {
      console.error('Auth is not armed (no users registered) — nothing to reset.');
      process.exit(1);
    }
    let password = null;
    const flagAt = process.argv.indexOf('--password');
    if (flagAt !== -1) password = process.argv[flagAt + 1] || null;
    if (!password) {
      if (!process.stdin.isTTY) {
        console.error('No TTY — pass the new password with --password <new-password>.');
        process.exit(1);
      }
      password = await new Promise((resolve) => {
        // crlfDelay: Infinity — Windows ConPTY can otherwise double-fire 'line' events.
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity });
        rl.question('  New password (typing is visible): ', (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    }
    const result = await adminResetPassword(username, password);
    if (result.error) {
      console.error(`Reset failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`\n  Password reset for "${result.user.username}".`);
    console.log(`  New recovery code (store it somewhere safe — it is shown once): ${result.recoveryCode}\n`);
    process.exit(0);
  }

  // Default mode: web UI. Same probe-before-boot rule as the CLI chat mode above — booting
  // a second server next to a running console wasted a full cold start and left a duplicate
  // bound to a fallback port. The atomic boot claim keeps simultaneous launches to one server.
  const { port, attached, claimPath } = await acquireConsole();
  if (attached) {
    console.log(`\n  Console already running on port ${port} - opening it.`);
  } else {
    console.log(`\n  Console started on port ${port}.`);
  }
  if (claimPath) releaseClaimOnExit(claimPath);

  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Local Project Console ready at ${url}\n`);

  openBrowser(url);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
