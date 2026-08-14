#!/usr/bin/env node

import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';

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

async function main() {
  // Phase 3 hook: `npx local-project-console init [targetDir]`
  if (process.argv[2] === 'init') {
    const targetDir = path.resolve(process.argv[3] || process.cwd());
    const initPath = path.resolve(rootDir, 'server', 'configInitializer.js');
    const { initConfig } = await import(pathToFileURL(initPath).href);
    await initConfig(targetDir);
    process.exit(0);
  }

  // CLI chat mode: `npx local-project-console cli [--dir <path>] [--project <name>]`.
  // Starts the server in-process (same boot as the web mode), then hands the terminal to
  // server/cli-client.js instead of opening the browser — the same chat mode start.bat's
  // [C] option reaches. The client scans ports 3000-3009 and finds the in-process server;
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

  const port = await startServer();

  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Local Project Console ready at ${url}\n`);

  // Cross-platform browser open (Windows: use cmd /c start since 'start' is a cmd.exe builtin)
  const isWin = process.platform === 'win32';
  const openCmd = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const openArgs = isWin ? ['/c', 'start', '', url] : [url];
  const child = spawn(openCmd, openArgs, { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
