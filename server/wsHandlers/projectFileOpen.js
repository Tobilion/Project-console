// Shared OS-open + project-file-resolution helpers (2026-08-24, split out of
// builtinProjectActions.js — every "open X in the OS" handler used the same platform-branched
// spawn and the same findFiles-resolve flow, duplicated five times).

import fs from 'node:fs';
import path from 'node:path';
import { parseFileNameOnly } from './builtinHelpers.js';
import { createProjectTools } from '../tools.js';
import { log as logger } from '../logger.js';

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

/** OS "open this folder" branch: the folder itself is the target (explorer/open/xdg-open
 *  with the path) — the directory counterpart to revealInExplorer's file-/select form. */
export async function openFolderInExplorer(absDir, onError) {
  if (process.platform === 'win32') {
    await spawnDetached('explorer.exe', [absDir], { onError });
  } else if (process.platform === 'darwin') {
    await spawnDetached('open', [absDir], { onError });
  } else {
    await spawnDetached('xdg-open', [absDir], { onError });
  }
}

const LEAD_VERB_RE = /^(?:open|open\s+up|open\s+me|show|reveal|locate)\s+/i;
const REVEAL_SUFFIX_RE = /\s+(?:in\s+the\s+folder|in\s+(?:file\s+)?explorer)\s*$/i;
const ABS_SHAPE_RE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

/**
 * Pulls an absolute filesystem path out of a reveal/open request ("open C:\Docs\Manual
 * in the folder" / "show /home/you/notes in explorer"). Strips the leading chat verb and
 * the trailing reveal suffix, then accepts only drive-letter, UNC, or leading-slash
 * shapes — anything else (project-relative names like "main.py") returns null so the
 * caller runs the normal sandboxed resolution. Pure — covered by unit rows.
 */
export function extractAbsolutePath(input) {
  if (!input || typeof input !== 'string') return null;
  let rest = input.trim().replace(LEAD_VERB_RE, '').replace(REVEAL_SUFFIX_RE, '').trim();
  rest = rest.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!rest || !ABS_SHAPE_RE.test(rest)) return null;
  return rest;
}

/**
 * Absolute-path fast path for the reveal_file handler (2026-09-08): an explicit absolute
 * path names its target unambiguously, so it bypasses the project-sandboxed findFiles()
 * resolution (which only sees project-relative names and would just ask "Which file?").
 * Existing folders open in the OS explorer, existing files are revealed with /select, and
 * a missing path answers honestly instead of falling through to a confusing ask. Opening
 * is read-only OS navigation — the same trust level as GET /api/browse, which already
 * serves any absolute path. Returns true when it answered (handled), false when the input
 * carries no absolute path and the caller should run the normal resolve flow.
 */
export async function tryRevealAbsolutePath({ send, input }) {
  const candidate = extractAbsolutePath(input);
  if (!candidate) return false;
  let st = null;
  try {
    st = fs.statSync(candidate);
  } catch {
    st = null;
  }
  if (!st) {
    send(`I couldn't find \`${candidate}\` on disk — check the path and try again. (Chat file commands otherwise work on project-relative names like \`main.py\`; the Folder Explorer panel browses any absolute path.)`);
    return true;
  }
  const onError = (err) => {
    // Best-effort OS handoff: a missing explorer/open/xdg-open must log, never crash the
    // server or double-answer (the success line below already sent).
    logger.error(`[reveal_absolute] Failed to open ${candidate}: ${err.message}`);
  };
  if (st.isDirectory()) {
    await openFolderInExplorer(candidate, onError);
    send(`Opened \`${candidate}\` in your file explorer...`);
  } else {
    await revealInExplorer(candidate, onError);
    send(`Revealed \`${candidate}\` in your file explorer...`);
  }
  return true;
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