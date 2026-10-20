// check-launch-race.js — end-to-end concurrent-launch test (2026-10-20, hardening pass 2).
//
// THE RACE THIS GUARDS: several launchers started at the same instant with no console
// running all probed, all found nothing, and all booted their own server. Measured on the
// developer's machine: three concurrent `node bin/cli.js cli` launches bound ports 3000,
// 3001 AND 3002 at the same time — three copies of the embedding model, three consoles, and
// the losing clients' terminals flooded with the server's own boot logs.
//
// This script runs the REAL launchers (not a mock) and asserts:
//   1. at most ONE console server is bound while the launchers run,
//   2. no listener is left behind afterwards,
//   3. every client either answered or failed with a clear message.
//
// It is slow (a cold boot is 13-45s), so it is NOT part of the pre-commit gate — run it
// with `npm run check-launch-race`. The fast unit coverage of the same contract lives in
// check-tools (BOOT-CLAIM and PORT-PROBE batteries).
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENTS = parseInt(process.argv[2] || '3', 10);
const BASE = 3000;
const RANGE = 20;

// Ports the console could bind inside the range, and whether anything is listening there.
function listeningPorts() {
  const ports = new Set();
  let out = '';
  try {
    out = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
  } catch {
    return ports;
  }
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/);
    if (!m) continue;
    const p = parseInt(m[1], 10);
    if (p >= BASE && p < BASE + RANGE) ports.add(p);
  }
  return ports;
}

const before = listeningPorts();
if (before.size > 0) {
  console.error(`A console is already running on ${[...before].join(', ')} — stop it first (this test needs an empty port range).`);
  process.exit(2);
}

console.log(`Launching ${CLIENTS} CLIs at once with no console running...`);
const started = Date.now();
const kids = [];
for (let i = 0; i < CLIENTS; i++) {
  kids.push({
    index: i,
    proc: spawn(process.execPath, ['bin/cli.js', 'cli', '--project', 'Oja', '--query', 'what time is it'], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  });
}

const observed = new Set();
const sampler = setInterval(() => {
  for (const p of listeningPorts()) observed.add(p);
}, 200);

const results = [];
for (const k of kids) {
  let out = '';
  let err = '';
  k.proc.stdout.on('data', (d) => { out += d; });
  k.proc.stderr.on('data', (d) => { err += d; });
  results.push(new Promise((resolve) => k.proc.on('exit', (code) => resolve({ index: k.index, code, out, err }))));
}
const settled = await Promise.all(results);
clearInterval(sampler);
const after = listeningPorts();

const answered = settled.filter((r) => r.code === 0 && /\d{1,2}:\d{2}/.test(r.out)).length;
const failedWithMessage = settled.filter((r) => r.code !== 0 && r.err.trim().length > 0).length;
const silentFailures = settled.filter((r) => r.code !== 0 && !r.err.trim()).length;

console.log(`\n=== concurrent launch race (${CLIENTS} clients) ===`);
console.log(`wall time: ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`ports bound while the launchers ran: ${JSON.stringify([...observed].sort((a, b) => a - b))}`);
console.log(`ports still bound afterwards: ${JSON.stringify([...after].sort((a, b) => a - b))}`);
console.log(`answered: ${answered}/${settled.length}   failed-with-a-message: ${failedWithMessage}   failed silently: ${silentFailures}`);
for (const r of settled) {
  console.log(`  cli ${r.index}: exit=${r.code} answered=${/\d{1,2}:\d{2}/.test(r.out)}`);
}

let failed = false;
const fail = (msg) => { failed = true; console.error(`FAIL: ${msg}`); };

if (observed.size > 1) {
  fail(`more than one console was bound at the same time (${[...observed].join(', ')}) — the boot claim did not hold`);
}
if (after.size > 0) {
  fail(`a listener was left behind (${[...after].join(', ')}) — an orphan console`);
}
if (silentFailures > 0) {
  fail(`${silentFailures} client(s) failed without a message — every failure must tell the user what to do`);
}
if (answered === 0) {
  fail('no client got an answer — the launchers did not manage to reach a console at all');
}

if (failed) {
  console.error('\ncheck-launch-race: FAILED');
  process.exit(1);
}
console.log('\ncheck-launch-race: OK — one console, no orphans, every failure explained');
process.exit(0);
