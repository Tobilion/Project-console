// Phase 5 (2026-08-10): "run the site on port 3010" / "serve the site on port 3040" — an
// explicit user-requested port for run commands. Parsed from the chat input and applied to the
// resolved command with the same platform branching as buildPortRetryCommand (executorPorts.js).
// Deliberately conservative: only applied by the run handlers (npm_run / run_project / their
// npm start|serve shortcuts), never to arbitrary commands, and only for a plain integer port.

import path from 'path';
import fs from 'fs';

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
 * - a port flag INSIDE the package.json script ("vite --port=3001 ...") is rewritten and the
 *   script is run through the project's local node_modules/.bin binary directly, so the
 *   executed line carries exactly one port flag — the previous behavior appended
 *   "-- --port=N" and left the script's own flag in the line (a confusing double flag that
 *   only worked because vite's CLI is last-wins; Matchday-Exchange live session 2026-08-14);
 * - a Vite-shaped script without its own port flag gets `-- --port=N` so the flag actually
 *   reaches vite through npm (vite does not read the PORT env var);
 * - anything else gets the PORT env prefix (react-scripts/serve/Express convention), using
 *   the same `set PORT=N&&` / `PORT=N ` platform split as buildPortRetryCommand.
 *
 * @param {string} command  the resolved command (e.g. "npm run dev")
 * @param {number|null} port  the requested port
 * @param {object} [opts]  { script: the package.json script string (for vite detection and
 *   port-flag rewriting), projectRoot: the project path (for the local-bin lookup) }
 */
export function applyRequestedPort(command, port, { script = '', projectRoot = '' } = {}) {
  if (!port) return command;
  if (/--port[= ]\d+/i.test(command)) return command.replace(/--port[= ]\d+/i, `--port=${port}`);
  if (/-p \d+/i.test(command)) return command.replace(/-p \d+/i, `-p ${port}`);
  // A port flag inside the script itself: rewrite it and run the script through the local
  // binary, so the executed line is unambiguous. Falls through to the vite/npm append when
  // no local binary exists (globally-installed tooling).
  if (typeof script === 'string' && (/--port[= ]\d+/i.test(script) || /-p \d+/i.test(script))) {
    const rewritten = script
      .replace(/--port[= ]\d+/i, `--port=${port}`)
      .replace(/-p \d+/i, `-p ${port}`);
    const firstToken = (rewritten.trim().split(/\s+/)[0] || '').toLowerCase();
    if (/^[\w.-]+$/.test(firstToken) && projectRoot) {
      const binName = process.platform === 'win32' ? `${firstToken}.cmd` : firstToken;
      const binPath = path.join(projectRoot, 'node_modules', '.bin', binName);
      if (fs.existsSync(binPath)) {
        const rest = rewritten.slice(firstToken.length).trim();
        return `${binPath} ${rest}`.trim();
      }
    }
  }
  if (typeof script === 'string' && /\bvite\b/i.test(script)) {
    return /\bnpm run [\w-]+\s*$/.test(command) ? `${command} -- --port=${port}` : command;
  }
  const isWindows = process.platform === 'win32';
  return isWindows ? `set PORT=${port}&& ${command}` : `PORT=${port} ${command}`;
}
