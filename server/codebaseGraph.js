// Codebase symbol graph + targeted slice rendering (Phase 1, Part 1.1 — AST-aware codebase
// graph & symbol navigation). Pure logic only: no IO, no caches. The orchestrator
// (codebaseIndexer.js) feeds it per-file content for the reference scan; aiQueryContext /
// toolProjectInfo consume the rendered slices. Reference edges are file-level heuristics:
// file F references symbol X of file G when F imports G (resolved relative import) and X's
// name appears in F's content — NOT a full dataflow analysis, but enough for change-impact
// questions ("who uses start()?") and dead-export detection.
import { MAX_SIGNATURES_PER_FILE } from './codebaseData.js';
import { resolveLocalImport, pathParts } from './codebaseParsers.js';

/** Cap on how many referring files are recorded per symbol (keeps usedBy bounded). */
export const MAX_REFS_PER_SYMBOL = 8;
/** Cap on the union of importee symbol names scanned per file (single-regex cost guard). */
export const MAX_REFERENCE_NAMES_PER_FILE = 40;
/** Default character budget for a targeted symbol slice. */
export const TARGETED_SLICE_MAX_CHARS = 1500;
/** Cap on caller/callee files listed in a slice. */
export const TARGETED_SLICE_FILES = 5;

function normPath(p) {
  return String(p).split(/[\\/]/).join('/');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the symbol index over repo-map entries. `contents` is a Map of relPath -> source
 * text for the files actually parsed in this pass (truncated to MAX_FILE_READ_BYTES by the
 * caller, same as signature extraction). Returns:
 *   { files: { relPath: [symbolRecords] }, usedBy: { relPath: { symbolName: [relPath...] } } }
 */
export function computeSymbolReferences(entries, contents) {
  // Plain `{}` maps inherit Object.prototype — a real exported symbol/file name that collides
  // with an inherited key (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, ...) makes
  // `byOwner[name]` resolve to that inherited function instead of undefined, so `??= []` never
  // fires and the later `refs.includes(...)` throws "refs.includes is not a function" — this
  // silently aborted discoverProjects() for the ENTIRE scan directory (confirmed live
  // 2026-08-10: one project among many exporting something named `constructor` was enough to
  // zero out every project in the scan, with no error surfaced in the UI). `Object.create(null)`
  // has no prototype chain, so any symbol/file name is a safe plain key.
  const files = Object.create(null);
  const usedBy = Object.create(null);
  const byPath = new Map();
  for (const entry of entries) {
    byPath.set(normPath(entry.path), entry);
    if (entry.symbols?.length) files[normPath(entry.path)] = entry.symbols;
  }
  const knownPaths = new Set(byPath.keys());

  for (const entry of entries) {
    const content = contents?.get(normPath(entry.path));
    if (!content) continue;

    // Symbols exported by the files this entry directly imports (its callees).
    const nameOwner = new Map();
    for (const spec of entry.imports || []) {
      const resolved = resolveLocalImport(entry.path, spec, knownPaths);
      if (!resolved) continue;
      for (const sym of byPath.get(normPath(resolved))?.symbols || []) {
        if (sym.name.length < 2) continue; // single-char identifiers are noise to word-boundary scans
        if (!nameOwner.has(sym.name)) nameOwner.set(sym.name, resolved);
      }
      if (nameOwner.size >= MAX_REFERENCE_NAMES_PER_FILE) break;
    }
    if (nameOwner.size === 0) continue;

    const re = new RegExp(`\\b(${[...nameOwner.keys()].map(escapeRegExp).join('|')})\\b`, 'g');
    const found = new Set();
    let m;
    while ((m = re.exec(content))) found.add(m[1]);

    for (const name of found) {
      const owner = nameOwner.get(name);
      const byOwner = (usedBy[normPath(owner)] ??= Object.create(null));
      const refs = (byOwner[name] ??= []);
      if (!refs.includes(normPath(entry.path)) && refs.length < MAX_REFS_PER_SYMBOL) {
        refs.push(normPath(entry.path));
      }
    }
  }
  return { files, usedBy };
}

/**
 * Resolves a user-query filename mention to a repo-map path, or null. Exact path first, then
 * basename ("server.js"), then a lenient path-substring match for segment-ish mentions
 * ("src/lib/util"). Requires a dot-free query to be at least 3 chars so generic words like
 * "app" don't over-match. Sentence queries ("how does src/server.js start up?") are handled
 * by pulling out the path-like tokens (containing '.' or '/') and trying them longest-first —
 * whole-query matching cannot see a path embedded in a question.
 */
export function resolveTargetFile(idx, query) {
  const repoMap = idx?.repoMap || [];
  if (!repoMap.length || !query) return null;
  const q = String(query).trim().toLowerCase();
  if (q.length < 3) return null;

  const tryResolve = (q) => {
    let hit = repoMap.find((e) => normPath(e.path).toLowerCase() === q);
    if (hit) return hit.path;

    const qBase = pathParts(q).at(-1);
    if (qBase && !qBase.includes(' ')) {
      hit = repoMap.find((e) => pathParts(e.path).at(-1).toLowerCase() === qBase);
      if (hit) return hit.path;
    }

    if (!q.includes(' ') && !q.includes('.')) {
      hit = repoMap.find((e) => normPath(e.path).toLowerCase().includes(q));
      if (hit) return hit.path;
    }
    return null;
  };

  if (q.includes(' ')) {
    const tokens = (q.match(/[\w./-]+/g) || [])
      .filter((t) => t.includes('.') || t.includes('/'))
      .sort((a, b) => b.length - a.length);
    for (const t of tokens) {
      const hit = tryResolve(t);
      if (hit) return hit;
    }
    return null;
  }
  return tryResolve(q);
}

/**
 * Renders a compact, model-friendly slice of one file: its exported symbols (name, kind,
 * line, exported flag) plus, when the symbol index is available, who references them and
 * what the file itself imports. This is the input-relevant context for questions about a
 * specific file ("how does src/server.js start up?", "what uses greet()?").
 */
export function renderTargetedSlice(idx, relPath, maxChars = TARGETED_SLICE_MAX_CHARS) {
  const repoMap = idx?.repoMap || [];
  const entry = repoMap.find((e) => normPath(e.path) === normPath(relPath));
  if (!entry) return null;

  const lines = [`## File: ${entry.path}`];
  const symbols = entry.symbols || [];
  if (symbols.length) {
    lines.push(`### Exported symbols (${symbols.length})`);
    for (const s of symbols.slice(0, MAX_SIGNATURES_PER_FILE)) {
      const exp = s.exported === false ? ' (not exported)' : '';
      const at = s.line ? ` @${s.line}` : '';
      lines.push(`- ${s.kind || 'symbol'} ${s.name}${exp}${at}`);
    }
  } else {
    lines.push('(no exported symbols found)');
  }

  const refs = idx?.symbolIndex?.usedBy?.[normPath(relPath)];
  if (refs && Object.keys(refs).length) {
    lines.push(`### Referenced by`);
    let count = 0;
    for (const [name, files] of Object.entries(refs)) {
      if (count >= TARGETED_SLICE_FILES) break;
      lines.push(`- ${name}: ${files.slice(0, TARGETED_SLICE_FILES).join(', ')}`);
      count++;
    }
  }

  const imports = entry.imports || [];
  if (imports.length) {
    lines.push(`### Imports (${imports.length})`);
    lines.push('- ' + imports.slice(0, 8).join(', '));
  }

  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n…' : out;
}

/**
 * Renders the per-file symbol summary for getProjectInfo: file -> [exported names]. Used by
 * the project-info tool so the model can see structure without opening each file. Budget is
 * small by design — it rides along with the rest of getProjectInfo's payload.
 */
export function formatSymbolGraph(idx, maxChars = 1200) {
  const files = idx?.symbolIndex?.files || {};
  const entries = Object.entries(files);
  if (!entries.length) return '(no symbols indexed)';

  const lines = [];
  for (const [path, syms] of entries) {
    const names = syms.slice(0, 12).map((s) => (s.kind ? `${s.kind} ${s.name}` : s.name));
    lines.push(`- ${path}: ${names.join(', ')}`);
  }
  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n…' : out;
}
