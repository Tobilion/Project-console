#!/usr/bin/env node

// Stage the console server runtime for electron-builder packaging (2026-08-24).
//
// The desktop shell spawns the console server as a CHILD process from `process.resourcesPath`
// when packaged (see main.cjs's app.isPackaged branch), and electron-builder's extraResources
// copies this staging dir into resources/. The staged layout is exactly what a production
// server needs to run from a random directory:
//
//   server/       server source — the child's entry (server/index.js)
//   bin/          launcher helpers (bin/cli.js port-probing rules the shell mirrors)
//   data/         console runtime state (profile, conversations, dev-urls, schedules, ...)
//   index.html,
//   assets/       the BUILT frontend, placed INSIDE server/ because production mode serves
//                 static files from __dirname (server/index.js) with an SPA fallback
//   package.json,
//   package-lock.json   copied from the repo root so `npm ci --omit=dev` resolves the exact
//   node_modules/       dependency graph — production deps only (express, ws, the NLP stack,
//                       embeddings, ...). Dev tooling (vite/tsc/react) is NOT shipped.
//
// The stage dir is gitignored and rebuilt on every `npm run dist*` invocation, so a stale
// stage can never be packaged twice. The build itself (vite) runs against the repo root —
// only the output is redirected here, so the repo's own dist/ is never touched (the
// shadowing-bundle gotcha documented in CLAUDE.md).

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(desktopDir, '..');
const stageDir = path.join(desktopDir, 'stage');
const WIN = process.platform === 'win32';

function copyDir(src, dest, { exclude = [] } = {}) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, { exclude });
    else fs.copyFileSync(from, to);
  }
}

function run(cmd, args, cwd) {
  execFileSync(WIN ? `${cmd}.cmd` : cmd, args, { cwd, stdio: 'inherit', shell: WIN });
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

copyDir(path.join(rootDir, 'server'), path.join(stageDir, 'server'));
copyDir(path.join(rootDir, 'bin'), path.join(stageDir, 'bin'));
// A packaged install must start as a genuinely fresh user: the repo's own data/ holds the
// developer's LIVE state (profile, conversations, near-misses, telemetry, clipboard history,
// schedules, and opt-in settings like clipboardPersist / sandboxRiskyCommands). Shipping it
// would hand a new user another person's identity, their chat history, and settings they
// never consented to (2026-08-25). Every store creates its files/dirs lazily (mkdirSync
// recursive — boot was verified against an absent data/), so an EMPTY data/ dir is all a
// first boot needs; readProfile() defaults setupComplete to false, which triggers the same
// first-run onboarding wizard a real new user sees.
fs.mkdirSync(path.join(stageDir, 'data'), { recursive: true });
// The terminal CLI launcher: a .cmd that runs the bundled cli-client.js with the Electron
// binary as plain Node (ELECTRON_RUN_AS_NODE) — a .exe-only install gets full CLI access
// with zero npm/Node. Lands at resources/cli.cmd; the NSIS include creates its Start Menu
// shortcut (scripts/nsis-cli-shortcut.nsh).
fs.copyFileSync(path.join(desktopDir, 'cli.cmd'), path.join(stageDir, 'cli.cmd'));
fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(stageDir, 'package.json'));
fs.copyFileSync(path.join(rootDir, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));

// Frontend build directly into server/ — production mode serves static files from __dirname.
// The vite bin is invoked via its JS entry + process.execPath (NO shell): the repo path
// contains a space, and a shell splits `--outDir C:\...\Project console\...` at that space.
// The build lands in stage/www first, then merges into stage/server: vite's emptyOutDir
// treats any outDir INSIDE the repo root (desktop/stage/server is one) as safe to wipe, and
// it deleted the copied server source on the first attempt — www is a throwaway dir, so
// emptying it is exactly what we want.
console.log('[stage] Building the frontend (then merging into stage/server/) ...');
execFileSync(process.execPath, [
  path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'),
  'build',
  '--outDir',
  path.join(stageDir, 'www'),
], { cwd: rootDir, stdio: 'inherit' });
copyDir(path.join(stageDir, 'www'), path.join(stageDir, 'server'));
fs.rmSync(path.join(stageDir, 'www'), { recursive: true, force: true });

// Production-only dependency tree (native prebuilds for re2/sharp download during install).
console.log('[stage] Installing production dependencies into stage/node_modules/ ...');
run('npm', ['ci', '--omit=dev'], stageDir);

// Bundle the server entry into stage/dist/server.js (2026-08-26): server leaves are now
// partially TypeScript, and the staged runtime must run under plain Node (electron-as-node,
// no tsx shipped). main.cjs already prefers `dist/server.js` when present, so this slot is
// what it finds. --packages=external keeps every dependency external (resolved from the
// staged node_modules at runtime) AND keeps the guarded dynamic imports dynamic — the
// pdf-parse/pdfjs-dist DOMMatrix crash and the vite dev-only import (round-6 P0s) must not
// be inlined into a bundle that runs in production. esbuild resolves from the REPO root's
// node_modules (it is a root devDependency); only the output lands in the stage.
console.log('[stage] Bundling the server entry into stage/dist/server.js ...');
execFileSync(process.execPath, [
  path.join(rootDir, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  'server/index.js',
  '--bundle', '--platform=node', '--format=esm', '--packages=external',
  '--sourcemap', `--outfile=${path.join(stageDir, 'dist', 'server.js')}`,
], { cwd: rootDir, stdio: 'inherit' });

console.log(`[stage] Server runtime staged at ${stageDir}`);