// Standalone `console doctor` (2026-08-26) — proactive sibling of the health check: probes
// the machine-side failure points BEFORE they hang something, and it works when the console
// itself won't boot (the exact state a doctor must diagnose).
//
// Hard constraint: this module must NOT import the server graph (semanticMatcher, executor,
// ollama, ...). It is invoked from bin/cli.js's `doctor` subcommand and from
// `node --import tsx server/doctor.js` — both run without a running server, and importing
// the server would defeat that. Node builtins + tiny inline helpers only.
//
// Status model per check: 'ok' | 'warn' | 'fail'. Exit code: 0 all ok, 1 any warn, 2 any fail.

import fs from 'fs';
import net from 'net';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.CONSOLE_DATA_DIR ? path.resolve(process.env.CONSOLE_DATA_DIR) : path.join(rootDir, 'data');
const cacheDir = path.join(rootDir, '.cache');
const logDir = path.join(rootDir, 'logs');
const WIN = process.platform === 'win32';
const BASE_PORT = 3000;
const MAX_PORT = 3019; // must match every launcher (widened 2026-08-26)
const OLLAMA_DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

// --- port probe ----------------------------------------------------------------

function tcpOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function listenersOnPort(port) {
  // Best-effort owning-PID lookup; null when the platform probe fails (the port still
  // reports occupied either way).
  return new Promise((resolve) => {
    if (!WIN) return resolve(null);
    exec(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess 2>$null"`,
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const pids = stdout.split(/\r?\n/).map((l) => parseInt(l.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
        resolve(pids.length > 0 ? pids.join(',') : null);
      },
    );
  });
}

async function checkPorts() {
  const ports = [];
  for (let i = BASE_PORT; i <= MAX_PORT; i++) {
    if (await tcpOpen(i)) ports.push(i);
  }
  if (ports.length === 0) {
    return { name: 'Ports 3000-3019', status: 'ok', detail: 'all free — the server can bind without skipping' };
  }
  const detail = [];
  for (const port of ports) {
    const owners = await listenersOnPort(port);
    detail.push(`${port}${owners ? ` (PID ${owners})` : ''}`);
  }
  return {
    name: 'Ports 3000-3019',
    status: 'warn',
    detail: `occupied: ${detail.join(', ')} — the console skips busy ports via its fallback loop, so this is informational unless a fallback is full`,
  };
}

// --- daemon --------------------------------------------------------------------

function isConsoleCommandLine(cmdline) {
  if (!cmdline) return false;
  const norm = cmdline.replace(/\\/g, '/').toLowerCase();
  return norm.includes('server/index.js') || norm.includes('dist/server.js') || norm.includes(path.basename(rootDir).toLowerCase());
}

async function probeConsolePort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.projects);
  } catch {
    return false;
  }
}

async function checkDaemon() {
  const portFile = path.join(logDir, 'daemon.port');
  if (!fs.existsSync(portFile)) {
    return { name: 'Daemon', status: 'ok', detail: 'not started — expected when you use the launcher/dev directly' };
  }
  const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
  if (!Number.isFinite(port)) {
    return { name: 'Daemon', status: 'warn', detail: 'daemon.port is unreadable (stale file?)' };
  }
  if (!(await probeConsolePort(port))) {
    return { name: 'Daemon', status: 'fail', detail: `recorded on port ${port} but nothing answers there — the daemon died` };
  }
  return { name: 'Daemon', status: 'ok', detail: `running on port ${port}` };
}

// --- embedding model ------------------------------------------------------------

function checkEmbeddingModel() {
  if (!fs.existsSync(cacheDir)) {
    return { name: 'Embedding model', status: 'warn', detail: 'not downloaded yet — first boot downloads ~23MB (matching falls back to fuzzy/NLP until then)' };
  }
  const entries = fs.readdirSync(cacheDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 0) {
    return { name: 'Embedding model', status: 'warn', detail: '.cache/ is empty — first boot downloads the model' };
  }
  return { name: 'Embedding model', status: 'ok', detail: `present in .cache/ (${entries.map((e) => e.name).join(', ')})` };
}

// --- writability ----------------------------------------------------------------

async function checkWritable() {
  const probe = (dir) =>
    new Promise((resolve) => {
      const file = path.join(dir, `.doctor-probe-${process.pid}.tmp`);
      try {
        fs.writeFileSync(file, 'probe');
        fs.rmSync(file, { force: true });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  const dataOk = await probe(dataDir);
  const cacheOk = !fs.existsSync(cacheDir) ? true : await probe(cacheDir);
  if (dataOk && cacheOk) {
    return { name: 'Runtime writability', status: 'ok', detail: 'data/ (and .cache/) accept writes' };
  }
  return {
    name: 'Runtime writability',
    status: 'fail',
    detail: `data/ ${dataOk ? 'ok' : 'NOT WRITABLE'}${fs.existsSync(cacheDir) ? `, .cache/ ${cacheOk ? 'ok' : 'NOT WRITABLE'}` : ''} — telemetry/dev-urls/schedules and the embedding download need these`,
  };
}

// --- Ollama --------------------------------------------------------------------

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_DEFAULT_HOST}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { name: 'Ollama', status: 'warn', detail: `unreachable (HTTP ${res.status}) — AI mode needs it, trigger mode does not` };
    const body = await res.json().catch(() => null);
    return { name: 'Ollama', status: 'ok', detail: `reachable at ${OLLAMA_DEFAULT_HOST}${body?.version ? ` (${body.version})` : ''}` };
  } catch {
    return { name: 'Ollama', status: 'warn', detail: `unreachable at ${OLLAMA_DEFAULT_HOST} — AI mode needs it, trigger mode does not` };
  }
}

// --- update status --------------------------------------------------------------

async function checkUpdate() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const latest = (await res.json()).version;
    const current = pkg.version.split('.').map(Number);
    const remote = latest.split('.').map(Number);
    const behind = remote.some((v, i) => v > (current[i] || 0)) && !remote.every((v, i) => v <= (current[i] || 0));
    return behind
      ? { name: 'Update', status: 'warn', detail: `${pkg.version} installed, ${latest} published — run \`update console\` when convenient` }
      : { name: 'Update', status: 'ok', detail: `${pkg.version} is the latest` };
  } catch {
    return { name: 'Update', status: 'warn', detail: 'registry unreachable — offline or network blocked (expected for the zero-network floor)' };
  }
}

// --- tooling + disk --------------------------------------------------------------

async function checkTooling() {
  const lookups = { npm: 'npm', node: 'node', git: 'git' };
  const missing = [];
  for (const [name, exe] of Object.entries(lookups)) {
    try {
      await execFileAsync(WIN ? 'where' : 'which', [exe], { timeout: 3000, windowsHide: true });
    } catch {
      missing.push(name);
    }
  }
  if (missing.length === 0) {
    return { name: 'Tooling', status: 'ok', detail: 'npm, node and git are all on PATH' };
  }
  return { name: 'Tooling', status: 'warn', detail: `missing on PATH: ${missing.join(', ')} — many intents (and the npm package itself) assume them` };
}

async function checkDisk() {
  return new Promise((resolve) => {
    const drive = path.parse(dataDir).root[0]; // e.g. "C"
    exec(
      `powershell -NoProfile -Command "(Get-PSDrive -Name '${drive}' | Select-Object -ExpandProperty Free) / 1GB"`,
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        const gb = parseFloat(stdout?.trim() ?? '');
        if (err || !Number.isFinite(gb)) return resolve({ name: 'Disk', status: 'ok', detail: 'free-space probe unavailable on this platform' });
        const status = gb < 1 ? 'fail' : gb < 5 ? 'warn' : 'ok';
        const verdict = gb < 1 ? 'critically low' : gb < 5 ? 'low' : 'fine';
        resolve({ name: 'Disk', status, detail: `${gb.toFixed(1)} GB free on ${drive}: — ${verdict}` });
      },
    );
  });
}

// --- public API ----------------------------------------------------------------

export async function runDoctorChecks() {
  const checks = await Promise.all([
    checkPorts(),
    checkDaemon(),
    checkEmbeddingModel(),
    checkWritable(),
    checkOllama(),
    checkUpdate(),
    checkTooling(),
    checkDisk(),
  ]);
  return checks;
}

export function doctorExitCode(checks) {
  if (checks.some((c) => c.status === 'fail')) return 2;
  if (checks.some((c) => c.status === 'warn')) return 1;
  return 0;
}

export function printDoctorReport(checks) {
  const lines = ['**Console doctor**', ''];
  for (const c of checks) {
    const mark = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`- [${mark}] ${c.name}: ${c.detail}`);
  }
  lines.push('');
  const worst = doctorExitCode(checks);
  lines.push(worst === 0 ? 'All checks pass.' : worst === 1 ? 'Warnings above — nothing blocking, but worth a look.' : 'Failures above — fix these before relying on the console.');
  return lines.join('\n');
}

// Standalone entry: `node --import tsx server/doctor.js` (also wired as `npm run doctor`).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const checks = await runDoctorChecks();
  process.stdout.write(printDoctorReport(checks).replace(/\*\*/g, '') + '\n');
  process.exitCode = doctorExitCode(checks);
}