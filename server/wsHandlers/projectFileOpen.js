// Shared OS-open + project-file-resolution helpers (2026-08-24, split out of
// builtinProjectActions.js — every "open X in the OS" handler used the same platform-branched
// spawn and the same findFiles-resolve flow, duplicated five times).

import path from 'node:path';
import { parseFileNameOnly } from './builtinHelpers.js';
import { createProjectTools } from '../tools.js';

/**
 * Spawns a detached OS-open command (browser / explorer / terminal / editor launcher) with
 * the error handling every open-style handler needs: an ENOENT must log or answer, never
 * crash the server, and the child is unref'd so it can't hold the server's exit open.
 */
export function spawnDetached(cmd, args, { shell = false, onError = null } = {}) {
  // Dynamic import keeps the module graph free of child_process at load time — the original
  // handlers all used this same pattern.
  return import('child_process').then(({ spawn }) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell, windowsHide: true });
    if (onError) child.on('error', onError);
    child.unref();
    return child;
  });
}

/** Browser-open platform branch: `start` (cmd builtin) on Windows, `open` on macOS,
 *  `xdg-open` elsewhere. */
export async function openInBrowser(urlOrPath, onError) {
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
  const args = isWindows ? ['', urlOrPath] : [urlOrPath];
  await spawnDetached(cmd, args, { shell: isWindows, onError });
}

/** File-explorer platform branch: explorer (Windows), open -R (macOS reveal),
 *  xdg-open on the parent folder (Linux). */
export async function revealInExplorer(absPath, onError) {
  if (process.platform === 'win32') {
    await spawnDetached('explorer.exe', [`/select,${absPath}`], { onError });
  } else if (process.platform === 'darwin') {
    await spawnDetached('open', ['-R', absPath], { onError });
  } else {
    await spawnDetached('xdg-open', [path.dirname(absPath)], { onError });
  }
}

/**
 * The file-resolution flow shared by open_file / open_html / open_with / reveal_file: parse
 * the loose file name, stage the no-name follow-up (a bare "readme" reply resolves the
 * question — Matchday-Exchange live session, 2026-08-14), resolve via the sandboxed
 * findFiles(), and send the ask/no-match answers when resolution fails.
 *
 * `send` is the ws.send-builder the caller already uses (type 'answer' messages). Returns
 * { rel, abs } when resolved, else null (an answer was already sent).
 */
export async function resolveFileForOpen({ send, project, sessionContext, input, askText, noMatchText, intent }) {
  const fileName = parseFileNameOnly(input);
  if (!fileName) {
    if (sessionContext) {
      sessionContext.pendingFileQuestion = { projectId: project.id, intent };
    }
    send(askText);
    return null;
  }
  const tools = await createProjectTools(project);
  const matches = await tools.findFiles({ pattern: fileName });
  if (!matches.success || matches.data.length === 0) {
    if (matches.success) {
      send(noMatchText);
    } else {
      send(matches.error || `Couldn't search for **"${fileName}"**.`);
    }
    return null;
  }
  const rel = matches.data[0];
  return { rel, abs: path.join(project.path, rel) };
}