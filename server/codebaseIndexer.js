import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'venv', '.venv', 'dist', 'build',
  '.next', '.cache', '__pycache__', 'env', '.vscode'
]);

const KEY_FILES = ['package.json', 'composer.json', 'cargo.toml', 'go.mod',
  'requirements.txt', 'pyproject.toml', 'Gemfile', 'CMakeLists.txt',
  'Dockerfile', 'docker-compose.yml', 'Makefile'];

const ENTRY_NAMES = ['main.tsx', 'main.ts', 'main.jsx', 'main.js', 'index.tsx', 'index.ts',
  'index.js', 'App.tsx', 'App.ts', 'App.js', 'main.py', 'index.html'];
const MAX_ENTRY_SNIPPETS = 2;
const ENTRY_SNIPPET_CHARS = 1500;

// Cache key file reads with mtime invalidation — avoids re-reading package.json and other
// config files on every indexProject call when nothing has changed on disk.
const keyFileCache = new Map();

// --- Repo map (Aider-style whole-project signature summary) ---
// LOCAL_ROUTER_UPGRADE_PROMPT.md piece 2: entrySnippets above only covers 1-2 entry-point files,
// so even the router/full-AI-mode model has no idea "the config file" or "that component" exists
// unless it happens to be an entry point. This is a cheap regex-based export/function/class name
// extractor across the *whole* project (no new parser dependency), small enough to fit in a
// capped slice of a small local model's context.
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);
const MAX_REPO_MAP_FILES = 150; // cap how many files get read/scanned per index pass
const MAX_FILE_READ_BYTES = 20000; // don't regex-scan huge generated/bundled files in full
const MAX_SIGNATURES_PER_FILE = 12;
const MAX_REPO_MAP_TOTAL_CHARS = 12000; // cap on the stored map itself; consumers trim further

// Keyed by absolute file path (not projectPath:name like keyFileCache, since repo-map files
// aren't a small fixed list) — same mtime-invalidation shape as keyFileCache above. Like
// keyFileCache, entries for deleted/renamed files are never evicted; acceptable for a
// dev-machine-local cache that lives for the process lifetime, same tradeoff already made there.
const repoMapFileCache = new Map();

// Top-level (unindented, hence the `^` anchors with no leading `\s*`) JS/TS export and
// declaration patterns. Deliberately misses nested/inner functions and non-top-level
// declarations — this is a "what does this file expose" map, not a full outline.
const JS_SIGNATURE_PATTERNS = [
  /^export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+default\s+class\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+class\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^module\.exports\.([A-Za-z_$][\w$]*)\s*=/gm,
  /^exports\.([A-Za-z_$][\w$]*)\s*=/gm,
  /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
  /^class\s+([A-Za-z_$][\w$]*)/gm,
];

const PY_SIGNATURE_PATTERNS = [
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
  /^class\s+([A-Za-z_]\w*)/gm,
];

function extractSignatures(content, ext) {
  const patterns = ext === '.py' ? PY_SIGNATURE_PATTERNS : JS_SIGNATURE_PATTERNS;
  const names = [];
  for (const pattern of patterns) {
    // Each pattern object is reused across files but regex.exec with the `g` flag is stateful
    // (lastIndex) — reset before each file to avoid skipping matches from a previous file's
    // leftover position.
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content))) {
      if (m[1]) names.push(m[1]);
    }
  }
  return [...new Set(names)].slice(0, MAX_SIGNATURES_PER_FILE);
}

async function buildRepoMap(projectPath, tree) {
  const files = tree
    .filter(e => e.type === 'file' && CODE_EXTS.has(path.extname(e.path).toLowerCase()))
    // Prefer shallower paths first (more likely to be meaningful modules, not deeply-nested
    // generated/vendor code) when a project has more code files than MAX_REPO_MAP_FILES allows.
    .sort((a, b) => pathParts(a.path).length - pathParts(b.path).length);
  const selected = files.slice(0, MAX_REPO_MAP_FILES);

  const entries = [];
  for (const f of selected) {
    const fullPath = path.join(projectPath, f.path);
    try {
      const stat = fsSync.statSync(fullPath);
      const cached = repoMapFileCache.get(fullPath);
      let signatures;
      if (cached && cached.mtime >= stat.mtimeMs) {
        signatures = cached.signatures;
      } else {
        const raw = await fs.readFile(fullPath, 'utf-8');
        const content = raw.length > MAX_FILE_READ_BYTES ? raw.slice(0, MAX_FILE_READ_BYTES) : raw;
        signatures = extractSignatures(content, path.extname(f.path).toLowerCase());
        repoMapFileCache.set(fullPath, { mtime: stat.mtimeMs, signatures });
      }
      if (signatures.length) entries.push({ path: f.path, signatures });
    } catch {}
  }
  return entries;
}

/**
 * Render a repo map (as produced by buildRepoMap/stored on idx.repoMap) into a capped text
 * block, one line per file: `path: sigA, sigB, ...`. Two independent callers trim to different
 * sizes — `ollamaContext.js`'s full system prompt can afford more than `localRouter.js`'s single
 * bounded classification call — so this takes maxChars rather than assuming one global size.
 */
export function formatRepoMap(repoMap, maxChars = MAX_REPO_MAP_TOTAL_CHARS) {
  if (!repoMap || !repoMap.length) return '';
  let out = '';
  for (const { path: relPath, signatures } of repoMap) {
    const line = `${relPath}: ${signatures.join(', ')}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

function pathParts(relPath) {
  return relPath.split(/[\\/]/);
}

async function readProjectTree(dirPath, maxDepth = 4) {
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

function detectLanguages(tree) {
  const extMap = {};
  for (const entry of tree) {
    if (entry.type === 'file') {
      const ext = path.extname(entry.path).toLowerCase();
      if (ext) extMap[ext] = (extMap[ext] || 0) + 1;
    }
  }
  const langMap = {
    '.js': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript React',
    '.jsx': 'React JS', '.py': 'Python', '.rs': 'Rust', '.go': 'Go',
    '.java': 'Java', '.c': 'C', '.cpp': 'C++', '.cs': 'C#',
    '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin',
    '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS',
    '.html': 'HTML', '.sql': 'SQL', '.sh': 'Shell', '.bat': 'Batch',
    '.ps1': 'PowerShell', '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON',
    '.md': 'Markdown', '.toml': 'TOML', '.xml': 'XML'
  };
  const detected = {};
  for (const [ext, count] of Object.entries(extMap)) {
    const lang = langMap[ext] || ext.slice(1);
    detected[lang] = (detected[lang] || 0) + count;
  }
  return Object.entries(detected)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count} files)`);
}

function findEntryPoints(tree) {
  const files = tree.filter(e => e.type === 'file');
  const found = [];
  for (const name of ENTRY_NAMES) {
    const candidates = files.filter(f => {
      const parts = pathParts(f.path);
      return parts[parts.length - 1] === name;
    });
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => pathParts(a.path).length - pathParts(b.path).length);
    found.push(candidates[0].path);
  }
  return found;
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
  const entryPoints = findEntryPoints(tree);
  const entrySnippets = await readEntrySnippets(projectPath, entryPoints);
  const repoMap = await buildRepoMap(projectPath, tree);

  const dirs = tree.filter(e => e.type === 'dir').map(e => e.path);
  const files = tree.filter(e => e.type === 'file').map(e => e.path);

  return {
    totalDirs: dirs.length,
    totalFiles: files.length,
    languages,
    entryPoints,
    entrySnippets,
    repoMap,
    directoryTree: dirs.slice(0, 30),
    fileSample: files.slice(0, 50),
    keyFiles,
    hasCli: files.some(f => pathParts(f).at(-1) === 'cli.js' || pathParts(f).at(-1) === 'cli.ts'),
    hasTests: files.some(f => f.includes('test') || f.includes('spec') || f.includes('.test.')),
    hasConfig: !!(keyFiles['package.json'] || keyFiles['pyproject.toml'] || keyFiles['Cargo.toml'])
  };
}
