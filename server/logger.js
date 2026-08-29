// Structured logging (2026-08-26) — pino, one module, imported by server modules.
//
// Format policy: plain JSON lines in production (pipeable/greppable; the desktop shell,
// the daemon log, and CI all consume stdout), pretty-printed in interactive dev terminals.
// The pretty transport is ONLY attached when all three hold: not the desktop shell
// (CONSOLE_DESKTOP), stdout is a TTY, and pino-pretty is resolvable (it is a devDependency —
// a production `npm ci --omit=dev` must never reference it).
//
// Level policy: LOG_LEVEL env overrides (default 'info'). Use log.info for lifecycle and
// notable events, log.warn for recoverable anomalies, log.error for failures, log.debug for
// high-frequency internals. Do NOT log secrets, tokens, or user file contents.

import pino from 'pino';
import { createRequire } from 'module';
import { appendLogFile } from './fileLogger.js';

const require = createRequire(import.meta.url);

function prettyResolvable() {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const usePretty =
  !process.env.CONSOLE_DESKTOP && !!process.stdout.isTTY && prettyResolvable() && !process.env.PINO_PLAIN;

// File tee: every pino line also goes to logs/server.log (capped/rotated). Desktop's main.cjs
// has its own desktop-crash.log tee; this covers the dev/daemon/npm case where stdout is not
// captured. Never throws — a full disk or missing logs/ must not take the server down.
function fileDestination() {
  return {
    write(str) {
      try { process.stdout.write(str); } catch {}
      const line = str.endsWith('\n') ? str.slice(0, -1) : str;
      // Fire-and-forget file write — never block the event loop for a log line.
      try { appendLogFile('server.log', line); } catch {}
    },
  };
}

const pinoDest = usePretty
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } })
  : fileDestination();

export const log = usePretty
  ? pino(
      { level: process.env.LOG_LEVEL || 'info', base: undefined },
      pinoDest,
    )
  : pino({ level: process.env.LOG_LEVEL || 'info', base: undefined }, fileDestination());