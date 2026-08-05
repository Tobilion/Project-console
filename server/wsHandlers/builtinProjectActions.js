import { state } from '../state.js';

/**
 * project.action.* / system.monitoring.metrics — the side-effectful action branch bodies
 * extracted verbatim from builtinIntents.js (Phase 10 step 5). Child-process spawning and the
 * metrics fetch use the same dynamic imports the originals used, so nothing loads at import time.
 */
export const projectActionHandlers = {
  async 'system.monitoring.metrics'(ws) {
    // Uses the global fetch (Node 18+) — the original dynamic `import('node-fetch')` could never
    // resolve since node-fetch isn't installed (pre-existing bug in the moved body, fixed here).
    try {
      const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/metrics`);
      const snap = await res.json();
      const counters = Object.entries(snap.counters || {}).map(([k, v]) => `- **${k}**: ${v}`).join('\n');
      let histoLines = '';
      for (const [name, stats] of Object.entries(snap.histograms || {})) {
        if (stats) {
          histoLines += `\n**${name}** — count: ${stats.count}, avg: ${stats.avg.toFixed(0)}ms, p95: ${stats.p95}ms, p99: ${stats.p99}ms`;
        }
      }
      const recent = (snap.recentEvents || []).slice(-10).map((e) =>
        `- ${e.type} (${new Date(e.ts).toLocaleTimeString()})${e.duration ? ` ${e.duration}ms` : ''}${e.outcome ? ` → ${e.outcome}` : ''}`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Console Metrics\n\n**Counters:**\n${counters || '_(none)_'}\n\n**Latency:**${histoLines || ' _(none)_'}\n\n**Recent Events:**\n${recent || ' _(none)_'}` }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'answer', data: `### Console Metrics\n\nCould not fetch metrics: ${err.message}` }));
    }
  },

  async 'project.action.open_in_vscode'(ws, _action, _input, project) {
    // Phase 3 (2026-08-03): open project folder in VS Code. If `code` not on PATH, answer with
    // guidance instead of the raw error.
    const { spawn } = await import('child_process');
    const child = spawn('code', [project.path], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      if (err.code === 'ENOENT' || err.message.includes('not recognized')) {
        // Phase 15: the `code` CLI isn't on PATH on this machine — fall back to the
        // vscode://file/<path> protocol URI, which Windows (`start`), macOS (`open`) and Linux
        // (`xdg-open`) all hand to the installed VS Code without needing the CLI. Best-effort:
        // if VS Code itself isn't installed the URI silently no-ops, so the manual guidance
        // stays in the reply — never claim it opened.
        const uri = 'vscode://file/' + encodeURI(project.path.replace(/\\/g, '/'));
        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
        const args = isWindows ? ['', uri] : [uri];
        const fallback = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows });
        fallback.on('error', () => {
          ws.send(JSON.stringify({ type: 'answer', data: `VS Code \`code\` CLI not found on PATH. Open VS Code manually and use File → Open Folder → \`${project.path}\`.` }));
        });
        fallback.unref();
        ws.send(JSON.stringify({ type: 'answer', data: `VS Code \`code\` CLI not found on PATH — tried opening via the \`vscode://\` protocol instead. If nothing opened, use File → Open Folder → \`${project.path}\`.` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open VS Code: ${err.message}\n` }));
      }
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** in VS Code...` }));
  },

  async 'project.action.open_in_explorer'(ws, _action, _input, project) {
    // Phase 3 (2026-08-03): open project folder in OS file explorer — branch on platform.
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let cmd, args;
    if (isWindows) {
      cmd = 'explorer';
      args = [project.path];
    } else if (isMac) {
      cmd = 'open';
      args = [project.path];
    } else {
      cmd = 'xdg-open';
      args = [project.path];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open folder: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** folder in file explorer...` }));
  },

  async 'project.action.open_site'(ws, _action, _input, project) {
    // Phase 3 (2026-08-03): open the dev server URL in browser. Reads state.lastDevUrls.
    const url = state.lastDevUrls.get(project.id);
    if (!url) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dev server URL recorded for **[${project.name}]**. Say "run the site" to start it, or "what is the link" if you think it's already running.` }));
      return true;
    }
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
    const args = isWindows ? ['', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open browser: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **${url}** in your browser...` }));
  },

  'project.action.copy_path'(ws, _action, _input, project) {
    // Phase 3 (2026-08-03): emit copy_to_clipboard WS event — frontend handles clipboard write.
    ws.send(JSON.stringify({ type: 'copy_to_clipboard', data: project.path }));
    ws.send(JSON.stringify({ type: 'answer', data: `Copied **[${project.name}]** path to clipboard:\n\`${project.path}\`` }));
  },
};
