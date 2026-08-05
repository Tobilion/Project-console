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
  return codebaseIndex.hasRealCode || hasAnyKeyFile || codebaseIndex.hasGit;
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
// Tobi's own convention (see insightflow on GitHub) is CLAUDE.md as source of truth, with
// README.md, ABOUT-TOBI.md, and UNIVERSAL_CONTEXT.md as supporting context — widened from the
// original CLAUDE.md/README.md-only list so those get ingested too instead of silently ignored.
export const CONTEXT_FILENAMES = ['claude.md', 'readme.md', 'about-tobi.md', 'universal_context.md'];

export function contextPriority(filename) {
  const idx = CONTEXT_FILENAMES.indexOf(filename.toLowerCase());
  return idx === -1 ? CONTEXT_FILENAMES.length : idx;
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
