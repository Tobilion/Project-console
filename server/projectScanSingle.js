import fs from 'fs/promises';
import path from 'path';
import { indexProject } from './codebaseIndexer.js';
import { deriveScriptEntriesForProject, mergeAutoEntries } from './scriptEntries.js';
import { sanitizeChatReplies, readProjectContextDocs, commandEntriesFromDocs, isRecognizableByCodeAlone, buildFallbackConfig, detectWorkspaceType } from './projectScanHelpers.js';

/**
 * Reads a single project folder's console.config.json (validated) + context docs, merges
 * auto-derived npm script entries, indexes the codebase, and applies the code-only
 * recognition fallback. Returns the project object or null if nothing recognized it.
 * (Phase 14 split of projectScanner.js, 2026-08-05 — body moved verbatim.)
 */
export async function scanSingleProject(folderName, projectPath) {
  let config = null;
  try {
    const configPath = path.join(projectPath, 'console.config.json');
    const configStats = await fs.stat(configPath);
    if (configStats.isFile()) {
      const configData = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(configData);
      sanitizeChatReplies(config);
    }
  } catch (err) {}

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
  if (!config && contextFiles.length === 0 && isRecognizableByCodeAlone(codebaseIndex)) {
    config = buildFallbackConfig(folderName, codebaseIndex);
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
