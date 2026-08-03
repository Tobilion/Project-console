import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'venv', '.venv', 'dist', 'build',
  '.next', '.cache', '__pycache__', 'env', '.vscode', 'target',
  'bin', 'obj', '.pytest_cache', 'coverage', 'vendor'
]);

const KEY_FILES = ['package.json', 'composer.json', 'cargo.toml', 'go.mod',
  'requirements.txt', 'pyproject.toml', 'Gemfile', 'CMakeLists.txt',
  'Dockerfile', 'docker-compose.yml', 'Makefile',
  // Java/JVM build files — previously missing entirely, so a Maven/Gradle project's keyFiles
  // was always empty and detectFrameworks()/the trigger-mode run-command guesser (see
  // builtinIntents.js) had nothing to detect a Java project from besides bare .java file count.
  'pom.xml', 'build.gradle', 'build.gradle.kts'];

// Widened from a JS/Python-only list — a project written in Go, Rust, Java, Ruby, PHP, or C#
// with none of these present used to have zero recognized "entry point", which fed directly
// into projectScanner.js's old all-or-nothing recognition gap (see that file's own notes).
const ENTRY_NAMES = ['main.tsx', 'main.ts', 'main.jsx', 'main.js', 'index.tsx', 'index.ts',
  'index.js', 'App.tsx', 'App.ts', 'App.js', 'server.js', 'server.ts', 'index.html',
  'main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py',
  'main.go', 'main.rs', 'Program.cs', 'Main.java'];
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
//
// Widened 2026-07-30 beyond JS/TS/Python to Go, Rust, Java, Ruby, PHP, and C# — same rationale as
// ENTRY_NAMES above: a non-JS/Python project used to get an empty repo map entirely, which meant
// no "deep" structural understanding for it at all, only entry-point snippets (if any entry name
// happened to match). Coverage is intentionally shallow (top-level declarations only, regex-based,
// no real parser) — the goal is "what does this file expose", not a full outline.
const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py',
  '.go', '.rs', '.java', '.rb', '.php', '.cs'
]);
const MAX_REPO_MAP_FILES = 150; // cap how many files get read/scanned per index pass
const MAX_FILE_READ_BYTES = 20000; // don't regex-scan huge generated/bundled files in full
const MAX_SIGNATURES_PER_FILE = 12;
const MAX_IMPORTS_PER_FILE = 8;
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

// Everything below JS/Python is deliberately looser (`^\s*` instead of `^`) since these
// languages' idiomatic top-level constructs are more often indented one level (Java classes
// inside a package block's braces are still column-0 in practice, but method-less coverage
// keeps false-positive risk low without a real parser).
const GO_SIGNATURE_PATTERNS = [
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm,
  /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm,
];

const RUST_SIGNATURE_PATTERNS = [
  /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,
  /^(?:pub\s+)?struct\s+([A-Za-z_]\w*)/gm,
  /^(?:pub\s+)?enum\s+([A-Za-z_]\w*)/gm,
  /^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/gm,
];

const JAVA_SIGNATURE_PATTERNS = [
  /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:public\s+)?enum\s+([A-Za-z_]\w*)/gm,
];

const RUBY_SIGNATURE_PATTERNS = [
  /^\s*def\s+([A-Za-z_]\w*[?!]?)/gm,
  /^\s*class\s+([A-Za-z_:]\w*)/gm,
  /^\s*module\s+([A-Za-z_:]\w*)/gm,
];

const PHP_SIGNATURE_PATTERNS = [
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/gm,
  /^\s*class\s+([A-Za-z_]\w*)/gm,
];

const CSHARP_SIGNATURE_PATTERNS = [
  /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:sealed\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:public|private|protected|internal)?\s*interface\s+([A-Za-z_]\w*)/gm,
];

const SIGNATURE_PATTERNS_BY_EXT = {
  '.py': PY_SIGNATURE_PATTERNS,
  '.go': GO_SIGNATURE_PATTERNS,
  '.rs': RUST_SIGNATURE_PATTERNS,
  '.java': JAVA_SIGNATURE_PATTERNS,
  '.rb': RUBY_SIGNATURE_PATTERNS,
  '.php': PHP_SIGNATURE_PATTERNS,
  '.cs': CSHARP_SIGNATURE_PATTERNS,
};

const AST_CAPABLE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

// Real-parser upgrade (2026-07-30, requested directly — "switch to a real parser"). Uses the
// `typescript` package's compiler API rather than adding a new dependency (acorn) — it's already
// a devDependency here for `npm run lint` (tsc --noEmit), so it's already installed by the exact
// same `npm install` this project already needs, and unlike acorn it natively understands TS/TSX
// syntax (type annotations, interfaces, generics) instead of throwing on it. Loaded lazily via
// dynamic import and cached; if it's ever unavailable for any reason (a stripped production
// install with devDependencies pruned, a version mismatch, anything), every call site below
// catches and falls through to the regex extractor — this is a strict enhancement, never a new
// hard requirement, and JS/TS/TSX correctness never regresses below what regex already gave.
let tsModulePromise = null;
function getTsModule() {
  if (!tsModulePromise) {
    tsModulePromise = import('typescript').then((m) => m.default ?? m).catch(() => null);
  }
  return tsModulePromise;
}

function scriptKindFor(TS, ext) {
  switch (ext) {
    case '.ts': return TS.ScriptKind.TS;
    case '.tsx': return TS.ScriptKind.TSX;
    case '.jsx': return TS.ScriptKind.JSX;
    default: return TS.ScriptKind.JS; // .js, .mjs, .cjs
  }
}

/** Extracts a name from one top-level AST statement, same "what does this file expose at the
 *  top level" scope as the regex extractor (functions/classes/vars, exported or not — matching
 *  JS_SIGNATURE_PATTERNS' existing behavior) — plus interfaces/type aliases/enums, which regex
 *  never covered at all since TS type-only constructs have no equivalent in the old pattern list. */
function namesFromTsStatement(TS, stmt, names) {
  const inner = TS.isExportAssignment(stmt) ? null : stmt;
  if (TS.isFunctionDeclaration(inner) && inner.name) names.push(inner.name.text);
  else if (TS.isClassDeclaration(inner) && inner.name) names.push(inner.name.text);
  else if (TS.isInterfaceDeclaration(inner)) names.push(inner.name.text);
  else if (TS.isTypeAliasDeclaration(inner)) names.push(inner.name.text);
  else if (TS.isEnumDeclaration(inner)) names.push(inner.name.text);
  else if (TS.isVariableStatement(inner)) {
    for (const decl of inner.declarationList.declarations) {
      if (TS.isIdentifier(decl.name)) names.push(decl.name.text);
    }
  } else if (TS.isExportDeclaration(inner) && inner.exportClause && TS.isNamedExports(inner.exportClause)) {
    for (const spec of inner.exportClause.elements) names.push(spec.name.text);
  }
}

async function extractSignaturesViaAst(content, ext) {
  if (!AST_CAPABLE_EXTS.has(ext)) return null;
  const TS = await getTsModule();
  if (!TS) return null;
  try {
    const sourceFile = TS.createSourceFile(`file${ext}`, content, TS.ScriptTarget.Latest, false, scriptKindFor(TS, ext));
    const names = [];
    for (const stmt of sourceFile.statements) {
      namesFromTsStatement(TS, stmt, names);
      // export default function foo() {} / export default class Foo {} — the declaration is
      // nested one level under ExportAssignment/ExportDefault in some TS AST shapes; handle the
      // common `export default function/class NAME` case explicitly since it's extremely common
      // and namesFromTsStatement's plain dispatch above only sees the outer export wrapper.
      if (TS.isExportAssignment(stmt) && stmt.expression) {
        const expr = stmt.expression;
        if ((TS.isFunctionExpression(expr) || TS.isClassExpression(expr)) && expr.name) names.push(expr.name.text);
        else if (TS.isIdentifier(expr)) names.push(expr.text);
      }
    }
    return [...new Set(names)].slice(0, MAX_SIGNATURES_PER_FILE);
  } catch {
    return null; // real parse error — fall back to regex rather than losing the file entirely
  }
}

async function extractSignatures(content, ext) {
  const viaAst = await extractSignaturesViaAst(content, ext);
  if (viaAst && viaAst.length) return viaAst;
  const patterns = SIGNATURE_PATTERNS_BY_EXT[ext] || JS_SIGNATURE_PATTERNS;
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

// Cross-file relationship hints ("what does this file depend on") — cheap enough to run
// alongside signature extraction and gives the repo map a sliver of real dependency-graph
// information instead of being a flat, disconnected list of per-file exports. Not a real
// module-resolution pass (no path resolution, no node_modules awareness) — just surfaces the
// literal specifier strings so a model can see "this file imports from ../state.js" without
// having to open it first.
const JS_IMPORT_PATTERNS = [
  /^import\s+(?:[\s\S]*?)\s+from\s+['"](.+?)['"]/gm,
  /^import\s+['"](.+?)['"]/gm,
  /require\(\s*['"](.+?)['"]\s*\)/gm,
];
const PY_IMPORT_PATTERNS = [
  /^from\s+([\w.]+)\s+import/gm,
  /^import\s+([\w.]+)/gm,
];

function extractImports(content, ext) {
  const patterns = ext === '.py' ? PY_IMPORT_PATTERNS : (CODE_EXTS.has(ext) && (ext.startsWith('.j') || ext.startsWith('.t') || ext === '.mjs' || ext === '.cjs') ? JS_IMPORT_PATTERNS : null);
  if (!patterns) return [];
  const specs = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content))) {
      if (m[1] && !specs.includes(m[1])) specs.push(m[1]);
    }
  }
  // Local/relative imports are far more useful for "what talks to what" than third-party
  // package names (which the key-files/framework detection already covers) — prefer those
  // when trimming to the cap.
  specs.sort((a, b) => {
    const aLocal = a.startsWith('.') ? 0 : 1;
    const bLocal = b.startsWith('.') ? 0 : 1;
    return aLocal - bLocal;
  });
  return specs.slice(0, MAX_IMPORTS_PER_FILE);
}

// --- API route detection (Express/Flask/FastAPI/Django) ---
// A cheap regex pass over the same file content already being read for signatures/imports —
// gives a lightweight "what does this app expose over HTTP" surface map, which is a genuinely
// different (and often more useful) kind of "deep understanding" than a flat function-name list.
// Deliberately narrow: only the handful of route-declaration shapes below, so it doesn't false-
// positive on unrelated code that happens to call a method named `get`/`post`.
const MAX_ROUTES_PER_FILE = 20;
const MAX_TOTAL_ROUTES = 200;

const EXPRESS_ROUTE_RE = /\b(?:app|router)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const FLASK_ROUTE_RE = /@(?:app|bp|blueprint)\s*\.\s*route\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?\)/g;
const FASTAPI_ROUTE_RE = /@(?:app|router)\s*\.\s*(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g;
const DJANGO_PATH_RE = /\bpath\(\s*r?['"]([^'"]*)['"]/g;

function extractRoutes(content, ext, relPath) {
  const routes = [];
  if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx' || ext === '.mjs' || ext === '.cjs') {
    EXPRESS_ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = EXPRESS_ROUTE_RE.exec(content))) {
      routes.push({ method: m[1].toUpperCase(), path: m[2] });
    }
  } else if (ext === '.py') {
    FLASK_ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = FLASK_ROUTE_RE.exec(content))) {
      const methods = m[2] ? m[2].replace(/['"\s]/g, '').split(',').filter(Boolean) : ['GET'];
      methods.forEach((method) => routes.push({ method, path: m[1] }));
    }
    FASTAPI_ROUTE_RE.lastIndex = 0;
    while ((m = FASTAPI_ROUTE_RE.exec(content))) {
      routes.push({ method: m[1].toUpperCase(), path: m[2] });
    }
    // Django's urlpatterns use a generic `path(...)` call that's too common a name to regex-match
    // safely outside urls.py itself — restrict to files that look like Django URL config.
    if (/urls\.py$/i.test(relPath) || /urlpatterns/.test(content)) {
      DJANGO_PATH_RE.lastIndex = 0;
      while ((m = DJANGO_PATH_RE.exec(content))) {
        routes.push({ method: 'ROUTE', path: m[1] || '/' });
      }
    }
  }
  return routes.slice(0, MAX_ROUTES_PER_FILE);
}

// Resolves a local/relative import specifier (e.g. "../state.js", "./foo") to one of the repo
// map's own known file paths, so buildReverseImportIndex() below can say "these N files import
// this one" instead of only "this file imports these N things" — not real module resolution (no
// package.json "main"/exports awareness, no node_modules), just enough to connect same-project
// relative imports to the file they actually point at.
function resolveLocalImport(fromRelPath, spec, knownPaths) {
  if (!spec.startsWith('.')) return null;
  const fromDir = path.dirname(fromRelPath);
  const raw = path.normalize(path.join(fromDir, spec)).split(path.sep).join('/');
  const candidates = [
    raw, `${raw}.js`, `${raw}.ts`, `${raw}.jsx`, `${raw}.tsx`, `${raw}.mjs`, `${raw}.cjs`, `${raw}.py`,
    `${raw}/index.js`, `${raw}/index.ts`, `${raw}/index.jsx`, `${raw}/index.tsx`,
  ];
  return candidates.find((c) => knownPaths.has(c)) || null;
}

function buildReverseImportIndex(entries) {
  const knownPaths = new Set(entries.map((e) => e.path.split(path.sep).join('/')));
  const reverse = {};
  for (const entry of entries) {
    for (const spec of entry.imports || []) {
      const resolved = resolveLocalImport(entry.path, spec, knownPaths);
      if (!resolved) continue;
      if (!reverse[resolved]) reverse[resolved] = [];
      if (!reverse[resolved].includes(entry.path)) reverse[resolved].push(entry.path);
    }
  }
  return reverse;
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
  for (const f of selected) {
    const fullPath = path.join(projectPath, f.path);
    const ext = path.extname(f.path).toLowerCase();
    try {
      const stat = fsSync.statSync(fullPath);
      const cached = repoMapFileCache.get(fullPath);
      let signatures, imports, routes;
      if (cached && cached.mtime >= stat.mtimeMs) {
        signatures = cached.signatures;
        imports = cached.imports || [];
        routes = cached.routes || [];
      } else {
        const raw = await fs.readFile(fullPath, 'utf-8');
        const content = raw.length > MAX_FILE_READ_BYTES ? raw.slice(0, MAX_FILE_READ_BYTES) : raw;
        signatures = await extractSignatures(content, ext);
        imports = extractImports(content, ext);
        routes = extractRoutes(content, ext, f.path);
        repoMapFileCache.set(fullPath, { mtime: stat.mtimeMs, signatures, imports, routes });
      }
      if (routes.length && allRoutes.length < MAX_TOTAL_ROUTES) {
        routes.forEach((r) => allRoutes.push({ ...r, file: f.path }));
      }
      if (signatures.length || imports.length) entries.push({ path: f.path, signatures, imports });
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
  return { entries, routes: allRoutes };
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
    '.java': 'Java', '.c': 'C', '.cpp': 'C++', '.h': 'C/C++ Header', '.hpp': 'C/C++ Header', '.cs': 'C#',
    '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin',
    '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS',
    '.html': 'HTML', '.sql': 'SQL', '.sh': 'Shell', '.bat': 'Batch',
    '.ps1': 'PowerShell', '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON',
    '.md': 'Markdown', '.toml': 'TOML', '.xml': 'XML'
  };
  const detected = {};
  for (const [ext, count] of Object.entries(extMap)) {
    // Fixed 2026-07-30 (reported directly — folders full of .zip archives and other junk were
    // getting recognized as "projects"). This used to fall back to `ext.slice(1)` for ANY
    // extension not in langMap — a folder with three .zip files got a fabricated "zip (3 files)"
    // entry in idx.languages, which is not a programming language at all. Since
    // isRecognizableByCodeAlone() (projectScanner.js) checks "does this project have any detected
    // language" as one of its three recognition signals, that fabricated entry alone was enough
    // to make a zip-only folder pass as a real project. Only extensions actually mapped to a real
    // language/format name are counted now; anything else is simply not a "language" here.
    const lang = langMap[ext];
    if (!lang) continue;
    detected[lang] = (detected[lang] || 0) + count;
  }
  return Object.entries(detected)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count} files)`);
}

// Stricter than idx.languages (which also legitimately includes markup/config/data formats like
// CSS/JSON/YAML/Markdown for "what languages are in this project" answers) — this is specifically
// for deciding "is this folder a real code project" in projectScanner.js's discovery fallback, so
// it deliberately excludes anything that isn't an actual programming/scripting language. A folder
// containing only docs/config/data files (or, after the fix above, junk like .zip archives)
// should NOT pass this check even though some of those extensions are legitimately reported in
// idx.languages elsewhere.
const REAL_CODE_EXTS = new Set([
  ...CODE_EXTS, '.c', '.cpp', '.h', '.hpp', '.swift', '.kt', '.vue', '.svelte', '.sh', '.ps1',
]);

function hasRealCodeFiles(tree) {
  return tree.some((e) => e.type === 'file' && REAL_CODE_EXTS.has(path.extname(e.path).toLowerCase()));
}

// Known npm/pip package names → a human-readable framework/stack label. Deliberately a static
// lookup, not a full dependency resolver — this is meant to answer "what stack is this" at a
// glance (surfaced in trigger-mode overview answers and fed into the AI system prompt), not to
// build a real dependency tree.
const NPM_FRAMEWORK_MAP = {
  react: 'React', 'react-dom': 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', express: 'Express', fastify: 'Fastify',
  koa: 'Koa', vite: 'Vite', webpack: 'Webpack', electron: 'Electron', tailwindcss: 'Tailwind CSS',
  typescript: 'TypeScript', 'ts-node': 'TypeScript', jest: 'Jest', vitest: 'Vitest',
  mocha: 'Mocha', ws: 'WebSocket (ws)', 'socket.io': 'Socket.IO', mongoose: 'MongoDB (Mongoose)',
  prisma: 'Prisma', sequelize: 'Sequelize', tsx: 'tsx',
};
const PY_FRAMEWORK_MAP = {
  flask: 'Flask', django: 'Django', fastapi: 'FastAPI', pytest: 'pytest',
  numpy: 'NumPy', pandas: 'Pandas', torch: 'PyTorch', tensorflow: 'TensorFlow',
  sqlalchemy: 'SQLAlchemy', requests: 'requests', click: 'Click', uvicorn: 'Uvicorn',
  gunicorn: 'Gunicorn', celery: 'Celery', scrapy: 'Scrapy', streamlit: 'Streamlit',
};

function detectFrameworks(keyFiles) {
  const found = new Set();
  if (keyFiles['package.json']) {
    try {
      const pkg = JSON.parse(keyFiles['package.json'].replace(/\n\.\.\. \(truncated\)$/, ''));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const name of Object.keys(deps)) {
        if (NPM_FRAMEWORK_MAP[name]) found.add(NPM_FRAMEWORK_MAP[name]);
      }
    } catch {}
  }
  const reqText = keyFiles['requirements.txt'] || keyFiles['pyproject.toml'];
  if (reqText) {
    const lower = reqText.toLowerCase();
    for (const [pkg, label] of Object.entries(PY_FRAMEWORK_MAP)) {
      if (lower.includes(pkg)) found.add(label);
    }
  }
  if (keyFiles['Gemfile']) found.add('Ruby/Bundler');
  if (keyFiles['cargo.toml']) found.add('Rust/Cargo');
  if (keyFiles['go.mod']) found.add('Go modules');
  if (keyFiles['pom.xml']) {
    found.add('Java/Maven');
    if (/spring-boot/i.test(keyFiles['pom.xml'])) found.add('Spring Boot');
  }
  if (keyFiles['build.gradle'] || keyFiles['build.gradle.kts']) {
    found.add('Java/Gradle');
    if (/spring-boot/i.test(keyFiles['build.gradle'] || keyFiles['build.gradle.kts'] || '')) found.add('Spring Boot');
  }
  if (keyFiles['composer.json']) {
    found.add('PHP/Composer');
    try {
      const composer = JSON.parse(keyFiles['composer.json'].replace(/\n\.\.\. \(truncated\)$/, ''));
      const deps = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
      if (Object.keys(deps).some((d) => d.startsWith('laravel/'))) found.add('Laravel');
    } catch {}
  }
  if (keyFiles['Dockerfile'] || keyFiles['docker-compose.yml']) found.add('Docker');
  return [...found];
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

// Manifest filenames that mark "this directory is its own installable/runnable package" —
// finding more than one distinct directory containing one of these is a real monorepo signal
// (a root README/CLAUDE.md describing the whole thing, plus independently-runnable sub-packages
// underneath), not just a project with a deeply-nested file structure.
const MONOREPO_MANIFESTS = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'composer.json', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts',
]);

/** Groups manifest files (package.json, pyproject.toml, Cargo.toml, etc.) by containing
 *  directory. Returns [] when there's zero or one such location (i.e. not a monorepo) —
 *  callers should treat a non-empty result as "this project has N independently-manifested
 *  sub-packages", sorted shallowest-first (root, if present, always sorts first). */
function detectSubPackages(tree) {
  const manifestFiles = tree.filter((e) => e.type === 'file' && MONOREPO_MANIFESTS.has(pathParts(e.path).at(-1)));
  const byDir = new Map();
  for (const f of manifestFiles) {
    const dir = pathParts(f.path).slice(0, -1).join('/') || '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(pathParts(f.path).at(-1));
  }
  if (byDir.size <= 1) return [];
  return [...byDir.entries()]
    .map(([dir, manifests]) => ({ path: dir, manifests }))
    .sort((a, b) => pathParts(a.path).length - pathParts(b.path).length);
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

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)$/;
const MAX_TODO_FILES = 150; // same cap as buildRepoMap, same "don't read the whole world" reasoning
const MAX_TODO_RESULTS = 60;

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
  const { entries: repoMap, routes: apiRoutes } = await buildRepoMap(projectPath, tree);
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
