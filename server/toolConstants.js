// Pure data registries for the AI tool layer (Phase 9 split, 2026-08-04 — extracted from
// tools.js; consumed by toolScan.js and toolAllow.js). No logic here, only static sets.

/** Extensions whose contents are treated as text by the file tools (readFile/searchCode). */
export const TEXT_EXTENSIONS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.css', '.html',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bat', '.ps1', '.env', '.txt', '.xml', '.svg',
  '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.sqlite', '.db'
]);

/** Directories skipped by the file-tree walk (walkDir) and the codebase scans. */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'venv', '.venv', 'dist', 'build',
  '.next', '.cache', '__pycache__', 'env', '.vscode'
]);
