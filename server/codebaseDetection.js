/**
 * Pure detection functions for codebaseIndexer (Phase 8 split, 2026-08-04 — extracted from
 * codebaseIndexer.js, logic unchanged): language/framework/entry-point/monorepo detection,
 * all operating on an in-memory tree or keyFiles map — no IO, no caches.
 */
import path from 'path';
import { pathParts } from './codebaseParsers.js';
import {
  REAL_CODE_EXTS, NPM_FRAMEWORK_MAP, PY_FRAMEWORK_MAP, ENTRY_NAMES, MONOREPO_MANIFESTS,
} from './codebaseData.js';

export function detectLanguages(tree) {
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
    '.vue': 'Vue', '.svelte': 'Svelte', '.dart': 'Dart', '.css': 'CSS', '.scss': 'SCSS',
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

export function hasRealCodeFiles(tree) {
  return tree.some((e) => e.type === 'file' && REAL_CODE_EXTS.has(path.extname(e.path).toLowerCase()));
}

export function detectFrameworks(keyFiles) {
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
  if (keyFiles['angular.json'] || keyFiles['ng.json']) found.add('Angular');
  if (keyFiles['pubspec.yaml']) found.add('Flutter/Dart');
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

export function findEntryPoints(tree) {
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

/** Groups manifest files (package.json, pyproject.toml, Cargo.toml, etc.) by containing
 *  directory. Returns [] when there's zero or one such location (i.e. not a monorepo) —
 *  callers should treat a non-empty result as "this project has N independently-manifested
 *  sub-packages", sorted shallowest-first (root, if present, always sorts first). */
export function detectSubPackages(tree) {
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
