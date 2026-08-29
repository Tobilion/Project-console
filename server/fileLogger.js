// Capped, rotating file logger for diagnostic persistence (2026-08-29, Round 3 Part E6).
// The server's pino logger (logger.js) writes to stdout; the desktop shell and daemon capture
// that, but a standalone `npm run dev` crash has no file record — the terminal window closes.
// This module provides a file tee that survives that, plus a CLI/desktop variant for their own
// crash logs. Cap is 500KB per file, 3 rotations (max ~1.5MB), so a long-running install never
// grows unbounded. Functional logs (schedule-log.md, auto-start-log.md, action-history.jsonl)
// stay separate — those record what the app DID, this records what WENT WRONG and lifecycle.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDataDir } from './dataPath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = getDataDir();
const LOG_DIR = path.join(dataDir, '..', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const MAX_BYTES = 512 * 1024; // 500KB per file
const MAX_ROTATIONS = 3;

function rotateIfNeeded(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.size < MAX_BYTES) return;
  } catch { return; }
  // server.log -> server.log.1 -> server.log.2 -> server.log.3 (oldest pruned)
  for (let i = MAX_ROTATIONS; i >= 1; i--) {
    const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const to = `${filePath}.${i}`;
    try {
      if (fs.existsSync(from)) {
        if (i === MAX_ROTATIONS && fs.existsSync(to)) fs.unlinkSync(to);
        fs.renameSync(from, to);
      }
    } catch {}
  }
}

export function appendLogFile(filename, line) {
  const filePath = path.join(LOG_DIR, filename);
  try {
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line + '\n', 'utf8');
  } catch {}
}

export function getLogDir() {
  return LOG_DIR;
}

export function listLogFiles() {
  try {
    return fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log')).sort();
  } catch { return []; }
}

export function readLogFile(filename, maxBytes = 256 * 1024) {
  const filePath = path.join(LOG_DIR, filename);
  try {
    const st = fs.statSync(filePath);
    if (st.size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
    // Tail: last maxBytes
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const firstNL = text.indexOf('\n');
    return (firstNL >= 0 ? text.slice(firstNL + 1) : text);
  } catch { return null; }
}

// Where-are-my-logs answer for chat/CLI.
export function whereAreLogs() {
  return `Logs are in \`${LOG_DIR}\`:\n- \`server.log\` — server lifecycle + uncaught stacks\n- \`cli.log\` — CLI launcher + picker crashes\n- \`daemon.log\` — background daemon output\n- \`desktop-crash.log\` — desktop shell crashes (in userData on packaged installs)\nEach file caps at ~500KB with 3 rotations (~1.5MB max per stream).`;
}
