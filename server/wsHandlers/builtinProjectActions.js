import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { state } from '../state.js';
import { isGitRepo } from '../gitSafety.js';
import { createProjectTools } from '../tools.js';
import { parseFileNameOnly } from './builtinHelpers.js';
import { resolveEditor, defaultEditorFor, getEditorsState } from '../editorsStore.js';

/**
 * Extracts the editor name from "open X with <Editor>" / "open X in <Editor>" /
 * "open X in the editor" phrasing: the token(s) right after "with"/"in". Returns the
 * raw name (multi-word editor names like "IntelliJ IDEA" are joined back) or null.
 */
function extractEditorName(input) {
  const m = input.match(/\b(?:with|in)\s+([a-z][a-z0-9 .+_-]*)$/i);
  if (!m) return null;
  const raw = m[1].trim();
  // "in the editor" / "with the editor" → the default-editor ask (per-extension default).
  return /^(?:the|your|my|default)\s+editor$/i.test(raw) ? 'the editor' : raw;
}

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
    const child = spawn('code', [project.path], { detached: true, stdio: 'ignore', windowsHide: true });
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
        const fallback = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows, windowsHide: true });
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
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
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
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows, windowsHide: true });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open browser: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **${url}** in your browser...` }));
  },

  async 'project.action.copy_path'(ws, _action, _input, project) {
    // Phase 3 (2026-08-03): emit copy_to_clipboard WS event — frontend handles clipboard write.
    // Phase 8 (2026-08-12): ALSO write server-side so the CLI (no browser to hand the event
    // to) copies for real; the WS event stays as a display notice for the web client.
    const { copyToOsClipboard } = await import('../clipboardHistory.js');
    await copyToOsClipboard(project.path);
    ws.send(JSON.stringify({ type: 'copy_to_clipboard', data: project.path }));
    ws.send(JSON.stringify({ type: 'answer', data: `Copied **[${project.name}]** path to clipboard:\n\`${project.path}\`` }));
  },

  async 'project.action.open_in_terminal'(ws, _action, _input, project) {
    // Phase 16 (2026-08-05): open a terminal at the project folder. Windows uses the always-
    // present cmd with /K so the window stays open after cd; macOS opens Terminal.app at the
    // path; Linux tries x-terminal-emulator (Debian-family standard). Best-effort — on failure
    // the manual `cd` guidance stays in the reply, never claim it opened.
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let cmd, args;
    if (isWindows) {
      cmd = 'cmd';
      args = ['/K', 'cd', '/d', project.path];
    } else if (isMac) {
      cmd = 'open';
      args = ['-a', 'Terminal', project.path];
    } else {
      cmd = 'x-terminal-emulator';
      args = [`--working-directory=${project.path}`];
    }
    // No windowsHide here — this spawn's whole purpose is the visible cmd window (cd /K),
    // and CREATE_NO_WINDOW would make the terminal invisible (audit 2026-08-17 deviation).
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'answer', data: `Couldn't open a terminal automatically (${err.message}). Open one yourself and run: \`cd "${project.path}"\`` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening a terminal at **[${project.name}]**...` }));
  },

  async 'project.action.open_github_page'(ws, _action, _input, project) {
    // Phase 16 (2026-08-05): open the project's GitHub repo page in the browser. Resolves the
    // origin remote URL (same execFile pattern as cachedUncommittedCount — non-streaming, no
    // chat output noise), normalizes the git@/ssh:///https shapes GitHub accepts to the plain
    // https page, and hands it to the OS browser like open_site. No git repo, no origin, or a
    // non-GitHub origin -> honest guidance, never a fake "opened".
    if (!(await isGitRepo(project.path))) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** is not a git repository, so there's no GitHub page to open.` }));
      return true;
    }
    let remote = '';
    try {
      const { stdout } = await promisify(execFile)('git', ['remote', 'get-url', 'origin'], { cwd: project.path, timeout: 5000, windowsHide: true });
      remote = (stdout || '').trim();
    } catch (err) {
      ws.send(JSON.stringify({ type: 'answer', data: `Couldn't read the origin remote for **[${project.name}]** (${err.message}). Say "show git remotes" to see what's configured.` }));
      return true;
    }
    const page = normalizeGithubPageUrl(remote);
    if (!page) {
      ws.send(JSON.stringify({ type: 'answer', data: `The origin remote for **[${project.name}]** is \`${remote || '(none)'}\`, which isn't a GitHub URL. Say "show git remotes" to see all configured remotes.` }));
      return true;
    }
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
    const args = isWindows ? ['', page] : [page];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows, windowsHide: true });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open browser: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **${page}** in your browser...` }));
  },

  async 'project.action.open_in_cursor'(ws, _action, _input, project) {
    // Phase 16 (2026-08-05): open project folder in Cursor, mirror of the open_in_vscode
    // handler. If the `cursor` CLI isn't on PATH, answer with manual guidance instead of the
    // raw error — Cursor has no reliable cursor://file/ URI scheme like VS Code's documented
    // vscode:// one, so there's no protocol fallback to try; never claim it opened.
    const { spawn } = await import('child_process');
    const child = spawn('cursor', [project.path], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => {
      if (err.code === 'ENOENT' || err.message.includes('not recognized')) {
        ws.send(JSON.stringify({ type: 'answer', data: `Cursor \`cursor\` CLI not found on PATH. Open Cursor manually and use File → Open Folder → \`${project.path}\`.` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open Cursor: ${err.message}\n` }));
      }
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** in Cursor...` }));
  },

  async 'project.action.open_file'(ws, _action, input, project, sessionContext) {
    // Phase 16 (2026-08-05): "open main.py" / "open the config file" — parses the name loosely
    // (same parseFileNameOnly as file_read/file_find), resolves it via the sandboxed findFiles()
    // across the project, then opens the matched file in the editor: `code` CLI first, the
    // vscode://file/ protocol fallback (same chain as open_in_vscode), then manual guidance.
    // No name -> asks; no match -> the same "did you mean"-style guidance file_read uses.
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      // Stage the follow-up so a bare "readme" reply resolves this question instead of
      // dead-ending in the fallback (see handlePendingFileQuestionReply — Matchday-Exchange
      // live session, 2026-08-14).
      if (sessionContext) {
        sessionContext.pendingFileQuestion = { projectId: project.id, intent: 'project.action.open_file' };
      }
      ws.send(JSON.stringify({ type: 'answer', data: `Which file would you like me to open? Try "open the readme file" or "open main.py".` }));
      return true;
    }
    const tools = await createProjectTools(project);
    const matches = await tools.findFiles({ pattern: fileName });
    if (!matches.success || matches.data.length === 0) {
      if (matches.success) {
        ws.send(JSON.stringify({ type: 'answer', data: `No file matches **"${fileName}"** in **[${project.name}]**. Try a different name, or say "where is main.py" to search.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: matches.error || `Couldn't search for **"${fileName}"**.` }));
      }
      return true;
    }
    const rel = matches.data[0];
    const abs = path.join(project.path, rel);
    const { spawn } = await import('child_process');
    const child = spawn('code', [abs], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => {
      if (err.code === 'ENOENT' || err.message.includes('not recognized')) {
        const uri = 'vscode://file/' + encodeURI(abs.replace(/\\/g, '/'));
        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
        const args = isWindows ? ['', uri] : [uri];
        const fallback = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows, windowsHide: true });
        fallback.on('error', () => {
          ws.send(JSON.stringify({ type: 'answer', data: `VS Code \`code\` CLI not found on PATH. Open the file manually: \`${abs}\`.` }));
        });
        fallback.unref();
        ws.send(JSON.stringify({ type: 'answer', data: `VS Code \`code\` CLI not found on PATH — tried opening **\`${rel}\`** via the \`vscode://\` protocol instead. If nothing opened, open the file manually: \`${abs}\`.` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open file: ${err.message}\n` }));
      }
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **\`${rel}\`** in VS Code...` }));
  },

  async 'project.action.open_html'(ws, _action, input, project, sessionContext) {
    // Phase T (2026-08-14): "open index.html in the browser" / "preview the page" / "open
    // report.pdf in the browser" — resolves the file the same way open_file does (sandboxed
    // findFiles, no-name follow-up staging), then opens it via the OS default browser using the
    // file's association (start/open/xdg-open with the absolute path). HTML renders; other file
    // types open/download per the OS association. Deliberately the browser, not the editor (see
    // the pre-semantic overrides in preSemanticOverrides.js).
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      if (sessionContext) {
        sessionContext.pendingFileQuestion = { projectId: project.id, intent: 'project.action.open_html' };
      }
      ws.send(JSON.stringify({ type: 'answer', data: `Which file would you like to open in the browser? Try "open index.html in the browser" or "preview the page".` }));
      return true;
    }
    const tools = await createProjectTools(project);
    const matches = await tools.findFiles({ pattern: fileName });
    if (!matches.success || matches.data.length === 0) {
      if (matches.success) {
        ws.send(JSON.stringify({ type: 'answer', data: `No file matches **"${fileName}"** in **[${project.name}]**. Try a different name, or say "where is index.html" to search.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: matches.error || `Couldn't search for **"${fileName}"**.` }));
      }
      return true;
    }
    const rel = matches.data[0];
    const abs = path.join(project.path, rel);
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
    const args = isWindows ? ['', abs] : [abs];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows, windowsHide: true });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open browser: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **\`${rel}\`** in your default browser...` }));
  },

  async 'project.action.open_with'(ws, _action, input, project, sessionContext) {
    // Phase T2 (2026-08-14): "open main.py with PyCharm" / "open app.ts in IntelliJ" /
    // "open file.py in the editor" — resolves the file like open_file, then launches the
    // chosen editor from the editorsStore registry (data/editors.json, configured in
    // Settings → Editors & IDEs). "in the editor" / "with the editor" uses the per-extension
    // default; the reserved 'browser' pseudo-editor delegates to open_html. ENOENT →
    // named guidance (same pattern as open_in_vscode).
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      if (sessionContext) {
        sessionContext.pendingFileQuestion = { projectId: project.id, intent: 'project.action.open_with' };
      }
      ws.send(JSON.stringify({ type: 'answer', data: `Which file would you like to open? Try "open main.py with PyCharm" or "open app.ts in the editor".` }));
      return true;
    }
    const editorName = extractEditorName(input);
    if (!editorName) {
      ws.send(JSON.stringify({ type: 'answer', data: `Which editor? Try "open ${fileName} with PyCharm" or "open ${fileName} in IntelliJ". Configure editors in Settings → Editors & IDEs.` }));
      return true;
    }
    const tools = await createProjectTools(project);
    const matches = await tools.findFiles({ pattern: fileName });
    if (!matches.success || matches.data.length === 0) {
      if (matches.success) {
        ws.send(JSON.stringify({ type: 'answer', data: `No file matches **"${fileName}"** in **[${project.name}]**. Try a different name, or say "where is main.py" to search.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: matches.error || `Couldn't search for **"${fileName}"**.` }));
      }
      return true;
    }
    const rel = matches.data[0];
    const abs = path.join(project.path, rel);
    const ext = path.extname(rel).toLowerCase();

    // "the editor" / "the default editor" → the per-extension default (settings), falling
    // back to VS Code; the browser pseudo-editor opens the file in the default browser
    // (same start/open/xdg-open spawn as open_html — no delegation to avoid an import
    // cycle through builtinIntents.js).
    const isDefaultAsk = /(?:the|your|my|default)\s+(?:default\s+)?editor/i.test(editorName);
    let editor = null;
    if (isDefaultAsk) {
      editor = defaultEditorFor(rel);
      if (editor?.id === 'browser') {
        const { spawn } = await import('child_process');
        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
        const args = isWindows ? ['', abs] : [abs];
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows, windowsHide: true });
        child.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open browser: ${err.message}\n` }));
        });
        child.unref();
        ws.send(JSON.stringify({ type: 'answer', data: `Opening **\`${rel}\`** in your default browser (per-extension default for .${ext})...` }));
        return true;
      }
      if (!editor) {
        editor = resolveEditor('vscode');
      }
    } else {
      editor = resolveEditor(editorName);
    }

    if (!editor || !editor.command) {
      const known = getEditorsState().editors.map((e) => e.name).join(', ');
      ws.send(JSON.stringify({ type: 'answer', data: `I don't know an editor called **"${editorName}"**. Configured editors: ${known || 'none yet'} — add them in Settings → Editors & IDEs, or use "open ${rel} in the editor" for the per-extension default.` }));
      return true;
    }

    const { spawn } = await import('child_process');
    let child;
    try {
      child = spawn(editor.command, [abs], { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (err) {
      // A malformed command (e.g. "node script.js" — spawn needs a single executable) throws
      // synchronously on Windows instead of emitting 'error'; surface it as guidance.
      ws.send(JSON.stringify({ type: 'answer', data: `Could not launch **${editor.name}**: the command \`${editor.command}\` is not a single executable. Fix it in Settings → Editors & IDEs, or open the file manually at \`${abs}\`.` }));
      return true;
    }
    child.on('error', (err) => {
      if (err.code === 'ENOENT' || err.message.includes('not recognized')) {
        ws.send(JSON.stringify({ type: 'answer', data: `**${editor.name}** (\`${editor.command}\`) was not found on PATH. Install it or fix the command in Settings → Editors & IDEs, then try again. The file is at \`${abs}\`.` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open ${editor.name}: ${err.message}\n` }));
      }
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **\`${rel}\`** in **${editor.name}**...` }));
  },

  async 'project.action.reveal_file'(ws, _action, input, project, sessionContext) {
    // Phase T2 (2026-08-14): "open main.py in the folder" / "show file.py in explorer" —
    // reveals the FILE in the OS file explorer (folder opens with the file selected),
    // the file-level counterpart of open_in_explorer. Uses the same reveal spawn pattern
    // as pdfRoutes' /api/projects/:id/reveal.
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      if (sessionContext) {
        sessionContext.pendingFileQuestion = { projectId: project.id, intent: 'project.action.reveal_file' };
      }
      ws.send(JSON.stringify({ type: 'answer', data: `Which file would you like to reveal? Try "open main.py in the folder" or "show file.py in explorer".` }));
      return true;
    }
    const tools = await createProjectTools(project);
    const matches = await tools.findFiles({ pattern: fileName });
    if (!matches.success || matches.data.length === 0) {
      if (matches.success) {
        ws.send(JSON.stringify({ type: 'answer', data: `No file matches **"${fileName}"** in **[${project.name}]**. Try a different name.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: matches.error || `Couldn't search for **"${fileName}"**.` }));
      }
      return true;
    }
    const rel = matches.data[0];
    const abs = path.join(project.path, rel);
    const { spawn } = await import('child_process');
    let reveal;
    try {
      if (process.platform === 'win32') {
        reveal = spawn('explorer.exe', [`/select,${abs}`], { detached: true, windowsHide: true });
      } else if (process.platform === 'darwin') {
        reveal = spawn('open', ['-R', abs], { detached: true, windowsHide: true });
      } else {
        reveal = spawn('xdg-open', [path.dirname(abs)], { detached: true, windowsHide: true });
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to reveal file: ${err.message}\n` }));
      return true;
    }
    // Best-effort reveal: a missing explorer/open/xdg-open must log, never crash the server
    // (audit 2026-08-17 — the spawn used to be fire-and-forget with no error path at all).
    reveal.on('error', (err) => {
      console.error(`[reveal_file] Failed to reveal ${abs}: ${err.message}`);
    });
    reveal.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Revealed **\`${rel}\`** in your file explorer...` }));
  },
};

/** git@host:user/repo.git | ssh://git@host/user/repo.git | https://host/user/repo.git
 *  -> https://host/user/repo (GitHub page URL); null when the remote isn't GitHub-shaped.
 *  Exported for checkHandlerCoverage.js's NORMALIZER battery. */
export function normalizeGithubPageUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return null;
  if (url.startsWith('git@')) url = url.replace(/^git@([^:]+):/, 'https://$1/');
  else if (url.startsWith('ssh://')) url = url.replace(/^ssh:\/\/(?:git@)?([^/]+)\//, 'https://$1/');
  else if (url.startsWith('git://')) url = url.replace(/^git:\/\//, 'https://');
  if (!/^https:\/\//i.test(url)) return null;
  url = url.replace(/\.git$/, '').replace(/\/+$/, '');
  return /^https:\/\/(?:www\.)?github\.com\//i.test(url) ? url : null;
}
