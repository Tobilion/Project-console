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
  !process.env.CONSOLE_DESKTOP && !!process.stdout.isTTY && prettyResolvable() && !process.env.PINO_PLAIN
  // The CLI launcher runs the server in-process: pretty output would interleave with the
  // terminal chat, so it stays plain there (and goes to stderr, see fileDestination).
  && process.env.CONSOLE_LOG_TO_STDERR !== '1';

// File tee: every pino line also goes to logs/server.log (capped/rotated). Desktop's main.cjs
// has its own desktop-crash.log tee; this covers the dev/daemon/npm case where stdout is not
// captured. Never throws — a full disk or missing logs/ must not take the server down.
//
// CONSOLE_LOG_TO_STDERR=1 sends the console output to stderr instead of stdout. The CLI
// launcher boots the server IN-PROCESS, so the server's log lines used to land in the
// terminal's stdout — in the middle of the chat answer, and in the middle of the --json
// stream, where a JSON consumer would choke on a log line. stderr keeps stdout clean for
// both.
function fileDestination() {
  const toStderr = process.env.CONSOLE_LOG_TO_STDERR === '1';
  return {
    write(str) {
      try {
        if (toStderr) process.stderr.write(str);
        else process.stdout.write(str);
      } catch {}
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