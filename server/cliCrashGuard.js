// CLI crash guard (2026-10-20).
//
// This module MUST be the FIRST import of the CLI client: ESM evaluates every import of a
// module before the module body runs, so handlers registered in the body of cli-client.js
// are installed too late to catch a failure during the import of @clack/prompts, chalk,
// boxen, figlet or any of the server modules. A crash there produced no message and no
// log file at all — the process simply disappeared, which is exactly the "the CLI just
// crashed" report this guard exists to make diagnosable.
//
// It also handles EPIPE on stdout/stderr: piping the CLI into a command that exits early
// (`... | head -5`, `| Select-Object -First 5`) closes the pipe while the CLI is still
// writing. Node treats that as an unhandled stream error and kills the process with a
// stack trace; a closed pipe is a normal way to stop reading, so the CLI exits quietly.

import { appendLogFile } from './fileLogger.js';

const LABEL = process.env.CLI_CRASH_LABEL || 'CLI';

function describe(err) {
  if (err instanceof Error) return err.stack || err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function report(kind, err) {
  const detail = describe(err);
  try {
    appendLogFile('cli.log', `${new Date().toISOString()} ${kind}: ${detail}`);
  } catch { /* logging must never mask the crash */ }
  try {
    process.stderr.write(`\n${LABEL} ${kind}: ${detail}\n`);
    process.stderr.write(`${LABEL} crashed. The full stack was written to logs/cli.log.\n`);
  } catch { /* stderr may itself be the broken pipe */ }
  // Give the writes a tick to flush before exiting, then leave with a non-zero code so a
  // script can tell a crash from a clean exit.
  setTimeout(() => process.exit(1), 100);
}

process.on('uncaughtException', (err) => report('crashed', err));
process.on('unhandledRejection', (reason) => report('unhandled rejection', reason));

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      // The reader went away (piped into head, a closed pager, a killed parent). Nothing to
      // report and nothing to fix — stop writing and leave quietly.
      process.exit(0);
    }
  });
}
