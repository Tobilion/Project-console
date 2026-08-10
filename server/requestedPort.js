// Phase 5 (2026-08-10): "run the site on port 3010" / "serve the site on port 3040" — an
// explicit user-requested port for run commands. Parsed from the chat input and applied to the
// resolved command with the same platform branching as buildPortRetryCommand (executorPorts.js).
// Deliberately conservative: only applied by the run handlers (npm_run / run_project / their
// npm start|serve shortcuts), never to arbitrary commands, and only for a plain integer port.

/**
 * Extracts a user-requested port like "on port 3010" / "at port 3010" / "port 3040" from a
 * run command's chat input. Returns null when there is no usable port.
 */
export function extractRequestedPort(input) {
  const m =
    input.match(/\b(?:on|at|using|to)\s+port\s+(\d{2,5})\b/i) ||
    input.match(/\bport\s+(\d{2,5})\b/i);
  if (!m) return null;
  const port = parseInt(m[1], 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Rewrites a resolved run command to use the requested port:
 * - an explicit `--port`/`-p` flag already in the command is replaced in place;
 * - a Vite-shaped script gets `-- --port=N` so the flag actually reaches vite through npm
 *   (vite does not read the PORT env var);
 * - anything else gets the PORT env prefix (react-scripts/serve/Express convention), using
 *   the same `set PORT=N&&` / `PORT=N ` platform split as buildPortRetryCommand.
 *
 * @param {string} command  the resolved command (e.g. "npm run dev")
 * @param {number|null} port  the requested port
 * @param {string} [script]  the package.json script string, when known (for vite detection)
 */
export function applyRequestedPort(command, port, { script = '' } = {}) {
  if (!port) return command;
  if (/--port[= ]\d+/i.test(command)) return command.replace(/--port[= ]\d+/i, `--port=${port}`);
  if (/-p \d+/i.test(command)) return command.replace(/-p \d+/i, `-p ${port}`);
  if (typeof script === 'string' && /\bvite\b/i.test(script)) {
    return /\bnpm run [\w-]+\s*$/.test(command) ? `${command} -- --port=${port}` : command;
  }
  const isWindows = process.platform === 'win32';
  return isWindows ? `set PORT=${port}&& ${command}` : `PORT=${port} ${command}`;
}