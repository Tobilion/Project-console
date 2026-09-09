import { indexProject } from './codebaseIndexer.js';
import { deriveScriptEntriesForProject, mergeAutoEntries } from './scriptEntries.js';
import { readProjectConfig, readProjectContextDocs, commandEntriesFromDocs, isRecognizableByCodeAlone, buildFallbackConfig, detectWorkspaceType } from './projectScanHelpers.js';

/**
 * Reads a single project folder's console.config.json (validated) + context docs, merges
 * auto-derived npm script entries, indexes the codebase, and applies the code-only
 * recognition fallback. Returns the project object or null if nothing recognized it.
 * (Phase 14 split of projectScanner.js, 2026-08-05 — body moved verbatim.)
 * `opts.includeAll` (Phase T, 2026-08-14 — the scanAllFolders profile setting): include the
 * folder even with no recognition signals at all, with a synthesized fallback config so the
 * project object stays shape-complete for downstream consumers.
 */
export async function scanSingleProject(folderName, projectPath, opts = {}) {
  // B.2 (2026-09-09): shared readProjectConfig — was a verbatim copy of the container's
  // sequence below, including its own silent-catch twin (both already logged correctly;
  // the dedup just means the next fix lands in one place).
  let config = await readProjectConfig(projectPath, 'projectScanSingle');

  const docs = await readProjectContextDocs(projectPath);
  const contextFiles = docs?.contextFiles || [];
  const parsedKnowledge = docs?.parsedKnowledge || { stack: '', commands: '', gotchas: '', architecture: '' };

  if (!config && contextFiles.length > 0) {
    config = { projectName: folderName, entries: [] };
    config.entries.push(...commandEntriesFromDocs(folderName, parsedKnowledge));
  }

  const autoEntries = await deriveScriptEntriesForProject(projectPath);
  if (autoEntries.length) {
    if (!config) config = { projectName: folderName, entries: [] };
    mergeAutoEntries(config, autoEntries);
  }

  // Same isRecognizableByCodeAlone() fallback as discoverProjects() above — this path is used
  // when a specific folder is picked directly (e.g. via the folder picker or --dir), so it needs
  // the same "don't go invisible just because there's no doc/config/package.json" treatment.
  const codebaseIndex = await indexProject(projectPath);
  if (!config && contextFiles.length === 0 && (isRecognizableByCodeAlone(codebaseIndex) || opts.includeAll)) {
    config = buildFallbackConfig(folderName, codebaseIndex, opts.includeAll);
  }

  if (config || contextFiles.length > 0) {
    return {
      id: folderName.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      folderName,
      name: config?.projectName || folderName,
      path: projectPath,
      config: config || { projectName: folderName, entries: [] },
      workspaceType: detectWorkspaceType(config, codebaseIndex),
      contextFiles,
      parsedKnowledge,
      codebaseIndex
    };
  }
  return null;
}
