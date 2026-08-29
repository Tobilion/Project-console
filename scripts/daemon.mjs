#!/usr/bin/env node

// Cross-platform background daemon for the console server (2026-08-24).
//
// The Windows PowerShell scripts (start-daemon.ps1 / stop-daemon.ps1 / add-to-startup.ps1)
// remain the Windows-native story; this Node implementation gives macOS and Linux the same
// start/stop/kill-by-port behavior and is the single entry the npm scripts use everywhere.
//
// Commands:
//   daemon.mjs start            Start the server detached; poll 3000-3019 for the bound port
//                               and write logs/daemon.port + logs/daemon.pid.
//   daemon.mjs stop             Read logs/daemon.port, VERIFY each listening PID's command
//                               line is the console server, then kill the process tree.
//                               A recycled port can never kill an unrelated service.
//   daemon.mjs status           Report whether a daemon is running and on which port.
//   daemon.mjs kill <port>      Kill-by-port with the same command-line verification.
//
// Startup registration (Windows add-to-startup.ps1) has no POSIX equivalent here by design:
// macOS launchd / Linux systemd user units are user-specific and out of scope; a crontab
// @reboot line running `daemon.mjs start` is the documented POSIX alternative.

import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const logDir = path.join(rootDir, 'logs');

process.on('uncaughtException', (err) => {
  const stack = err && err.stack ? err.stack : String(err);
  try { console.error('Daemon uncaughtException:', stack); } catch {}
  try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, 'daemon-error.log'), `${new Date().toISOString()} uncaughtException: ${stack}\n`); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const stack = reason instanceof Error ? reason.stack : String(reason);
  try { console.error('Daemon unhandledRejection:', stack); } catch {}
  try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, 'daemon-error.log'), `${new Date().toISOString()} unhandledRejection: ${stack}\n`); } catch {}
  process.exit(1);
});
const PORT_FILE = path.join(logDir, 'daemon.port');
const PID_FILE = path.join(logDir, 'daemon.pid');
const LOG_FILE = path.join(logDir, 'daemon.log');
const SERVER_ENTRY = path.join(rootDir, 'server', 'index.js');
// Port range matches server/portConfig.js (daemon is .mjs, not .ts, and must run without
// importing the server graph — keep in sync when portConfig.js changes).
const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_PORT_ATTEMPTS = 20;
const MAX_PORT = BASE_PORT + MAX_PORT_ATTEMPTS - 1; // 3000-3019 (widened 2026-08-26)
const BOOT_TIMEOUT_MS = 90_000; // cold boot ~41s (embeddings + NLP + discovery); 90s ceiling
const POLL_MS = 1500;
const WIN = process.platform === 'win32';

const esc = (s) => JSON.stringify(String(s));

function log(msg) {
  console.log(msg);
}

// --- port discovery -------------------------------------------------------------

async function probePort(port, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: controller.signal });
    if (!res.ok) return false;
    // A console server answers with a {projects: [...]} shape — a foreign 200 must not count.
    const data = await res.json();
    return Array.isArray(data.projects);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function findConsolePort() {
  for (let i = BASE_PORT; i <= MAX_PORT; i++) {
    if (await probePort(i)) return i;
  }
  return null;
}

// --- process lookup / verification ----------------------------------------------

function cmdlineForPid(pid) {
  try {
    if (WIN) {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { windowsHide: true, encoding: 'utf8', timeout: 10_000 },
      ).trim();
      return out || null;
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 }).trim() || null;
    }
    // Linux
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return raw.split('\0').filter(Boolean).join(' ');
    } catch {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 }).trim() || null;
    }
  } catch {
    return null;
  }
}

// The console server's command line always contains its entry module (source or the esbuild
// bundle) under this repo — a recycled port pointing at any OTHER process must never match.
function isConsoleProcess(pid) {
  const cmdline = cmdlineForPid(pid);
  if (!cmdline) return false;
  const norm = cmdline.replace(/\\/g, '/').toLowerCase();
  return norm.includes('server/index.js') || norm.includes('dist/server.js') || norm.includes(path.basename(rootDir).toLowerCase());
}

function listenersOnPort(port) {
  const pids = new Set();
  try {
    if (WIN) {
      // 2>$null: Get-NetTCPConnection throws a CimJobException when nothing listens on the
      // port (the normal post-kill state) — that is not an error for us.
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess 2>$null`],
        { windowsHide: true, encoding: 'utf8', timeout: 10_000 },
      );
      for (const line of out.split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
    } else {
      // lsof is present on macOS by default and on essentially every Linux desktop; it
      // avoids parsing `ss`/`netstat` locale-dependent text.
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 10_000 });
      for (const line of out.split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
    }
  } catch {
    // No listeners (lsof exits 1 when nothing matches) or the lookup failed.
  }
  return [...pids];
}

function killTree(pid) {
  try {
    if (WIN) {
      // Synchronous tree kill — the async-spawn variant races the SIGTERM and can leave the
      // grandchild alive (same class as the executor's confirmed 2026-08-10 orphan bug).
      execFileSync('taskkill', ['/f', '/t', '/pid', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
      return;
    }
    // Our own daemon spawns detached (own process group) — kill the whole group. A foreign
    // console process (user-started in another terminal) is not a group leader; fall back to
    // signaling just the pid, same as the executor's pre-fix behavior.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
  } catch (err) {
    throw new Error(`Could not kill PID ${pid}: ${err.message}`);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- commands -------------------------------------------------------------------

async function stopOnPort(port, { quiet = false } = {}) {
  if (!Number.isInteger(port)) {
    log('No valid port given.');
    return 1;
  }
  const pids = listenersOnPort(port).filter(isConsoleProcess);
  if (pids.length === 0) {
    if (!quiet) log(`No console process listening on port ${port} — nothing to stop.`);
    return 0;
  }
  for (const pid of pids) {
    log(`Stopping console server (PID ${pid}) on port ${port}...`);
    try {
      killTree(pid);
    } catch (err) {
      log(`WARN: ${err.message}`);
    }
  }
  // Post-kill verification (1s grace) — never report success over a survivor.
  await new Promise((r) => setTimeout(r, 1000));
  const remaining = listenersOnPort(port).filter(isConsoleProcess);
  if (remaining.length > 0) {
    log(`WARN: port ${port} is still held by PID(s) ${remaining.join(', ')} — check logs/daemon.log.`);
    return 1;
  }
  log(`Port ${port} is free.`);
  return 0;
}

async function cmdStart() {
  fs.mkdirSync(logDir, { recursive: true });
  const running = await findConsolePort();
  if (running !== null) {
    log(`A console server is already running on port ${running} — nothing to start.`);
    fs.writeFileSync(PORT_FILE, String(running), 'ascii');
    return 0;
  }
  // Stop a previously recorded daemon (verified kill — never an unrelated service).
  if (fs.existsSync(PORT_FILE)) {
    const old = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    if (Number.isFinite(old)) await stopOnPort(old, { quiet: true });
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    log(`ERROR: server entry not found at ${SERVER_ENTRY}`);
    return 1;
  }
  log('Starting console server daemon...');
  const logStream = fs.openSync(LOG_FILE, 'a');
  // --import tsx: server leaves may be TypeScript (7 safety modules, 2026-08-26) — plain Node
  // cannot resolve them. tsx is a devDependency; the daemon is a repo-root script, where it
  // is always installed (the published npm package ships the dist/server.js bundle instead).
  // detached: own process group on POSIX so `stop` can kill the whole tree; stdio to the log.
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: rootDir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logStream, logStream],
  });
  child.on('error', (err) => {
    log(`ERROR: could not start the server: ${err.message}`);
    process.exit(1);
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'ascii');
  log(`Daemon started (PID ${child.pid}). Waiting for the server to bind (up to ${BOOT_TIMEOUT_MS / 1000}s)...`);

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let bound = null;
  while (Date.now() < deadline && bound === null) {
    bound = await findConsolePort();
    if (bound === null) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (bound === null) {
    log(`Server did not become ready within ${BOOT_TIMEOUT_MS / 1000}s — check ${LOG_FILE}.`);
    return 1;
  }
  fs.writeFileSync(PORT_FILE, String(bound), 'ascii');
  log(`Console ready at http://127.0.0.1:${bound}`);
  log(`Log file: ${LOG_FILE}`);
  log('Stop it with `npm run daemon:stop`.');
  return 0;
}

async function cmdStop() {
  if (!fs.existsSync(PORT_FILE)) {
    log('No daemon port file found — the server may already be stopped.');
    for (const f of [PID_FILE, PORT_FILE]) fs.rmSync(f, { force: true });
    return 0;
  }
  const port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
  if (!Number.isFinite(port)) {
    log('Port file is unreadable — removing stale files.');
    for (const f of [PID_FILE, PORT_FILE]) fs.rmSync(f, { force: true });
    return 0;
  }
  // The recorded wrapper PID may be gone while the server lives (or vice versa) — the
  // listening-PID lookup + command-line verification is the source of truth, not the pid file.
  const recordedPid = fs.existsSync(PID_FILE) ? parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) : NaN;
  const rc = await stopOnPort(port);
  if (Number.isFinite(recordedPid) && pidAlive(recordedPid) && listenersOnPort(port).length === 0) {
    // Wrapper outlived the server (rare) — clean it up so no half-daemon remains.
    try { killTree(recordedPid); } catch {}
  }
  fs.rmSync(PID_FILE, { force: true });
  fs.rmSync(PORT_FILE, { force: true });
  return rc;
}

async function cmdStatus() {
  const running = await findConsolePort();
  if (running !== null) {
    log(`Console server is running on port ${running}.`);
    return 0;
  }
  log('No console server is running.');
  return 1;
}

async function cmdKill(portArg) {
  const port = parseInt(portArg, 10);
  if (!Number.isFinite(port)) {
    log('Usage: daemon.mjs kill <port>');
    return 1;
  }
  return stopOnPort(port);
}

// --- main -----------------------------------------------------------------------

// Natural exit with an explicit code instead of process.exit(): the fetch probes keep undici
// keep-alive sockets alive at exit time, and calling process.exit() while those async handles
// are closing trips a libuv assertion on Windows (`UV_HANDLE_CLOSING`, win/async.c) — the
// spawned server child is unref'd, so the loop drains and Node exits with exitCode.
const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'start':
    process.exitCode = await cmdStart();
    break;
  case 'stop':
    process.exitCode = await cmdStop();
    break;
  case 'status':
    process.exitCode = await cmdStatus();
    break;
  case 'kill':
    process.exitCode = await cmdKill(arg);
    break;
  default:
    log('Usage: node scripts/daemon.mjs <start|stop|status|kill <port>>');
    log('  start   — spawn the server detached, write logs/daemon.port + daemon.pid');
    log('  stop    — verified kill-by-port (command-line check; never an unrelated service)');
    log('  status  — report whether the console server is running');
    log('  kill N  — kill whatever console process listens on port N');
    process.exitCode = 1;
}