import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { state } from './state.js';

// Strips ANSI escape sequences so URL detection isn't fooled by color/bold codes
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

// Matches URLs like http://localhost:3000, http://127.0.0.1:5173/, etc.
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]):\d{2,5}\/?/gi;

// Patterns that indicate a long-running dev server — we auto-detach after URL / timeout
const DEV_SERVER_PATTERNS = [
  /npx serve/i,
  /python -m http\.server/i,
  /npm run (dev|start|serve)/i,
  /vite/i,
  /tsx (dev|serve)/i,
  /next dev/i,
  /astro dev/i,
  /node (server|app|index|main)\./i,
];

function isDevServerCommand(command) {
  return DEV_SERVER_PATTERNS.some(p => p.test(command));
}

// Track running processes so they can be killed by the user
// (Cleared on module load to handle HMR — stale children from previous module scope
//  are orphaned; we start fresh each time the module re-executes.)
export const runningProcesses = new Map(); // projectId -> { child, command }

// Clean up on exit — kills tracked children before Node shuts down
process.on('exit', () => {
  for (const [, proc] of runningProcesses) {
    try { proc.child.kill('SIGTERM'); } catch {}
  }
  runningProcesses.clear();
});
process.on('SIGTERM', () => {
  for (const [, proc] of runningProcesses) {
    try { proc.child.kill('SIGTERM'); } catch {}
  }
  runningProcesses.clear();
});

/**
 * Spawns a shell command.
 *
 * For dev-server commands (long-running processes like `npx serve .` or
 * `python -m http.server`), output streams until a URL is detected or a
 * timeout elapses, then we detach: an `end` event is sent so the UI knows
 * the "task is complete", and subsequent process output is silently ignored.
 * The process reference is kept in `runningProcesses` so the user can stop
 * it later via WebSocket.
 *
 * For short-lived commands, behavior is unchanged: all output streams until
 * the process exits naturally.
 */
export function executeCommand(command, cwd, ws, projectId) {
  let finalCommand = command;

  const isWindows = process.platform === 'win32';
  const venvPath = path.join(cwd, 'venv');

  if (fs.existsSync(venvPath)) {
    const pythonExe = isWindows
      ? path.join('venv', 'Scripts', 'python.exe')
      : path.join('venv', 'bin', 'python');
    if (command.startsWith('python ')) {
      finalCommand = command.replace('python ', `${pythonExe} `);
    }
  }

  const isDev = isDevServerCommand(finalCommand);
  let detached = false;

  const sendEvent = (type, data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    let detachTimer = null;

    try {
      child = spawn(finalCommand, {
        cwd: cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      sendEvent('error_output', `Failed to start process: ${err.message}`);
      sendEvent('end', `\nProcess failed.`);
      resolve({ success: false, error: err.message });
      return;
    }

    sendEvent('start', `Executing: ${finalCommand}\n`);

    // Register so user can stop the server later
    if (projectId) {
      runningProcesses.set(projectId, { child, command: finalCommand });
    }

    function detach() {
      if (detached) return;
      detached = true;
      if (detachTimer) clearTimeout(detachTimer);
      // Stop listening to output
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      // Send end so the UI knows the "task is done" (the server keeps running)
      sendEvent('end', `\nDev server is running${state.lastDevUrls.has(projectId) ? ` at ${state.lastDevUrls.get(projectId)}` : ''} — you can keep chatting. Use "stop server" to shut it down.\n`);
      resolve({
        success: true,
        data: { code: null, detached: true, devServer: true, url: state.lastDevUrls.get(projectId) || null }
      });
    }

    child.stdout.on('data', (data) => {
      const s = data.toString();
      stdout += s;

      if (detached) return;

      sendEvent('output', s);

      const clean = s.replace(ANSI_RE, '');
      const urls = clean.match(URL_PATTERN);
      if (urls) {
        const unique = [...new Set(urls.map(u => u.replace(/\/+$/, '')))];
        for (const url of unique) {
          sendEvent('server_url', url);
          if (projectId) state.lastDevUrls.set(projectId, url);
        }
        // If this is a dev server command, detach after URL + short grace to show it
        if (isDev) {
          detachTimer = setTimeout(detach, 500);
        }
      }
    });

    child.stderr.on('data', (data) => {
      if (detached) return;
      const s = data.toString();
      stderr += s;
      sendEvent('error_output', s);
    });

    // For dev server commands, force-detach after 10s even without URL
    if (isDev) {
      setTimeout(() => {
        if (!detached) detach();
      }, 10000);
    }

    child.on('close', (code) => {
      runningProcesses.delete(projectId);
      if (detached) return;
      sendEvent('end', `\nProcess exited with code ${code}`);
      resolve({
        success: code === 0,
        data: {
          code,
          stdout: stdout.length > 4000 ? `...${stdout.slice(-4000)}` : stdout,
          stderr: stderr.length > 2000 ? `...${stderr.slice(-2000)}` : stderr
        }
      });
    });

    child.on('error', (err) => {
      runningProcesses.delete(projectId);
      sendEvent('error_output', `Failed to start process: ${err.message}`);
      sendEvent('end', `\nProcess failed.`);
      resolve({ success: false, error: err.message });
    });
  });
}
