import fs from 'fs/promises';
import path from 'path';

/**
 * Effective command-execution directory for a project (2026-08-11, requested directly — a
 * friend's Angular project (SAM SYSTEM) sat in a wrapper folder: Projects\SAM SYSTEM\sam_system
 * with the real package.json/README inside sam_system, so "run the site" fell back to the
 * static-site branch, the README run-command parser never saw `ng serve`, and npm scripts
 * pointed at a package.json that wasn't there).
 *
 * The rule is deliberately narrow: when the project ROOT has no runnable package.json scripts
 * (and isn't a workspace root), and exactly ONE sub-package carries a package.json with scripts,
 * that sub-package is the command directory. Normal projects (root scripts present) and true
 * monorepos (multiple sub-packages) are untouched — they return null and everyone uses
 * project.path as today.
 *
 * Consumers: builtinFileNpm.js (scripts + execute cwd), connectionExecute.js (typed commands),
 * connectionToolCall.js (chip/executeCommand tool cwd), toolProcess.js (runTests).
 */

const cache = new WeakMap();

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
  if (Object.keys(rootScripts).length > 0) return null;
  // Workspace roots manage sub-packages; their commands (npm install, npm -ws run) target the root.
  if (rootPkg && Array.isArray(rootPkg.workspaces)) return null;
  // Direct-subdirectory probe (one level, bounded): exactly one subdirectory carries a
  // package.json with scripts. The codebase index can't answer this — detectSubPackages
  // only reports >=2 manifest dirs (monorepos), so a single nested package is invisible
  // there. Reading the subdirs' package.json is a handful of small files, once per project,
  // and only for roots that have no scripts themselves.
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
  return { dir: candidates[0].dir.replace(/\\/g, '/'), scripts: candidates[0].scripts };
}
