import { realpathSync } from 'fs';
import path from 'path';

// The sandbox boundary for the file tools (Phase 9 split, 2026-08-04 — extracted verbatim
// from tools.js's createProjectTools closure). Returns a resolveSafe(relPath, projectId)
// bound to one project root: every path a tool touches is resolved against this root and
// rejected if it would escape it — the security-critical guard of the whole tool layer.

/**
 * Resolves a project-relative path and throws if it escapes the project root.
 * Uses realpathSync.native to resolve symlinks before checking — a symlink inside
 * the project could otherwise point outside it undetected.
 * For new files (ENOENT), walks up to the nearest existing ancestor to verify it's
 * within the sandbox.
 *
 * `workspaceProjects` is the server-side workspace list (tools.js's exported array,
 * populated via the websocket) used when a tool call names a *different* workspace
 * project by id.
 */
export function createResolveSafe(targetRoot, workspaceProjects = []) {
  return function resolveSafe(relPath, projectId = null) {
    // If projectId is provided, find the matching workspace project
    let target = targetRoot;
    if (projectId && workspaceProjects?.length) {
      const wp = workspaceProjects.find(p => p.id === projectId);
      if (wp) target = path.resolve(wp.path);
    }
    const input = relPath && relPath.trim() ? relPath : '.';
    const resolved = path.resolve(target, input);
    try {
      const realResolved = realpathSync(resolved);
      const realRoot = realpathSync(target);
      if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
        throw new Error(`Path escapes sandbox: "${relPath}" resolves outside the project directory (${target}).`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Walk up to the nearest existing ancestor to verify sandbox boundary
        let ancestor = path.dirname(resolved);
        let found = false;
        while (ancestor !== path.dirname(ancestor)) {
          try {
            const realAncestor = realpathSync(ancestor);
            const realRoot = realpathSync(target);
            if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
              throw new Error(`Path escapes sandbox: "${relPath}" resolves outside the project directory (${target}).`);
            }
            found = true;
            break;
          } catch (ae) {
            if (ae.code !== 'ENOENT') throw ae;
            ancestor = path.dirname(ancestor);
          }
        }
        if (!found) {
          throw new Error(`Path escapes sandbox: "${relPath}" — no existing ancestor found within the project directory.`);
        }
      } else {
        throw err;
      }
    }
    return resolved;
  };
}
