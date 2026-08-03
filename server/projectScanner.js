import fs from 'fs/promises';
import path from 'path';
import { indexProject } from './codebaseIndexer.js';
import { deriveScriptEntriesForProject, mergeAutoEntries } from './scriptEntries.js';

/**
 * Whether a project's own codebaseIndex alone is enough to recognize the folder as a project,
 * with no docs/config/package.json present at all. Confirmed-real gap (2026-07-30, raised
 * directly): a folder full of real code but none of CLAUDE.md/README.md/console.config.json/
 * package.json was completely invisible to discovery no matter how much was in it — a real
 * problem the moment this app is pointed at someone else's folder, or at a non-npm project
 * (Go/Rust/Java/Ruby/PHP/a bare Python script) that was never given a doc file. Recognized here
 * if the folder has actual source code (checked via `hasRealCode`, NOT `languages.length` — see
 * the fix below), OR a config file codebaseIndexer.js already knows about (Cargo.toml, go.mod,
 * requirements.txt, etc. — hasConfig only covers package.json/pyproject.toml/Cargo.toml, so also
 * check keyFiles directly), OR it's a real git repository (a strong signal of "this is a real
 * project", not junk, even if all it currently holds is non-code files).
 *
 * Fixed 2026-07-30 (reported directly — folders containing only .zip archives, or other non-code
 * junk, were showing up as recognized "projects"). This used to check `codebaseIndex.languages.
 * length > 0`, but `detectLanguages()` had its own bug (now also fixed) that bucketed literally
 * any file extension — including `.zip` — into `idx.languages` if it wasn't in the known langMap,
 * so a folder with three zip files alone was enough to pass. Now checks `codebaseIndex.hasRealCode`
 * instead, which is computed against a real programming-language extension allowlist
 * (`REAL_CODE_EXTS` in codebaseIndexer.js) and never counts arbitrary/unmapped extensions.
 */
function isRecognizableByCodeAlone(codebaseIndex) {
  if (!codebaseIndex || codebaseIndex.totalFiles === 0) return false;
  const hasAnyKeyFile = codebaseIndex.keyFiles && Object.keys(codebaseIndex.keyFiles).length > 0;
  return codebaseIndex.hasRealCode || hasAnyKeyFile || codebaseIndex.hasGit;
}

// `chatReplies` is an OPTIONAL console.config.json top-level key (Phase 4.5 chit-chat
// intelligence): pools of reply strings per chit-chat intent ("greeting"/"status"/"gratitude"/
// "farewell"/"ack") that REPLACE that intent's built-in canned replies for this project. It's
// validated here at scan time — a malformed `chatReplies` must be ignored (with a warning),
// never a crash, exactly like a truncated package.json parse.
const CHAT_REPLIES_INTENTS = new Set(['greeting', 'status', 'gratitude', 'farewell', 'ack']);
function sanitizeChatReplies(config) {
  if (!config || typeof config !== 'object') return;
  const raw = config.chatReplies;
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn('[projectScanner] Ignoring invalid console.config.json "chatReplies" — expected an object keyed by intent.');
    delete config.chatReplies;
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!CHAT_REPLIES_INTENTS.has(key)) {
      console.warn(`[projectScanner] Ignoring unknown chatReplies key "${key}" (allowed: ${[...CHAT_REPLIES_INTENTS].join(', ')}).`);
      delete raw[key];
      continue;
    }
    const pool = raw[key];
    if (!Array.isArray(pool) || pool.length === 0 || pool.some((s) => typeof s !== 'string' || !s.trim())) {
      console.warn(`[projectScanner] Ignoring invalid chatReplies.${key} — must be a non-empty array of non-empty strings.`);
      delete raw[key];
    }
  }
  if (Object.keys(raw).length === 0) delete config.chatReplies;
}

/** Builds a minimal config for a project recognized only via isRecognizableByCodeAlone() above —
 *  otherwise it would be included with an empty `entries: []` and no way to explain itself when
 *  asked "what is this project" in trigger mode. */
function buildFallbackConfig(name, codebaseIndex) {
  const parts = [];
  if (codebaseIndex.languages.length) parts.push(`Languages: ${codebaseIndex.languages.join(', ')}`);
  if (codebaseIndex.frameworks?.length) parts.push(`Detected stack: ${codebaseIndex.frameworks.join(', ')}`);
  if (codebaseIndex.entryPoints.length) parts.push(`Likely entry point(s): ${codebaseIndex.entryPoints.join(', ')}`);
  if (codebaseIndex.hasGit) parts.push(`Git repository: yes`);
  if (codebaseIndex.isMonorepo) parts.push(`Monorepo with ${codebaseIndex.subPackages.length} sub-packages (${codebaseIndex.subPackages.map((p) => p.path).join(', ')})`);
  const summary = parts.length
    ? `No CLAUDE.md/README.md/console.config.json/package.json found for this project — this overview was auto-detected from the folder's contents. ${parts.join('. ')}.`
    : `No CLAUDE.md/README.md/console.config.json/package.json found, and little else was detected either — auto-recognized based on file contents alone.`;
  return {
    projectName: name,
    entries: [{
      triggers: ['what is this project', 'overview', 'tell me about this project', 'project info'],
      type: 'answer',
      response: summary,
    }],
  };
}

// Files treated as project-context documentation, in priority order (index 0 wins ties for
// which doc is treated as "the" doc in builtinIntents.js's overview/deep-dive responses).
// Tobi's own convention (see insightflow on GitHub) is CLAUDE.md as source of truth, with
// README.md, ABOUT-TOBI.md, and UNIVERSAL_CONTEXT.md as supporting context — widened from the
// original CLAUDE.md/README.md-only list so those get ingested too instead of silently ignored.
const CONTEXT_FILENAMES = ['claude.md', 'readme.md', 'about-tobi.md', 'universal_context.md'];

function contextPriority(filename) {
  const idx = CONTEXT_FILENAMES.indexOf(filename.toLowerCase());
  return idx === -1 ? CONTEXT_FILENAMES.length : idx;
}

/**
 * Scans baseDir for subdirectories containing console.config.json or CLAUDE.md/README.md
 */
export async function discoverProjects(baseDir) {
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
    const rootNames = new Set(entries.map((e) => e.name.toLowerCase()));
    const looksLikeSingleProjectRoot =
      rootNames.has('console.config.json') ||
      CONTEXT_FILENAMES.some((f) => rootNames.has(f)) ||
      rootNames.has('package.json');
    if (looksLikeSingleProjectRoot) {
      const folderName = path.basename(baseDir);
      const single = await scanSingleProject(folderName, baseDir);
      return single ? [single] : [];
    }

    const projects = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projectPath = path.join(baseDir, entry.name);
        
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

        let contextFiles = [];
        let parsedKnowledge = { stack: '', commands: '', gotchas: '', architecture: '' };
        
        try {
          const filesInDir = await fs.readdir(projectPath);
          for (const file of filesInDir) {
            if (CONTEXT_FILENAMES.includes(file.toLowerCase())) {
              const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
              contextFiles.push({ filename: file, content });
              
              // Simple markdown parsing based on headers
              const lines = content.split('\n');
              let currentSection = 'architecture'; // default
              for (const line of lines) {
                const lower = line.toLowerCase();
                if (lower.startsWith('## stack') || lower.startsWith('### stack')) {
                  currentSection = 'stack';
                } else if (lower.startsWith('## commands') || lower.startsWith('### commands') || lower.startsWith('## run')) {
                  currentSection = 'commands';
                } else if (lower.startsWith('## gotchas') || lower.startsWith('### gotchas') || lower.startsWith('## known issues')) {
                  currentSection = 'gotchas';
                } else if (lower.startsWith('## architecture') || lower.startsWith('### architecture')) {
                  currentSection = 'architecture';
                } else if (lower.startsWith('## ')) {
                   currentSection = 'architecture';
                } else {
                  if (parsedKnowledge[currentSection] !== undefined) {
                    parsedKnowledge[currentSection] += line + '\n';
                  }
                }
              }
            }
          }
        } catch (err) {}

        // CLAUDE.md wins as the "main doc" (see builtinIntents.js project.knowledge.overview /
        // explain_followup) regardless of alphabetical readdir order.
        contextFiles.sort((a, b) => contextPriority(a.filename) - contextPriority(b.filename));

        // Combine inferred config
        if (!config && contextFiles.length > 0) {
           config = { projectName: entry.name, entries: [] };
           
           // Automatically extract commands from 'commands' section
           const commandLines = parsedKnowledge.commands.match(/```[a-z]*\n([\s\S]*?)```/g) || [];
           commandLines.forEach(block => {
             const lines = block.replace(/```[a-z]*\n/, '').replace(/```/, '').split('\n').filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
             lines.forEach(cmd => {
                config.entries.push({
                   triggers: ["run " + cmd.split(' ')[0], "execute " + cmd.split(' ')[0]],
                   type: "command",
                   action: cmd.trim()
                });
             });
           });
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

        if (!config && contextFiles.length === 0 && isRecognizableByCodeAlone(codebaseIndex)) {
          config = buildFallbackConfig(entry.name, codebaseIndex);
        }

        if (config || contextFiles.length > 0) {
          projects.push({
            id: entry.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            folderName: entry.name,
            name: config?.projectName || entry.name,
            path: projectPath,
            config: config || { projectName: entry.name, entries: [] },
            contextFiles: contextFiles,
            parsedKnowledge,
            codebaseIndex
          });
        }
      }
    }

    return projects;
  } catch (err) {
    console.error(`Failed to scan directory at "${baseDir}":`, err.message);
    return [];
  }
}

/**
 * Scans a single project folder for its config and context files.
 * Returns a project object or null if no valid config/docs found.
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

  let contextFiles = [];
  let parsedKnowledge = { stack: '', commands: '', gotchas: '', architecture: '' };

  try {
    const filesInDir = await fs.readdir(projectPath);
    for (const file of filesInDir) {
      if (CONTEXT_FILENAMES.includes(file.toLowerCase())) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        contextFiles.push({ filename: file, content });

        const lines = content.split('\n');
        let currentSection = 'architecture';
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (lower.startsWith('## stack') || lower.startsWith('### stack')) {
            currentSection = 'stack';
          } else if (lower.startsWith('## commands') || lower.startsWith('### commands') || lower.startsWith('## run')) {
            currentSection = 'commands';
          } else if (lower.startsWith('## gotchas') || lower.startsWith('### gotchas') || lower.startsWith('## known issues')) {
            currentSection = 'gotchas';
          } else if (lower.startsWith('## architecture') || lower.startsWith('### architecture')) {
            currentSection = 'architecture';
          } else if (lower.startsWith('## ')) {
            currentSection = 'architecture';
          } else {
            if (parsedKnowledge[currentSection] !== undefined) {
              parsedKnowledge[currentSection] += line + '\n';
            }
          }
        }
      }
    }
  } catch (err) {}

  contextFiles.sort((a, b) => contextPriority(a.filename) - contextPriority(b.filename));

  if (!config && contextFiles.length > 0) {
    config = { projectName: folderName, entries: [] };
    const commandLines = parsedKnowledge.commands.match(/```[a-z]*\n([\s\S]*?)```/g) || [];
    commandLines.forEach(block => {
      const lines = block.replace(/```[a-z]*\n/, '').replace(/```/, '').split('\n').filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
      lines.forEach(cmd => {
        config.entries.push({
          triggers: ["run " + cmd.split(' ')[0], "execute " + cmd.split(' ')[0]],
          type: "command",
          action: cmd.trim()
        });
      });
    });
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
      contextFiles,
      parsedKnowledge,
      codebaseIndex
    };
  }
  return null;
}
