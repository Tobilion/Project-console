/**
 * codebaseIndexer — project structure indexing (Phase 8 split, 2026-08-04: the static
 * pattern/map/cap registry moved to codebaseData.js, the pure parse functions to
 * codebaseParsers.js, tree/keyfile detection to codebaseDetection.js, and the on-demand
 * IO scans to codebaseScans.js — this file is the orchestrator only, logic unchanged).
 *
 * indexProject() produces the `codebaseIndex` every project carries: languages, frameworks,
 * entry points (+ snippets), a whole-project repo map (per-file top-level signatures +
 * imports + reverse "used by"), API route map, monorepo/sub-package detection, and the
 * cheap structural signals (hasGit/hasCli/hasTests/...). Fed into the AI system prompt
 * (ollamaContext.js), the router tier (localRouter.js), and trigger-mode answers.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { KEY_FILES, CODE_EXTS, MAX_REPO_MAP_FILES, MAX_FILE_READ_BYTES,
  MAX_TOTAL_ROUTES, MAX_IMPORTS_PER_FILE, MAX_REPO_MAP_TOTAL_CHARS,
  MAX_ENTRY_SNIPPETS, ENTRY_SNIPPET_CHARS } from './codebaseData.js';
import { extractSignatures, extractImports, extractRoutes, extractSymbols, buildReverseImportIndex, pathParts } from './codebaseParsers.js';
import { detectLanguages, hasRealCodeFiles, detectFrameworks, findEntryPoints, detectSubPackages } from './codebaseDetection.js';
import { readProjectTree, hasGitRepo } from './codebaseScans.js';
import { computeSymbolReferences } from './codebaseGraph.js';

// Cache key file reads with mtime invalidation — avoids re-reading package.json and other
// config files on every indexProject call when nothing has changed on disk.
const keyFileCache = new Map();

// Keyed by absolute file path (not projectPath:name like keyFileCache, since repo-map files
// aren't a small fixed list) — same mtime-invalidation shape as keyFileCache above. Like
// keyFileCache, entries for deleted/renamed files are never evicted; acceptable for a
// dev-machine-local cache that lives for the process lifetime, same tradeoff already made there.
const repoMapFileCache = new Map();

async function readKeyFiles(projectPath) {
  const contents = {};
  for (const name of KEY_FILES) {
    const fullPath = path.join(projectPath, name);
    const cacheKey = `${projectPath}:${name}`;

    // Check cache with mtime invalidation
    try {
      const stat = fsSync.statSync(fullPath);
      const cached = keyFileCache.get(cacheKey);
      if (cached && cached.mtime >= stat.mtimeMs) {
        contents[name] = cached.content;
        continue;
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content;
      keyFileCache.set(cacheKey, { content: truncated, mtime: stat.mtimeMs });
      contents[name] = truncated;
    } catch {}
  }
  return contents;
}

async function readEntrySnippets(projectPath, entryPoints) {
  const snippets = {};
  const codeEntries = entryPoints.filter(f => !f.toLowerCase().endsWith('.html'));
  for (const relPath of codeEntries.slice(0, MAX_ENTRY_SNIPPETS)) {
    try {
      const content = await fs.readFile(path.join(projectPath, relPath), 'utf-8');
      snippets[relPath] = content.length > ENTRY_SNIPPET_CHARS
        ? `${content.slice(0, ENTRY_SNIPPET_CHARS)}\n... (truncated — use readFile("${relPath}") for the rest)`
        : content;
    } catch {}
  }
  return snippets;
}

async function buildRepoMap(projectPath, tree) {
  const files = tree
    .filter(e => e.type === 'file' && CODE_EXTS.has(path.extname(e.path).toLowerCase()))
    // Prefer shallower paths first (more likely to be meaningful modules, not deeply-nested
    // generated/vendor code) when a project has more code files than MAX_REPO_MAP_FILES allows.
    .sort((a, b) => pathParts(a.path).length - pathParts(b.path).length);
  const selected = files.slice(0, MAX_REPO_MAP_FILES);

  const entries = [];
  const allRoutes = [];
  const contents = new Map();
  for (const f of selected) {
    const fullPath = path.join(projectPath, f.path);
    const ext = path.extname(f.path).toLowerCase();
    try {
      const stat = fsSync.statSync(fullPath);
      const cached = repoMapFileCache.get(fullPath);
      let signatures, imports, routes, symbols, content;
      if (cached && cached.mtime >= stat.mtimeMs) {
        signatures = cached.signatures;
        imports = cached.imports || [];
        routes = cached.routes || [];
        symbols = cached.symbols || [];
        content = cached.content;
      } else {
        const raw = await fs.readFile(fullPath, 'utf-8');
        content = raw.length > MAX_FILE_READ_BYTES ? raw.slice(0, MAX_FILE_READ_BYTES) : raw;
        signatures = await extractSignatures(content, ext);
        imports = extractImports(content, ext);
        routes = extractRoutes(content, ext, f.path);
        symbols = await extractSymbols(content, ext);
        repoMapFileCache.set(fullPath, { mtime: stat.mtimeMs, signatures, imports, routes, symbols, content });
      }
      if (routes.length && allRoutes.length < MAX_TOTAL_ROUTES) {
        routes.forEach((r) => allRoutes.push({ ...r, file: f.path }));
      }
      contents.set(f.path.split(path.sep).join('/'), content);
      if (signatures.length || imports.length || symbols.length) entries.push({ path: f.path, signatures, imports, symbols });
    } catch {}
  }
  // Reverse index ("what imports this file") — computed once over the whole selected file set
  // rather than per-file, since it needs to see every entry's imports before it can answer "who
  // points at me". Attached onto each entry rather than kept as a separate structure so
  // formatRepoMap() (and any future consumer) sees import direction both ways per file.
  const reverse = buildReverseImportIndex(entries);
  for (const entry of entries) {
    const importedBy = reverse[entry.path.split(path.sep).join('/')];
    if (importedBy?.length) entry.importedBy = importedBy.slice(0, MAX_IMPORTS_PER_FILE);
  }
  return { entries, routes: allRoutes, contents };
}

/**
 * Render a repo map (as produced by buildRepoMap/stored on idx.repoMap) into a capped text
 * block, one line per file: `path: sigA, sigB, ... [imports: x, y] [used by: a, b]`. Two
 * independent callers trim to different sizes — `ollamaContext.js`'s full system prompt can
 * afford more than `localRouter.js`'s single bounded classification call — so this takes
 * maxChars rather than assuming one global size.
 */
export function formatRepoMap(repoMap, maxChars = MAX_REPO_MAP_TOTAL_CHARS) {
  if (!repoMap || !repoMap.length) return '';
  let out = '';
  for (const { path: relPath, signatures, imports, importedBy } of repoMap) {
    const sigPart = signatures && signatures.length ? signatures.join(', ') : '(no top-level signatures)';
    const importPart = imports && imports.length ? ` [imports: ${imports.join(', ')}]` : '';
    const importedByPart = importedBy && importedBy.length ? ` [used by: ${importedBy.join(', ')}]` : '';
    const line = `${relPath}: ${sigPart}${importPart}${importedByPart}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

/** Renders idx.apiRoutes (see indexProject) into a short text block for the AI system prompt. */
export function formatApiRoutes(routes, maxChars = 2000) {
  if (!routes || !routes.length) return '';
  let out = '';
  for (const { method, path: routePath, file } of routes) {
    const line = `${method} ${routePath}  (${file})\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

export async function indexProject(projectPath) {
  try {
    const stats = await fs.stat(projectPath);
    if (!stats.isDirectory()) return null;
  } catch {
    return null;
  }

  const tree = await readProjectTree(projectPath);
  const keyFiles = await readKeyFiles(projectPath);
  const languages = detectLanguages(tree);
  const frameworks = detectFrameworks(keyFiles);
  const entryPoints = findEntryPoints(tree);
  const entrySnippets = await readEntrySnippets(projectPath, entryPoints);
  const { entries: repoMap, routes: apiRoutes, contents } = await buildRepoMap(projectPath, tree);
  const symbolIndex = computeSymbolReferences(repoMap, contents);
  const gitRepo = await hasGitRepo(projectPath);
  const subPackages = detectSubPackages(tree);

  const dirs = tree.filter(e => e.type === 'dir').map(e => e.path);
  const files = tree.filter(e => e.type === 'file').map(e => e.path);

  return {
    totalDirs: dirs.length,
    totalFiles: files.length,
    languages,
    frameworks,
    entryPoints,
    entrySnippets,
    repoMap,
    symbolIndex,
    apiRoutes,
    subPackages,
    isMonorepo: subPackages.length > 1,
    directoryTree: dirs.slice(0, 30),
    fileSample: files.slice(0, 50),
    keyFiles,
    hasCli: files.some(f => pathParts(f).at(-1) === 'cli.js' || pathParts(f).at(-1) === 'cli.ts'),
    hasTests: files.some(f => f.includes('test') || f.includes('spec') || f.includes('.test.')),
    hasConfig: !!(keyFiles['package.json'] || keyFiles['pyproject.toml'] || keyFiles['Cargo.toml']),
    hasGit: gitRepo,
    hasRealCode: hasRealCodeFiles(tree),
  };
}

// Re-exported so every external importer keeps working unchanged: configInitializer.js /
// projectScanner.js / routes/projectRoutes.js (indexProject), matcher.js (formatRepoMap),
// promptRenderers.js (formatRepoMap, formatApiRoutes), builtinIntents.js (formatApiRoutes,
// findTodos, findBiggestFiles, findRecentActivity). hasGitRepo has no external importer today
// but is kept on the surface for stability.
export { findTodos, findBiggestFiles, findRecentActivity, hasGitRepo } from './codebaseScans.js';
