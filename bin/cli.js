#!/usr/bin/env node

import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function startServer() {
  // Default mode: launch the server in production
  process.env.NODE_ENV = 'production';

  // Prefer the esbuild bundle (dist/server.js), fall back to the source entry
  const bundlePath = path.join(rootDir, 'dist', 'server.js');
  const serverPath = path.join(rootDir, 'server', 'index.js');
  const entry = fs.existsSync(bundlePath) ? bundlePath : serverPath;

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
  await import(pathToFileURL(entry).href);

  // Poll for the global signal set in index.js's onListening handler
  const MAX_WAIT = 30000;
  const POLL = 200;
  let waited = 0;
  while (typeof globalThis.__consoleServerPort !== 'number' && waited < MAX_WAIT) {
    await new Promise((r) => setTimeout(r, POLL));
    waited += POLL;
  }

  const port = globalThis.__consoleServerPort;
  if (!port) {
    console.error('\nServer failed to bind to a port within 30s. Check for port conflicts or startup errors above.');
    process.exit(1);
  }
  return port;
}

// start.bat-equivalent helpers: probe for an already-running server, the W/C/Q menu, and a
// cross-platform browser open. All three mirror the batch launcher's behavior exactly so
// `npm run launcher` is a terminal-native replacement for the .bat file.

async function probeRunningPort() {
  // A running console server answers /api/projects on one of 3000-3019. When one is found
  // the launcher hands off to it instead of starting a duplicate instance (which would only
  // bind a fallback port and leave a second server behind).
  for (let i = 3000; i <= 3019; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`http://127.0.0.1:${i}/api/projects`, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.projects) && data.projects.length > 0) return i;
      }
    } catch {
      // Port not answering (or probe aborted) - keep scanning.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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

  console.log('\n  [+] Checking for a running server on ports 3000-3019...');
  const runningPort = await probeRunningPort();

  if (choice === 'w') {
    if (runningPort) {
      console.log(`\x1b[32m  [+] Server already running on port ${runningPort} - opening browser.\x1b[0m`);
      openBrowser(`http://localhost:${runningPort}`);
      process.exit(0);
    }
    console.log('\x1b[32m  [+] Starting server and opening the browser...\x1b[0m');
    const port = await startServer();
    openBrowser(`http://localhost:${port}`);
    console.log(`\n  Local Project Console ready at http://127.0.0.1:${port}\n`);
    return;
  }

  // CLI chat mode - same as bin/cli.js's `cli` mode, but respects an already-running server.
  if (runningPort) {
    console.log(`\x1b[32m  [+] Server already running on port ${runningPort} - skipping start.\x1b[0m`);
  } else {
    console.log('\x1b[33m  [+] Starting server...\x1b[0m');
    await startServer();
  }
  const cliClientPath = path.join(rootDir, 'server', 'cli-client.js');
  const child = spawn(process.execPath, [cliClientPath, ...process.argv.slice(3)], {
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
    const port = await startServer();
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  Local Project Console ready at ${url}`);
    console.log('  CLI chat mode — type "exit" or Ctrl+C to quit.\n');
    const cliClientPath = path.join(rootDir, 'server', 'cli-client.js');
    const child = spawn(process.execPath, [cliClientPath, ...process.argv.slice(3)], {
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
    const { runDoctorChecks, printDoctorReport, doctorExitCode } = await import(
      pathToFileURL(path.join(rootDir, 'server', 'doctor.js')).href
    );
    const checks = await runDoctorChecks();
    process.stdout.write(printDoctorReport(checks).replace(/\*\*/g, '') + '\n');
    process.exit(doctorExitCode(checks));
  }

  const port = await startServer();

  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Local Project Console ready at ${url}\n`);

  openBrowser(url);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
