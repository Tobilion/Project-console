/**
 * checkIndexerCoverage.js — committed regression harness for codebaseIndexer (Phase 8,
 * 2026-08-04). Pure-function asserts against the REAL modules — no embeddings, no server,
 * no network, seconds to run.
 *
 * Run:  npm run check-indexer
 * Probe: node server/scripts/checkIndexerCoverage.js --probe   (prints actual values, no asserts)
 *
 * Same calibration flow as checkMatcherCoverage.js: batteries are self-asserting pairs baked
 * from the current verified behavior of the real modules; `--probe` prints actuals so a
 * deliberate behavior change can be re-baked. Run after ANY edit to codebaseIndexer.js or
 * its leaf modules (codebaseData/codebaseParsers/codebaseDetection/codebaseScans).
 *
 * Batteries:
 *  - DATA: registry sanity (key files, per-language pattern map, caps).
 *  - SIGNATURES: regex path (non-JS langs) + the `typescript` AST path (JS/TS: interfaces,
 *    type aliases, enums, export-default-with-name) + the 12-cap.
 *  - IMPORTS: JS vs Python patterns, local-first sort, cap 8, non-code ext -> [].
 *  - ROUTES: Express/Flask/FastAPI/Django shapes + the Django urls.py-only guard + cap 20.
 *  - DETECTION: languages (junk-only folders -> [], top-5 cap), real-code signal,
 *    frameworks (npm/pip/Spring Boot), entry-point picking, monorepo grouping.
 *  - INDEX: indexProject() on small fixture trees (git + Express app, truncation, monorepo)
 *    incl. repo-map reverse imports and the formatRepoMap/formatApiRoutes renderers.
 *  - SYMBOLS & GRAPH: extractSymbols AST/fallback records + codebaseGraph (symbol index,
 *    used-by edges, target-file resolution, targeted slice, symbolGraph renderer).
 *  - SCANS: findTodos/findBiggestFiles/findRecentActivity/hasGitRepo on fixture dirs incl.
 *    IGNORE_DIRS behavior (node_modules/.git/.hidden skipped).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'url';

const PROBE = process.argv.includes('--probe');
// Derived from this script's own location, not hardcoded to one machine/username (audit
// 2026-08-10 — see checkMatcherCoverage.js for the full rationale).
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;
const FIXTURE_ROOT = path.join(os.tmpdir(), 'console-indexer-fixtures');

const data = await import(pathToFileURL(base + 'codebaseData.js').href);
const parsers = await import(pathToFileURL(base + 'codebaseParsers.js').href);
const detection = await import(pathToFileURL(base + 'codebaseDetection.js').href);
const indexer = await import(pathToFileURL(base + 'codebaseIndexer.js').href);
const scans = await import(pathToFileURL(base + 'codebaseScans.js').href);
const graph = await import(pathToFileURL(base + 'codebaseGraph.js').href);

let total = 0, failed = 0;
function eq(label, got, expect) {
  total++;
  const g = JSON.stringify(got);
  const e = JSON.stringify(expect);
  const ok = g === e;
  if (!ok) failed++;
  if (PROBE) console.log(`  ${String(label).padEnd(48)} -> ${g}`);
  else if (!ok) console.log(`  FAIL ${label}\n    expected: ${e}\n    got:      ${g}`);
}

/** Builds the fixture tree under FIXTURE_ROOT; returns the fixture paths. */
async function buildFixtures() {
  await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
  const app = path.join(FIXTURE_ROOT, 'app');
  const trunc = path.join(FIXTURE_ROOT, 'trunc');
  const mono = path.join(FIXTURE_ROOT, 'mono');
  for (const dir of [app, path.join(app, 'src'), path.join(app, 'src', 'lib'), path.join(app, 'node_modules', 'junk'),
    path.join(app, '.git'), path.join(app, '.hidden'), trunc, mono, path.join(mono, 'apps', 'web')]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
  await fs.writeFile(path.join(app, 'src', 'server.js'),
    'import { greet } from "./lib/util";\nimport express from "express";\nexport function start() {}\n// TODO: add auth\napp.get("/health", handler);\n');
  await fs.writeFile(path.join(app, 'src', 'lib', 'util.js'),
    'export function greet(name) {}\nfunction helper() {}\n');
  await fs.writeFile(path.join(app, 'src', 'big.py'), 'x'.repeat(5000));
  await fs.mkdir(path.join(app, 'docs'), { recursive: true });
  await fs.writeFile(path.join(app, 'docs', 'guide.pdf'), 'fake-pdf-bytes');
  await fs.writeFile(path.join(app, 'node_modules', 'junk', 'junk.py'), '# TODO: must be ignored\n');
  await fs.writeFile(path.join(app, '.hidden', 'secret.py'), '# TODO: must be ignored too\n');
  await fs.writeFile(path.join(trunc, 'package.json'), JSON.stringify({ deps: { pad: 'x'.repeat(2600) } }));
  await fs.writeFile(path.join(mono, 'package.json'), '{}');
  await fs.writeFile(path.join(mono, 'apps', 'web', 'package.json'), '{}');
  return { app, trunc, mono };
}

console.log('Building fixtures...');
const fixtures = await buildFixtures();
const appTree = await scans.readProjectTree(fixtures.app);
const appIdx = await indexer.indexProject(fixtures.app);
const truncIdx = await indexer.indexProject(fixtures.trunc);
const monoIdx = await indexer.indexProject(fixtures.mono);

// Fixture-derived paths use the OS separator (path.relative on Windows -> backslashes);
// normalize to forward slashes so expectations are portable across platforms.
const norm = (p) => String(p).split(path.sep).join('/');
const repoMapNorm = appIdx.repoMap.map((e) => ({ ...e, path: norm(e.path), importedBy: (e.importedBy || []).map(norm) }));
const apiRoutesNorm = appIdx.apiRoutes.map((r) => ({ ...r, file: norm(r.file) }));
const appEntryPoints = appIdx.entryPoints.map(norm);

try {
  console.log('\n=== DATA (registry sanity) ===');
  eq('KEY_FILES has pom.xml', data.KEY_FILES.includes('pom.xml'), true);
  eq('KEY_FILES has build.gradle.kts', data.KEY_FILES.includes('build.gradle.kts'), true);
  eq('SIGNATURE_PATTERNS_BY_EXT keys', Object.keys(data.SIGNATURE_PATTERNS_BY_EXT), ['.py', '.go', '.rs', '.java', '.rb', '.php', '.cs']);
  eq('REAL_CODE_EXTS has .rs', data.REAL_CODE_EXTS.has('.rs'), true);
  eq('REAL_CODE_EXTS has .vue', data.REAL_CODE_EXTS.has('.vue'), true);
  eq('REAL_CODE_EXTS excludes .zip', data.REAL_CODE_EXTS.has('.zip'), false);
  eq('AST_CAPABLE_EXTS has .tsx', data.AST_CAPABLE_EXTS.has('.tsx'), true);
  eq('MONOREPO_MANIFESTS has pyproject.toml', data.MONOREPO_MANIFESTS.has('pyproject.toml'), true);

  console.log('\n=== SIGNATURES (regex + AST paths) ===');
  eq('js AST path', await parsers.extractSignatures('export const foo = 1;\nexport function bar() {}\nclass Baz {}', '.js'),
    ['foo', 'bar', 'Baz']);
  eq('ts AST extras (interface/type/enum/default-named)', await parsers.extractSignatures(
    'export interface Props {}\nexport type T = string;\nexport default function App() {}\nenum E { A }', '.ts'),
    ['Props', 'T', 'App', 'E']);
  eq('py regex path', await parsers.extractSignatures('def run():\n    pass\nasync def main():\n    pass\nclass C:\n    pass', '.py'),
    ['run', 'main', 'C']);
  eq('go regex path', await parsers.extractSignatures('func main() {\n}\ntype Foo struct {}', '.go'), ['main', 'Foo']);
  eq('rust regex path', await parsers.extractSignatures('pub fn run() {}\nstruct S;\nenum E {}', '.rs'), ['run', 'S', 'E']);
  eq('java regex path', await parsers.extractSignatures('public class Main {\n}', '.java'), ['Main']);
  eq('ruby regex path', await parsers.extractSignatures('def run\nend\nclass Foo\nend', '.rb'), ['run', 'Foo']);
  eq('php regex path', await parsers.extractSignatures('function run() {}\nclass Foo {}', '.php'), ['run', 'Foo']);
  eq('csharp regex path', await parsers.extractSignatures('public class Foo\n{\n}', '.cs'), ['Foo']);
  const manySigs = Array.from({ length: 20 }, (_, i) => `export function fn${i}() {}`).join('\n');
  eq('signature cap at 12', (await parsers.extractSignatures(manySigs, '.js')).length, 12);

  console.log('\n=== IMPORTS ===');
  eq('js imports local-first',
    parsers.extractImports('import x from "../state.js";\nimport y from "react";\nimport z from "./local";\nimport "sideeffect";\nrequire("lodash");', '.js'),
    ['../state.js', './local', 'react', 'sideeffect', 'lodash']);
  eq('py imports', parsers.extractImports('from flask import Flask\nimport os\nimport sys', '.py'), ['flask', 'os', 'sys']);
  eq('non-code ext -> []', parsers.extractImports('import x from "y";', '.md'), []);
  const manyImports = Array.from({ length: 10 }, (_, i) => `import m${i} from "pkg${i}";`).join('\n');
  eq('import cap at 8', parsers.extractImports(manyImports, '.js').length, 8);

  console.log('\n=== ROUTES ===');
  eq('express', parsers.extractRoutes('app.get("/api/x", h);\napp.post("/api/y", h);', '.js'),
    [{ method: 'GET', path: '/api/x' }, { method: 'POST', path: '/api/y' }]);
  eq('flask methods', parsers.extractRoutes('@app.route("/ping", methods=["GET", "POST"])', '.py'),
    [{ method: 'GET', path: '/ping' }, { method: 'POST', path: '/ping' }]);
  eq('fastapi', parsers.extractRoutes('@app.get("/items")', '.py'), [{ method: 'GET', path: '/items' }]);
  eq('django in urls.py', parsers.extractRoutes('urlpatterns = [path("admin/", admin.site.urls)]', '.py', 'app/urls.py'),
    [{ method: 'ROUTE', path: 'admin/' }]);
  eq('django guard outside urls.py', parsers.extractRoutes('path("admin/", x)', '.py', 'app/models.py'), []);
  const manyRoutes = Array.from({ length: 25 }, (_, i) => `app.get("/r${i}", h);`).join('\n');
  eq('route cap at 20', parsers.extractRoutes(manyRoutes, '.js').length, 20);

  console.log('\n=== DETECTION (pure tree/keyfile fns) ===');
  const mixedTree = [
    { type: 'file', path: 'src/main.py' }, { type: 'file', path: 'src/app.py' },
    { type: 'file', path: 'requirements.txt' }, { type: 'file', path: 'archive.zip' },
    { type: 'file', path: 'main.go' }, { type: 'file', path: 'README.md' }, { type: 'dir', path: 'src' },
  ];
  eq('languages mixed', detection.detectLanguages(mixedTree), ['Python (2 files)', 'Go (1 files)', 'Markdown (1 files)']);
  eq('languages junk-only folder', detection.detectLanguages([{ type: 'file', path: 'a.zip' }, { type: 'file', path: 'b.zip' }]), []);
  const sixLangs = ['.py', '.go', '.rs', '.java', '.rb', '.php'].map((ext) => ({ type: 'file', path: `f${ext}` }));
  eq('languages top-5 cap', detection.detectLanguages(sixLangs).length, 5);
  eq('realCode mixed', detection.hasRealCodeFiles(mixedTree), true);
  eq('realCode junk-only', detection.hasRealCodeFiles([{ type: 'file', path: 'a.zip' }]), false);
  eq('frameworks npm+pip', detection.detectFrameworks({
    'package.json': '{"dependencies":{"react":"18","express":"4","vite":"5"},"devDependencies":{"typescript":"5"}}',
    'requirements.txt': 'flask\nnumpy\n',
  }), ['React', 'Express', 'Vite', 'TypeScript', 'Flask', 'NumPy']);
  eq('frameworks spring boot', detection.detectFrameworks({ 'pom.xml': '<artifactId>spring-boot-starter</artifactId>' }),
    ['Java/Maven', 'Spring Boot']);
  eq('frameworks empty keyFiles', detection.detectFrameworks({}), []);
  eq('entry points shallowest first', detection.findEntryPoints(mixedTree), ['src/main.py', 'src/app.py', 'main.go']);
  const monoTree = [
    { type: 'file', path: 'package.json' }, { type: 'file', path: 'apps/web/package.json' },
    { type: 'file', path: 'apps/api/package.json' }, { type: 'file', path: 'apps/api/Cargo.toml' },
    { type: 'file', path: 'src/other.js' },
  ];
  eq('monorepo grouping', detection.detectSubPackages(monoTree), [
    { path: '.', manifests: ['package.json'] },
    { path: 'apps/web', manifests: ['package.json'] },
    { path: 'apps/api', manifests: ['package.json', 'Cargo.toml'] },
  ]);
  eq('not a monorepo', detection.detectSubPackages([{ type: 'file', path: 'package.json' }]), []);

  console.log('\n=== INDEX (indexProject + renderers on fixtures) ===');
  eq('index null for missing path', await indexer.indexProject(path.join(FIXTURE_ROOT, 'nope')), null);
  eq('hasGit', appIdx.hasGit, true);
  eq('hasConfig', appIdx.hasConfig, true);
  eq('hasRealCode', appIdx.hasRealCode, true);
  eq('documentCount counts pdfs only', appIdx.documentCount, 1);
  eq('hasCli', appIdx.hasCli, false);
  eq('hasTests', appIdx.hasTests, false);
  eq('languages', appIdx.languages, ['JavaScript (2 files)', 'JSON (1 files)', 'Python (1 files)']);
  eq('frameworks', appIdx.frameworks, ['Express']);
  eq('entryPoints', appEntryPoints, ['src/server.js']);
  eq('isMonorepo false', appIdx.isMonorepo, false);
  eq('repoMap entry count', repoMapNorm.length, 2);
  eq('repoMap server.js imports', repoMapNorm.find((e) => e.path === 'src/server.js')?.imports, ['./lib/util', 'express']);
  eq('repoMap server.js signatures', repoMapNorm.find((e) => e.path === 'src/server.js')?.signatures, ['start']);
  eq('repoMap util.js used-by reverse', repoMapNorm.find((e) => e.path === 'src/lib/util.js')?.importedBy, ['src/server.js']);
  eq('apiRoutes', apiRoutesNorm, [{ method: 'GET', path: '/health', file: 'src/server.js' }]);
  eq('formatRepoMap has used-by', indexer.formatRepoMap(repoMapNorm).includes('[used by: src/server.js]'), true);
  eq('formatApiRoutes', indexer.formatApiRoutes(apiRoutesNorm), 'GET /health  (src/server.js)');
  eq('formatApiRoutes empty', indexer.formatApiRoutes([]), '');
  eq('keyFiles truncation marker', truncIdx.keyFiles['package.json'].endsWith('... (truncated)'), true);
  eq('truncated package.json fails framework parse -> []', truncIdx.frameworks, []);
  eq('monorepo isMonorepo true', monoIdx.isMonorepo, true);
  eq('monorepo subPackages', monoIdx.subPackages.length, 2);

  console.log('\n=== SYMBOLS & GRAPH (extractSymbols + codebaseGraph) ===');
  eq('symbols AST records', await parsers.extractSymbols('export const foo = 1;\nexport function bar() {}\nclass Baz {}', '.js'), [
    { name: 'foo', kind: 'const', exported: true, line: 1, heritage: [] },
    { name: 'bar', kind: 'function', exported: true, line: 2, heritage: [] },
    { name: 'Baz', kind: 'class', exported: false, line: 3, heritage: [] }]);
  eq('symbols py regex fallback', await parsers.extractSymbols('def run():\n    pass', '.py'),
    [{ name: 'run', kind: null, exported: null, line: 0, heritage: [] }]);
  eq('symbolIndex files', Object.keys(appIdx.symbolIndex.files).sort(), ['src/lib/util.js', 'src/server.js']);
  eq('symbolIndex usedBy greet', appIdx.symbolIndex.usedBy['src/lib/util.js'].greet, ['src/server.js']);
  eq('resolve exact path', norm(graph.resolveTargetFile(appIdx, 'src/server.js')), 'src/server.js');
  eq('resolve basename', norm(graph.resolveTargetFile(appIdx, 'util.js')), 'src/lib/util.js');
  eq('resolve path substring', norm(graph.resolveTargetFile(appIdx, 'lib/util')), 'src/lib/util.js');
  eq('resolve embedded in sentence', norm(graph.resolveTargetFile(appIdx, 'how does src/server.js start?')), 'src/server.js');
  eq('resolve short generic -> null', graph.resolveTargetFile(appIdx, 'app'), null);
  eq('resolve symbol name -> null', graph.resolveTargetFile(appIdx, 'start'), null);
  // Typo tolerance (Matchday-Exchange live session, 2026-08-14): wrong/missing extensions
  // must resolve to the real file; generic 3-char stems must stay null.
  eq('resolve wrong extension', norm(graph.resolveTargetFile(appIdx, 'util.t')), 'src/lib/util.js');
  eq('resolve wrong extension 2', norm(graph.resolveTargetFile(appIdx, 'server.zz')), 'src/server.js');
  eq('resolve wrong extension 3', norm(graph.resolveTargetFile(appIdx, 'server.tx')), 'src/server.js');
  eq('resolve missing extension', norm(graph.resolveTargetFile(appIdx, 'util')), 'src/lib/util.js');
  eq('resolve typo stem still null when absent', graph.resolveTargetFile(appIdx, 'readme'), null);
  eq('slice has start + imports', graph.renderTargetedSlice(appIdx, 'src/server.js').includes('function start @3'), true);
  eq('slice has usedBy', graph.renderTargetedSlice(appIdx, 'src/lib/util.js').includes('greet: src/server.js'), true);
  eq('symbolGraph render', graph.formatSymbolGraph(appIdx).includes('function greet'), true);
  eq('symbolGraph empty idx', graph.formatSymbolGraph({}), '(no symbols indexed)');

  console.log('\n=== SCANS (on-demand IO scans on fixtures) ===');
  const todos = await scans.findTodos(fixtures.app);
  eq('todos found', todos.length, 1);
  eq('todo shape', todos[0] && { ...todos[0], file: norm(todos[0].file) }, { file: 'src/server.js', line: 4, tag: 'TODO', text: 'add auth' });
  eq('node_modules/.hidden TODOs ignored', todos.some((t) => t.file.includes('junk') || t.file.includes('.hidden')), false);
  const biggest = await scans.findBiggestFiles(fixtures.app, 2);
  eq('biggest file', biggest[0] && { ...biggest[0], path: norm(biggest[0].path) }, { path: 'src/big.py', bytes: 5000 });
  eq('biggest cap', biggest.length, 2);
  const recent = await scans.findRecentActivity(fixtures.app, 5);
  const sorted = recent.every((f, i) => i === 0 || recent[i - 1].mtime >= f.mtime);
  eq('recent desc order', sorted, true);
  eq('recent cap', recent.length, 5);
  eq('hasGitRepo true (fixture .git dir)', await scans.hasGitRepo(fixtures.app), true);
  eq('hasGitRepo false (no .git)', await scans.hasGitRepo(fixtures.trunc), false);
  const skippedDirs = appTree.filter((e) => e.type === 'dir').map((e) => norm(e.path));
  eq('tree skips node_modules/.git/.hidden', skippedDirs, ['docs', 'src', 'src/lib']);

  console.log('\n=== CODE-INDEX (Phase 7 chunker + store, no embeddings) ===');
  const chunker = await import(pathToFileURL(base + 'codeIndex/codeIndexChunker.js').href);
  const cStore = await import(pathToFileURL(base + 'codeIndex/codeIndexStore.js').href);
  const jsContent = 'export const foo = 1;\n\nfunction bar() {}\n\nclass Baz {}\n';
  const jsChunks = await chunker.chunkFile(jsContent, '.js', 'src/a.js');
  eq('chunker JS symbol-anchored count', jsChunks.length, 3);
  eq('chunker JS first chunk spans to next symbol', jsChunks[0].start === 1 && jsChunks[0].end === 2 && jsChunks[0].text.includes('foo'), true);
  eq('chunker JS middle chunk spans between symbols', jsChunks[1].start === 3 && jsChunks[1].end === 4 && jsChunks[1].text.includes('bar'), true);
  eq('chunker JS last chunk runs to EOF', jsChunks[2].start === 5 && jsChunks[2].end === 6 && jsChunks[2].text.includes('Baz'), true);
  const pyChunks = await chunker.chunkFile('def run():\n    pass\n\n# done\n', '.py', 'src/b.py');
  eq('chunker py fixed-window single chunk (file under window)', pyChunks.length === 1 && pyChunks[0].start === 1 && pyChunks[0].end === 5, true);
  const big = await chunker.chunkFile('x'.repeat(4500), '.js', 'src/c.js');
  eq('chunker oversized split into overlapping passes', big.length, 5);
  // Phase 16 (2026-08-12): prose chunking for documents — paragraph-run chunks up to the
  // char cap (a short doc is one chunk; a long doc splits into bounded chunks; PDFs use page
  // runs).
  const prose = chunker.chunkProse('First paragraph about pricing.\n\nSecond paragraph about the roadmap.\n\nThird paragraph about the meeting.', 'docs/notes.md');
  eq('chunker prose: short doc is one bounded chunk with all paragraphs', prose.length === 1 && prose[0].text.includes('pricing') && prose[0].text.includes('meeting') && prose[0].text.length <= 2000, true);
  const proseBig = chunker.chunkProse(Array.from({ length: 300 }, (_, i) => `Paragraph ${i} with some content about topic ${i % 3}.`).join('\n\n'), 'docs/big.md');
  eq('chunker prose: long doc splits into bounded chunks', proseBig.length > 1 && proseBig.every((c) => c.text.length <= 2000), true);
  const prosePage = chunker.chunkProse(Array.from({ length: 200 }, (_, i) => `Page ${i + 1} content about topic ${i % 2}.`).join('\n\n'), 'docs/guide.pdf', 'page');
  eq('chunker prose: page mode splits long docs', prosePage.length > 1 && prosePage.every((c) => c.text.length <= 2000), true);
  const idxRoot = path.join(os.tmpdir(), 'console-codeindex-fixtures');
  const idxDir = path.join(idxRoot, 'project');
  await fs.mkdir(idxDir, { recursive: true });
  const storePath = cStore._testHooks.storePath(idxDir);
  await cStore.upsertChunks('ci-fixture', idxDir, 'src/a.js', 1234, [{ id: 'src/a.js:1', start: 1, end: 2, text: 'hello world' }], [[0.5, 0.25, -0.1]]);
  await new Promise((r) => setTimeout(r, 700)); // let the debounced save land
  cStore._testHooks.stores.delete('ci-fixture'); // force a reload from disk
  const reloaded = await cStore.loadStore('ci-fixture', idxDir);
  eq('store round-trips through JSON with plain-array vectors', reloaded.chunks.length === 1 && Array.isArray(reloaded.chunks[0].vector) && reloaded.chunks[0].vector[0] === 0.5, true);
  const hits = await cStore.searchChunks('ci-fixture', idxDir, [0.6, 0.2, 0.0], 5);
  eq('store search returns the matching chunk', hits.length === 1 && hits[0].file === 'src/a.js' && hits[0].start === 1, true);
  // Regression (2026-08-11, live): the embedding extractor returns typed arrays, which
  // JSON.stringify serializes as {"0":...} objects — a store written that way must load as a
  // FRESH store (files wiped) so indexNeedsFullBuild triggers a rebuild, never a permanent
  // zero-chunk index hiding behind a populated mtime manifest.
  await fs.writeFile(storePath, JSON.stringify({
    version: 1, files: { 'src/a.js': 1234 },
    chunks: [{ id: 'src/a.js:1', file: 'src/a.js', start: 1, end: 2, text: 'x', vector: { '0': 0.1 } }],
  }), 'utf-8');
  const corrupt = await cStore.loadStore('ci-corrupt', idxDir);
  eq('store with object-vector chunks loads fresh (rebuild path)', corrupt.chunks.length === 0 && Object.keys(corrupt.files).length === 0, true);
  await fs.rm(idxRoot, { recursive: true, force: true });
} finally {
  await fs.rm(FIXTURE_ROOT, { recursive: true, force: true });
  console.log('\nFixtures cleaned up.');
}

if (PROBE) {
  console.log('\nProbe complete — bake the desired outputs into the expectations.');
  process.exit(0);
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
