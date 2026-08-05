/**
 * On-demand IO scans for codebaseIndexer (Phase 8 split, 2026-08-04 — extracted from
 * codebaseIndexer.js, logic unchanged): the project-tree walker plus the rarely-asked,
 * deliberately-uncached scans (TODO markers, biggest files, recent activity) and the
 * cheap git-repo check. readProjectTree lives here rather than in the orchestrator so
 * this module has no import cycle with it.
 */
import fs from 'fs/promises';
import path from 'path';
import { pathParts } from './codebaseParsers.js';
import { IGNORE_DIRS, CODE_EXTS, TODO_RE, MAX_TODO_FILES, MAX_TODO_RESULTS } from './codebaseData.js';

export async function readProjectTree(dirPath, maxDepth = 4) {
  const tree = [];
  async function walk(currentPath, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        const fullPath = path.join(currentPath, entry.name);
        const relPath = path.relative(dirPath, fullPath);
        if (entry.isDirectory()) {
          tree.push({ type: 'dir', path: relPath });
          await walk(fullPath, depth + 1);
        } else {
          tree.push({ type: 'file', path: relPath });
        }
      }
    } catch {}
  }
  await walk(dirPath, 0);
  return tree;
}

/** Cheap, allocation-light check for whether a folder is (or is inside) a git repo — used by
 *  projectScanner.js's discovery fallback so a folder with no docs/config/package.json but a
 *  real `.git` directory still gets recognized as a project instead of being invisible. */
export async function hasGitRepo(projectPath) {
  try {
    const stat = await fs.stat(path.join(projectPath, '.git'));
    return stat.isDirectory() || stat.isFile(); // .git can be a file (worktrees/submodules)
  } catch {
    return false;
  }
}

// --- On-demand scans (2026-07-30, requested directly — "more read-only code questions") ---
// Deliberately NOT run as part of indexProject()/cached on idx — these are asked for rarely
// compared to "what languages/entry points/etc" (which get read on nearly every project select),
// so paying the scan cost only when the user actually asks keeps the common case fast instead of
// making every project selection slower for a feature most sessions never use.

/** Scans code files for TODO/FIXME/HACK/XXX comment markers. Returns [{file, line, tag, text}]. */
export async function findTodos(projectPath) {
  const tree = await readProjectTree(projectPath);
  const codeFiles = tree
    .filter((e) => e.type === 'file' && CODE_EXTS.has(path.extname(e.path).toLowerCase()))
    .sort((a, b) => pathParts(a.path).length - pathParts(b.path).length)
    .slice(0, MAX_TODO_FILES);
  const results = [];
  for (const f of codeFiles) {
    if (results.length >= MAX_TODO_RESULTS) break;
    try {
      const content = await fs.readFile(path.join(projectPath, f.path), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < MAX_TODO_RESULTS; i++) {
        const m = lines[i].match(TODO_RE);
        if (m) results.push({ file: f.path, line: i + 1, tag: m[1], text: m[2].trim().slice(0, 140) });
      }
    } catch {}
  }
  return results;
}

/** Returns the topN largest files in the project by byte size, as [{path, bytes}]. */
export async function findBiggestFiles(projectPath, topN = 10) {
  const tree = await readProjectTree(projectPath);
  const files = tree.filter((e) => e.type === 'file');
  const sized = [];
  for (const f of files) {
    try {
      const stat = await fs.stat(path.join(projectPath, f.path));
      sized.push({ path: f.path, bytes: stat.size });
    } catch {}
  }
  sized.sort((a, b) => b.bytes - a.bytes);
  return sized.slice(0, topN);
}

/** Returns the most recently modified files, as [{path, mtime}] sorted desc by mtime (mtimeMs).
 *  Intent expansion (Phase 2, 2026-08-03): same on-demand reasoning as findTodos/findBiggestFiles
 *  — deliberately NOT part of the cached codebaseIndex, since it's asked for rarely. */
export async function findRecentActivity(projectPath, { limit = 10 } = {}) {
  const tree = await readProjectTree(projectPath);
  const files = tree.filter((e) => e.type === 'file');
  const withMtime = [];
  for (const f of files) {
    try {
      const stat = await fs.stat(path.join(projectPath, f.path));
      withMtime.push({ path: f.path, mtime: stat.mtimeMs });
    } catch {}
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.slice(0, limit);
}
