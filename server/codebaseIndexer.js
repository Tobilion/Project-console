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

  const dirs = tree.filter(e => e.type === 'dir').map(e => e.path);
  const files = tree.filter(e => e.type === 'file').map(e => e.path);

  return {
    totalDirs: dirs.length,
    totalFiles: files.length,
    languages,
    entryPoints,
    entrySnippets,
    directoryTree: dirs.slice(0, 30),
    fileSample: files.slice(0, 50),
    keyFiles,
    hasCli: files.some(f => pathParts(f).at(-1) === 'cli.js' || pathParts(f).at(-1) === 'cli.ts'),
    hasTests: files.some(f => f.includes('test') || f.includes('spec') || f.includes('.test.')),
    hasConfig: !!(keyFiles['package.json'] || keyFiles['pyproject.toml'] || keyFiles['Cargo.toml'])
  };
}
