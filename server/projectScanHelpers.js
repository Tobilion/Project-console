import fs from 'fs/promises';
import path from 'path';

/**
 * Shared project-recognition helpers (Phase 14 split of projectScanner.js, 2026-08-05 — bodies
 * moved verbatim). Consumed by the container scan and the single-project scan alike.
 */

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
export function isRecognizableByCodeAlone(codebaseIndex) {
  if (!codebaseIndex || codebaseIndex.totalFiles === 0) return false;
  const hasAnyKeyFile = codebaseIndex.keyFiles && Object.keys(codebaseIndex.keyFiles).length > 0;
  // Phase 3 (2026-08-11): a folder holding only document files (DOCUMENT_EXTS — .pdf today) is
  // recognizable too — a PDF-only general-workspace folder must be discoverable for the PDF
  // toolkit. Deliberately separate from the code signals below: detectWorkspaceType() maps it to
  // 'general', never 'dev'.
  return codebaseIndex.hasRealCode || hasAnyKeyFile || codebaseIndex.hasGit
    || (codebaseIndex.documentCount || 0) > 0;
}

// WorkspaceType classification (Phase 1 of UPGRADE-ROADMAP.md, 2026-08-11): 'dev' | 'general',
// with 'general' as a deliberately loose bucket for doc/notes/asset folders that aren't code
// repos. The console.config.json `workspaceType` override always wins over the heuristic; an
// invalid value is dropped with a warning (same scan-time sanitize-then-ignore pattern as
// chatReplies below), never a crash. This is a presentation/suggestion-filtering signal only —
// matching never consults it, so a dev command typed in a mis-classified 'general' project
// still runs exactly as before.
const WORKSPACE_TYPES = new Set(['dev', 'general']);
export function detectWorkspaceType(config, codebaseIndex) {
  if (config && config.workspaceType !== undefined) {
    if (WORKSPACE_TYPES.has(config.workspaceType)) return config.workspaceType;
    console.warn(`[projectScanner] Ignoring invalid console.config.json "workspaceType" — expected "dev" or "general", got "${config.workspaceType}".`);
    delete config.workspaceType;
  }
  // Same recognition rule the code-only discovery fallback uses: real code, a known key
  // config file (package.json/Cargo.toml/etc.), or a real .git dir marks a folder 'dev'.
  // Phase 3 (2026-08-11): document-only folders (PDFs) are recognizable for the PDF toolkit
  // but are NOT dev — they classify 'general'. The distinction is explicit here (rather than
  // delegating to isRecognizableByCodeAlone, which now includes documents) so a doc signal
  // can never flip a folder to 'dev'.
  const idx = codebaseIndex || {};
  const hasCodeSignal = idx.hasRealCode
    || (idx.keyFiles && Object.keys(idx.keyFiles).length > 0)
    || idx.hasGit;
  return hasCodeSignal ? 'dev' : 'general';
}

// `chatReplies` is an OPTIONAL console.config.json top-level key (Phase 4.5 chit-chat
// intelligence): pools of reply strings per chit-chat intent ("greeting"/"status"/"gratitude"/
// "farewell"/"ack") that REPLACE that intent's built-in canned replies for this project. It's
// validated here at scan time — a malformed `chatReplies` must be ignored (with a warning),
// never a crash, exactly like a truncated package.json parse.
const CHAT_REPLIES_INTENTS = new Set(['greeting', 'status', 'gratitude', 'farewell', 'ack']);
export function sanitizeChatReplies(config) {
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
export function buildFallbackConfig(name, codebaseIndex) {
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
// CLAUDE.md is source of truth, with README.md and UNIVERSAL_CONTEXT.md as supporting context —
// widened from the original CLAUDE.md/README.md-only list so those get ingested too instead of
// silently ignored.
export const CONTEXT_FILENAMES = ['claude.md', 'readme.md', 'universal_context.md'];

// "About the maintainer" doc convention — ABOUT-<anything>.md (e.g. ABOUT-TOBI.md,
// ABOUT-ALICE.md), not one hardcoded person's name. This used to be a single literal
// 'about-tobi.md' entry in CONTEXT_FILENAMES, which only ever recognized the original author's
// own file — anyone else installing this package with their own ABOUT-<them>.md would have it
// silently ignored (audit 2026-08-10, raised while generalizing for npm/public distribution).
const ABOUT_DOC_RE = /^about[-_].+\.md$/i;

/** True for any recognized context-doc filename: the fixed CONTEXT_FILENAMES list or an
 *  ABOUT-*.md-shaped file for whoever's using this install. */
export function isContextFilename(filename) {
  const lower = filename.toLowerCase();
  return CONTEXT_FILENAMES.includes(lower) || ABOUT_DOC_RE.test(lower);
}

// Priority order: claude.md, readme.md, any about-*.md, universal_context.md, everything else
// last. The about-doc slot sits between readme and universal_context — same position the old
// hardcoded 'about-tobi.md' entry occupied, so existing sort behavior is unchanged for anyone
// who already has one.
export function contextPriority(filename) {
  const lower = filename.toLowerCase();
  if (lower === 'claude.md') return 0;
  if (lower === 'readme.md') return 1;
  if (ABOUT_DOC_RE.test(lower)) return 2;
  if (lower === 'universal_context.md') return 3;
  return 4;
}

/**
 * Reads + parses the per-project docs (CLAUDE.md/README.md/etc. via CONTEXT_FILENAMES) into
 * contextFiles + parsedKnowledge (the ## Stack/## Commands/## Gotchas/## Architecture section
 * split used by overview/explain_followup), sorted so CLAUDE.md wins as the "main doc".
 * Returns null when the folder holds no context docs.
 */
export async function readProjectContextDocs(projectPath) {
  let contextFiles = [];
  let parsedKnowledge = { stack: '', commands: '', gotchas: '', architecture: '' };

  try {
    const filesInDir = await fs.readdir(projectPath);
    for (const file of filesInDir) {
      if (isContextFilename(file)) {
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

  if (contextFiles.length === 0) return null;

  // CLAUDE.md wins as the "main doc" (see builtinIntents.js project.knowledge.overview /
  // explain_followup) regardless of alphabetical readdir order.
  contextFiles.sort((a, b) => contextPriority(a.filename) - contextPriority(b.filename));
  return { contextFiles, parsedKnowledge };
}

/**
 * Extracts "command" entries from a project's ## Commands docs section — fenced code blocks
 * become runnable `run <first-token>` / `execute <first-token>` trigger entries.
 */
export function commandEntriesFromDocs(folderName, parsedKnowledge) {
  const entries = [];
  const commandLines = parsedKnowledge.commands.match(/```[a-z]*\n([\s\S]*?)```/g) || [];
  commandLines.forEach(block => {
    const lines = block.replace(/```[a-z]*\n/, '').replace(/```/, '').split('\n').filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
    lines.forEach(cmd => {
      entries.push({
        triggers: ["run " + cmd.split(' ')[0], "execute " + cmd.split(' ')[0]],
        type: "command",
        action: cmd.trim()
      });
    });
  });
  return entries;
}
