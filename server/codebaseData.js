/**
 * Pure-data registry for codebaseIndexer (Phase 8 split, 2026-08-04 — extracted from
 * codebaseIndexer.js, content unchanged). All static patterns/maps/caps that the parsers,
 * detection, and scan modules share — nothing here imports anything except nothing.
 * Kept in original definition order from the source file.
 */

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
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  // Angular/Flutter config files (2026-08-11, task 0c): read as key files so detectFrameworks
  // identifies Angular/Flutter even when package.json is a placeholder or lives in a wrapper
  // sub-package — feeds the overview/tech-stack answers and the run-command guess.
  'angular.json', 'ng.json', 'pubspec.yaml'];

// Widened from a JS/Python-only list — a project written in Go, Rust, Java, Ruby, PHP, or C#
// with none of these present used to have zero recognized "entry point", which fed directly
// into projectScanner.js's old all-or-nothing recognition gap (see that file's own notes).
const ENTRY_NAMES = ['main.tsx', 'main.ts', 'main.jsx', 'main.js', 'index.tsx', 'index.ts',
  'index.js', 'App.tsx', 'App.ts', 'App.js', 'server.js', 'server.ts', 'index.html',
  'main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py',
  'main.go', 'main.rs', 'Program.cs', 'Main.java'];
const MAX_ENTRY_SNIPPETS = 2;
const ENTRY_SNIPPET_CHARS = 1500;

// --- Repo map (Aider-style whole-project signature summary) ---
// entrySnippets above only covers 1-2 entry-point files,
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

// Manifest filenames that mark "this directory is its own installable/runnable package" —
// finding more than one distinct directory containing one of these is a real monorepo signal
// (a root README/CLAUDE.md describing the whole thing, plus independently-runnable sub-packages
// underneath), not just a project with a deeply-nested file structure.
const MONOREPO_MANIFESTS = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'composer.json', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts',
]);

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)$/;
const MAX_TODO_FILES = 150; // same cap as buildRepoMap, same "don't read the whole world" reasoning
const MAX_TODO_RESULTS = 60;

export {
  IGNORE_DIRS, KEY_FILES, ENTRY_NAMES, MAX_ENTRY_SNIPPETS, ENTRY_SNIPPET_CHARS,
  CODE_EXTS, MAX_REPO_MAP_FILES, MAX_FILE_READ_BYTES, MAX_SIGNATURES_PER_FILE,
  MAX_IMPORTS_PER_FILE, MAX_REPO_MAP_TOTAL_CHARS,
  JS_SIGNATURE_PATTERNS, PY_SIGNATURE_PATTERNS, GO_SIGNATURE_PATTERNS, RUST_SIGNATURE_PATTERNS,
  JAVA_SIGNATURE_PATTERNS, RUBY_SIGNATURE_PATTERNS, PHP_SIGNATURE_PATTERNS, CSHARP_SIGNATURE_PATTERNS,
  SIGNATURE_PATTERNS_BY_EXT, AST_CAPABLE_EXTS,
  JS_IMPORT_PATTERNS, PY_IMPORT_PATTERNS,
  MAX_ROUTES_PER_FILE, MAX_TOTAL_ROUTES, EXPRESS_ROUTE_RE, FLASK_ROUTE_RE, FASTAPI_ROUTE_RE, DJANGO_PATH_RE,
  REAL_CODE_EXTS, NPM_FRAMEWORK_MAP, PY_FRAMEWORK_MAP, MONOREPO_MANIFESTS,
  TODO_RE, MAX_TODO_FILES, MAX_TODO_RESULTS,
};
