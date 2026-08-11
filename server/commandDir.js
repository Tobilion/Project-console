import fs from 'fs/promises';
import path from 'path';

/**
 * Effective command-execution directory for a project (2026-08-11, requested directly — a
 * friend's Angular project (SAM SYSTEM) sat in a wrapper folder: Projects\SAM SYSTEM\sam_system
 * with the real package.json/README inside sam_system, so "run the site" fell back to the
 * static-site branch, the README run-command parser never saw `ng serve`, and npm scripts
 * pointed at a package.json that wasn't there).
 *
 * The rule is deliberately narrow: when the project ROOT has no app-launching package.json
 * script (start/serve/dev/run — lint/format-only scripts don't count) and isn't a workspace
 * root, and exactly ONE sub-package carries a package.json with scripts (requiring a launcher
 * script when the root has any scripts of its own), that sub-package is the command directory.
 * Normal projects (root launcher present) and true monorepos (multiple sub-packages) are
 * untouched — they return null and everyone uses project.path as today.
 *
 * Consumers: builtinFileNpm.js (scripts + execute cwd), connectionExecute.js (typed commands),
 * connectionToolCall.js (chip/executeCommand tool cwd), toolProcess.js (runTests).
 */

const cache = new WeakMap();

// Script names that actually launch the app. Exact-key match on purpose (requested
// 2026-08-11, task 0c): colon-scoped variants (dev:server) are deliberately NOT treated as
// launchers — the rule must stay narrow so a root with odd script names is never redirected.
const LAUNCHER_KEYS = new Set(['start', 'serve', 'dev', 'run']);

async function getCommandInfo(project) {
  if (!project || !project.path) return null;
  if (cache.has(project)) return cache.get(project);
  const p = computeCommandInfo(project);
  cache.set(project, p);
  return p;
}

/** Relative (to project.path) command directory, or null when the root is the command dir. */
export async function getCommandDir(project) {
  const info = await getCommandInfo(project);
  return info ? info.dir : null;
}

/** package.json scripts for the effective command dir, or null when the root is the command dir. */
export async function getCommandDirScripts(project) {
  const info = await getCommandInfo(project);
  return info ? info.scripts : null;
}

async function computeCommandInfo(project) {
  const idx = project.codebaseIndex || {};
  const keyFiles = idx.keyFiles || {};
  let rootPkg = null;
  if (keyFiles['package.json']) {
    try {
      rootPkg = JSON.parse(String(keyFiles['package.json']).replace(/\n\.\.\. \(truncated\)$/, ''));
    } catch {}
  }
  const rootScripts = rootPkg?.scripts || {};
  const rootScriptNames = Object.keys(rootScripts);
  // Workspace roots manage sub-packages; their commands (npm install, npm -ws run) target the root.
  if (rootPkg && Array.isArray(rootPkg.workspaces)) return null;
  // A root that can launch the app itself is its own command dir — never redirect it.
  const rootHasLauncher = rootScriptNames.some((n) => LAUNCHER_KEYS.has(n));
  if (rootHasLauncher) return null;
  // Root scripts that are clearly NOT app-launch scripts (lint/format/test-adjacent names) are
  // not a disqualifier by themselves — the wrapper rule below still applies, and the single
  // sub-package then has to carry a real launcher script to win. Requested 2026-08-11 (task
  // 0c, confirmed live): the SAM SYSTEM root package.json only held placeholder/lint scripts,
  // so detectSubPackages reported it as a second sub-package ("Monorepo with 2 sub-packages
  // (., sam_system)"), the exactly-one-subdirectory rule never fired, and the app was missed.
  const rootHasNonLauncherScripts = rootScriptNames.length > 0;
  // Direct-subdirectory probe (one level, bounded): exactly one subdirectory carries a
  // package.json with scripts. The codebase index can't answer this — detectSubPackages
  // only reports >=2 manifest dirs (monorepos), so a single nested package is invisible
  // there. Reading the subdirs' package.json is a handful of small files, once per project,
  // and only for roots without a launcher of their own.
  const candidates = [];
  let entries;
  try {
    entries = await fs.readdir(project.path, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(project.path, e.name, 'package.json'), 'utf-8'));
      const scripts = pkg.scripts || {};
      if (Object.keys(scripts).length > 0) candidates.push({ dir: e.name, scripts });
    } catch {}
  }
  if (candidates.length !== 1) return null;
  // When the root has its own (non-launcher) scripts, the one candidate must actually launch
  // the app — a build/test-only sub-package is not an app directory.
  if (rootHasNonLauncherScripts && !Object.keys(candidates[0].scripts).some((n) => LAUNCHER_KEYS.has(n))) {
    return null;
  }
  return { dir: candidates[0].dir.replace(/\\/g, '/'), scripts: candidates[0].scripts };
}
