import fs from 'fs/promises';
import path from 'path';
import { IGNORE_DIRS, TEXT_EXTENSIONS } from './toolConstants.js';

// Filesystem walk + project file-index helpers for the AI tool layer (Phase 9 split,
// 2026-08-04 — extracted from tools.js; consumed by toolFileTools.js). The file index cache
// lives here because it caches exactly the walkDir results these helpers produce.

export async function walkDir(dirPath, maxDepth = 6) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory() && maxDepth > 0) {
      const sub = await walkDir(fullPath, maxDepth - 1);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

// Cache walkDir results per project root with mtime invalidation so repeated
// findFiles/searchCode/listFiles calls don't re-scan the whole filesystem.
const fileIndexCache = new Map();

export async function getProjectFiles(root) {
  const cached = fileIndexCache.get(root);
  try {
    const stat = await fs.stat(root);
    if (cached && cached.mtime >= stat.mtimeMs) return cached;
    const files = await walkDir(root);
    const entry = { files, mtime: stat.mtimeMs };
    fileIndexCache.set(root, entry);
    return entry;
  } catch {
    return cached || { files: [], mtime: 0 };
  }
}
