/**
 * Pure parse functions for codebaseIndexer (Phase 8 split, 2026-08-04 — extracted from
 * codebaseIndexer.js, logic unchanged): signature extraction (regex + the lazy `typescript`
 * compiler-API AST path), import specifier extraction, API route extraction, and the
 * reverse-import index. No IO, no caches — the one piece of module state is the cached
 * dynamic-import promise for the TypeScript module (getTsModule), which stays here.
 */
import path from 'path';
import {
  AST_CAPABLE_EXTS, MAX_SIGNATURES_PER_FILE, SIGNATURE_PATTERNS_BY_EXT, JS_SIGNATURE_PATTERNS,
  JS_IMPORT_PATTERNS, PY_IMPORT_PATTERNS, CODE_EXTS, MAX_IMPORTS_PER_FILE,
  MAX_ROUTES_PER_FILE, EXPRESS_ROUTE_RE, FLASK_ROUTE_RE, FASTAPI_ROUTE_RE, DJANGO_PATH_RE,
} from './codebaseData.js';

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

export async function extractSignatures(content, ext) {
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

export function extractImports(content, ext) {
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

export function extractRoutes(content, ext, relPath) {
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
export function resolveLocalImport(fromRelPath, spec, knownPaths) {
  if (!spec.startsWith('.')) return null;
  const fromDir = path.dirname(fromRelPath);
  const raw = path.normalize(path.join(fromDir, spec)).split(path.sep).join('/');
  const candidates = [
    raw, `${raw}.js`, `${raw}.ts`, `${raw}.jsx`, `${raw}.tsx`, `${raw}.mjs`, `${raw}.cjs`, `${raw}.py`,
    `${raw}/index.js`, `${raw}/index.ts`, `${raw}/index.jsx`, `${raw}/index.tsx`,
  ];
  return candidates.find((c) => knownPaths.has(c)) || null;
}

export function buildReverseImportIndex(entries) {
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

/** Splits a relative path into parts on either separator — shared by the tree walk,
 *  buildRepoMap's shallow-first sort, entry-point/detection code, and indexProject. */
export function pathParts(relPath) {
  return relPath.split(/[\\/]/);
}
