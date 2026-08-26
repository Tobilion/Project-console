import fs from 'fs/promises';
import path from 'path';
import { indexProject } from './codebaseIndexer.js';
import { deriveScriptEntriesForProject, mergeAutoEntries } from './scriptEntries.js';
import { sanitizeChatReplies, isContextFilename, readProjectContextDocs, commandEntriesFromDocs, isRecognizableByCodeAlone, buildFallbackConfig, detectWorkspaceType } from './projectScanHelpers.js';
import { getCommandDir } from './commandDir.js';
import { scanSingleProject } from './projectScanSingle.js';
import { MONOREPO_MANIFESTS } from './codebaseData.js';
import { log } from './logger.js';

/**
 * Scans baseDir for subdirectories containing console.config.json or CLAUDE.md/README.md.
 * (Phase 14 split of projectScanner.js, 2026-08-05 — body moved verbatim.)
 * `opts.includeAll` (Phase T, 2026-08-14 — the scanAllFolders profile setting): include EVERY
 * immediate subfolder as a project, even folders with no code/git/config/docs, and make the
 * single-root escape also resolve a signal-free root to itself when it has no subfolders to
 * iterate (a junk folder pasted as the scan target must become one project, not zero).
 */
export async function discoverProjects(baseDir, opts = {}) {
  if (!baseDir || typeof baseDir !== 'string') return [];

  try {
    const stats = await fs.stat(baseDir);
    if (!stats.isDirectory()) return [];

    const entries = await fs.readdir(baseDir, { withFileTypes: true });

    // Confirmed live 2026-07-30 (reported directly — scanning C:\Users\tobil\Desktop\tobi-portfolio
    // "listed its content"): discoverProjects() always treated baseDir as a *container* of
    // project subfolders, scanning each immediate child as a candidate project. If baseDir is
    // actually a single project's own root (pasted directly instead of a parent "Projects" folder
    // — an easy mistake, and the only option for anything outside the default scan directory),
    // every one of ITS OWN subfolders (src/, components/, public/, etc.) got evaluated as if each
    // were a separate top-level project — and since the code-only recognition fallback added
    // earlier this session recognizes any folder with real source files, most of them passed,
    // flooding the project list with the scanned project's own internal folder structure instead
    // of the project itself. Detected here via the same kind of root-level signal used everywhere
    // else in this file (console.config.json / CLAUDE.md-README-etc. / package.json at baseDir's
    // OWN root) — deliberately does not also check for a bare `.git` directory, since someone
    // could plausibly keep an entire `Projects` container under one git repo without every
    // sub-project being a separate repo, and that shouldn't collapse the whole container into one
    // fake "project". A plain container folder holding many separate projects essentially never
    // has its own package.json/README/config at its own root, so this is safe for the normal case
    // (the default `C:\Users\tobil\Desktop\Projects` scan directory has none of these).
    // Phase 3 (2026-08-11): a root-level .pdf file is the same class of signal — a PDF-only
    // folder pasted as the scan target must resolve to itself (the PDF toolkit's project), not
    // to zero projects via the empty container path. Same accepted edge case as root package.json.
    const rootNames = new Set(entries.map((e) => e.name.toLowerCase()));
    const hasRootPdf = entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'));
    // A root-level manifest/config file (go.mod, Cargo.toml, pyproject.toml, pubspec.yaml,
    // requirements.txt, ...) is the same class of single-project signal as package.json — a
    // container of many projects essentially never carries its own. Without these, a Go/Rust/
    // Python/Flutter project pasted directly as the scan target resolved to zero projects (its
    // code-only fallback only ran for container *children*), or worse, to one of its own
    // internal folders (a Cargo project resolved to `src`). Confirmed live 2026-08-24 via
    // temp-fixture scans of go.mod+main.go / Cargo.toml+src / pyproject.toml+app.py roots.
    // `.git` stays deliberately excluded — a whole Projects container can live under one git
    // repo, and collapsing it to one "project" would be wrong (the pre-existing rationale).
    const hasRootManifest = [...MONOREPO_MANIFESTS].some((m) => rootNames.has(m.toLowerCase()));
    const looksLikeSingleProjectRoot =
      rootNames.has('console.config.json') ||
      [...rootNames].some(isContextFilename) ||
      rootNames.has('package.json') ||
      hasRootManifest ||
      hasRootPdf ||
      // Phase T: with "include every folder" on, a signal-free root holding no subfolders is
      // itself the project (a junk folder pasted as the scan target must resolve to one
      // project, not zero via the empty container path).
      (opts.includeAll && !entries.some((e) => e.isDirectory()));
    if (looksLikeSingleProjectRoot) {
      const folderName = path.basename(baseDir);
      const single = await scanSingleProject(folderName, baseDir, opts);
      return single ? [single] : [];
    }

    // Scans one candidate subfolder, returning the project object or null. Each project's
    // scan is independently guarded: this used to be unguarded, so a single throw anywhere
    // in one project's indexing (e.g. the 2026-08-10 prototype-pollution bug in
    // computeSymbolReferences, or any future per-file parse error) unwound all the way to the
    // outer try/catch and silently zeroed out the ENTIRE scan directory — a folder full of
    // real, working projects would report "no projects found" because of one bad file in one
    // of them, with nothing surfaced in the UI. One bad project should be skipped, not fatal
    // to everyone else's.
    async function scanOne(entry) {
      const projectPath = path.join(baseDir, entry.name);
      try {
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

        // Combine inferred config
        if (!config && contextFiles.length > 0) {
           config = { projectName: entry.name, entries: [] };
           config.entries.push(...commandEntriesFromDocs(entry.name, parsedKnowledge));
        }

        // Fill in any standard npm scripts (dev/build/lint/test/...) the config doesn't
        // already cover, so the dispatcher's commands can't drift from what package.json
        // actually runs. Hand-authored console.config.json entries always take priority —
        // this only adds entries whose exact action isn't already present. A project with
        // only a package.json and no docs/config still gets discovered because of this.
        const autoEntries = await deriveScriptEntriesForProject(projectPath);
        if (autoEntries.length) {
          if (!config) config = { projectName: entry.name, entries: [] };
          mergeAutoEntries(config, autoEntries);
        }

        // Always index now (rather than only when config/contextFiles already justified
        // inclusion) — isRecognizableByCodeAlone() below needs the codebase index itself to
        // decide whether a doc-less, config-less, package.json-less folder should still be
        // recognized as a project.
        const codebaseIndex = await indexProject(projectPath);

        // Wrapper projects (scriptless root + exactly one script-carrying sub-package — the
        // SAM SYSTEM case: the real package.json/README sat in Projects\SAM SYSTEM\sam_system,
        // so the root scan saw no docs and "run the site" fell back to the static-site branch).
        // Adopt the sub-package's docs as this project's context docs so README run-command
        // discovery, overview Q&A, and the doc-derived command entries work as if the
        // sub-package were the root. Same wrapper rule commandDir.js uses for the execution
        // cwd, so scan-time docs and run-time commands can't drift. Root docs, when present,
        // always win — never merged over.
        if (contextFiles.length === 0) {
          const wrapperDir = await getCommandDir({ path: projectPath, codebaseIndex });
          if (wrapperDir) {
            const subDocs = await readProjectContextDocs(path.join(projectPath, wrapperDir));
            if (subDocs) {
              contextFiles.push(...subDocs.contextFiles);
              for (const k of Object.keys(subDocs.parsedKnowledge)) {
                if (subDocs.parsedKnowledge[k]) {
                  parsedKnowledge[k] = parsedKnowledge[k]
                    ? `${parsedKnowledge[k]}${parsedKnowledge[k].endsWith('\n') ? '' : '\n'}${subDocs.parsedKnowledge[k]}`
                    : subDocs.parsedKnowledge[k];
                }
              }
              if (!config) config = { projectName: entry.name, entries: [] };
              config.entries.push(...commandEntriesFromDocs(entry.name, parsedKnowledge));
            }
          }
        }

        if (!config && contextFiles.length === 0 && (isRecognizableByCodeAlone(codebaseIndex) || opts.includeAll)) {
          config = buildFallbackConfig(entry.name, codebaseIndex, opts.includeAll);
        }

        if (config || contextFiles.length > 0) {
          return {
            id: entry.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            folderName: entry.name,
            name: config?.projectName || entry.name,
            path: projectPath,
            config: config || { projectName: entry.name, entries: [] },
            workspaceType: detectWorkspaceType(config, codebaseIndex),
            contextFiles: contextFiles,
            parsedKnowledge,
            codebaseIndex
          };
        }
        return null;
      } catch (err) {
        log.error(`Skipping project "${entry.name}" — failed to scan it:`, err.message);
        return null;
      }
    }

    // Phase 6 (2026-08-17): per-project scans were serial — one project's slow index (TS
    // symbol extraction, doc parsing) delayed every later project. Each project's scan is
    // read-only (config/doc reads + codebase indexing with mtime caches), so a small worker
    // pool overlaps them. Results land by readdir index so the returned order is unchanged.
    // Deliberately bounded: an unbounded Promise.all over a 100-folder container would
    // hammer the disk and the TS compiler at once.
    const results = new Array(entries.length);
    const POOL_SIZE = 6;
    let nextIdx = 0;
    const worker = async () => {
      while (nextIdx < entries.length) {
        const idx = nextIdx++;
        const entry = entries[idx];
        if (!entry.isDirectory()) continue;
        results[idx] = await scanOne(entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL_SIZE, entries.length) }, () => worker()));

    const projects = [];
    for (const r of results) {
      if (r) projects.push(r);
    }
    return projects;
  } catch (err) {
    log.error(`Failed to scan directory at "${baseDir}":`, err.message);
    return [];
  }
}