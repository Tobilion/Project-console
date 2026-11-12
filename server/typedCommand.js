import fs from 'fs';
import path from 'path';
import { isCommandAllowed } from './toolAllow';

/**
 * Typed-command extraction for the chat-input path (2026-08-11, requested directly — a
 * friend's Angular project lived in a wrapper folder and `ng serve` typed in chat was
 * unrecognized: the matcher had no intent for it and the old typed-command bypass only
 * accepted the ALLOWED_COMMANDS list). Now the bypass claims anything whose first token
 * resolves to a real executable on PATH, plus natural prefixes ("run ng serve",
 * "command - git status", "execute npm run dev"). Single-token lines still require the
 * allowlist so plain chat words ("help", "status") never execute stray system binaries.
 *
 * The resolve-vs-allowlist split is deliberate: typing a command on your own machine is
 * the same trust level as a terminal, so PATH resolution is enough there; the strict
 * ALLOWED_COMMANDS gate still governs chips and AI tool calls (connectionToolCall.js /
 * aiQueryToolRun.js), which is the security boundary that matters.
 *
 * Follow-up fix (2026-08-11, same reporter, second machine): `ng serve` still didn't run even
 * after `ng` was added to ALLOWED_COMMANDS, because that machine's Angular CLI was only ever
 * installed as a project devDependency (`node_modules/.bin/ng`), never a global install —
 * extremely common for framework CLIs installed via `npm install` rather than `npm install -g`.
 * System PATH scanning alone can never find that binary. `resolveExecutableOnPath` now also
 * checks `<projectRoot>/node_modules/.bin/<token>` FIRST, before falling back to a system PATH
 * scan, when a project root is supplied — a locally installed CLI should win over a same-named
 * system binary that may not even be the right version for this project.
 */

// Cache keyed by PATH + project root so a changed PATH (nvm, fnm, installs) or a different
// project's node_modules invalidates naturally.
const resolveCache = new Map();

/** True when `token` resolves to an executable via a project's local node_modules/.bin, PATH,
 *  or is an existing path itself. `projectRoot`, when given, is checked first. */
export function resolveExecutableOnPath(token, projectRoot) {
  if (!token || typeof token !== 'string') return false;
  const pathKey = process.env.PATH || '';
  const key = `${pathKey}${projectRoot || ''}\u0000${token}`;
  const cached = resolveCache.get(key);
  if (cached !== undefined) return cached;
  let found = false;
  const clean = token.replace(/^['"`]+|['"`]+$/g, '');
  if (clean.includes('/') || clean.includes('\\')) {
    found = fs.existsSync(clean);
  } else {
    const exts = process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter(Boolean)
      : [''];
    const dirs = [];
    if (projectRoot) dirs.push(path.join(projectRoot, 'node_modules', '.bin'));
    dirs.push(...pathKey.split(path.delimiter).filter(Boolean));
    for (const dir of dirs) {
      const base = path.join(dir, clean);
      if (process.platform === 'win32') {
        if (exts.some((e) => fs.existsSync(base + e))) { found = true; break; }
      } else {
        try { fs.accessSync(base, fs.constants.X_OK); found = true; } catch {}
        if (found) break;
      }
    }
  }
  resolveCache.set(key, found);
  return found;
}

// Prefixes that turn a chat phrase into a command ask. Longest/most specific first so
// "run the command git status" doesn't get eaten by the bare "run " alternative.
const COMMAND_PREFIXES = [
  /^run\s+the\s+command\s+/i,
  /^run\s+(?:this\s+)?command\s+/i,
  /^execute\s+/i,
  /^command\s*[:\-]\s*/i,
  /^run\s+/i,
  /^start\s+/i,
];

// After a command prefix, a leading determiner/pronoun means this is a normal request
// ("run the site", "run my project", "execute the plan") — reject it so the matcher
// still handles those. "run ng serve" has an executable first token, so it wins.
const DETERMINER_RE = /^(the|a|an|this|that|these|those|my|our|your|his|her|its|their|every|some|any|all|each|both|either|neither|few|many|most|other|another|such|me|us|it|them|him|to|for|of|no|one|two)\b/i;

const TRAILING_FILLER_RE = /\s+(?:please|pls|thanks|thank you|thx)[\s.,!;]*$/i;
const TRAILING_PUNCT_RE = /[\s.,;!?]+$/;
const WRAP_QUOTES_RE = /^(['"`])([\s\S]*)\1$/;

// Natural-language collision guard (Phase 2, 2026-08-11): `find`, `sort` and `where` resolve
// to real Windows binaries (find.exe/sort.exe/where.exe), so chat phrases like "find duplicate
// files" or "sort these files by type" used to run those binaries with garbage arguments
// instead of reaching their intents. A first token in this set followed only by plain words
// (no flags, paths, globs, pipes, quotes) is a sentence, not a command — reject it so the
// matcher decides. Real command lines ("find . -name x", "sort data.csv") keep working.
const NATURAL_LANG_FIRST_TOKENS = new Set(['find', 'sort', 'where', 'convert', 'help']);
const PLAIN_WORD_RE = /^[a-z']+$/i;

// Natural-language REQUEST guard (2026-11-12, live NetPulse corpus).
//
// `git push with comment "micheal is the goat"` was typed into the chat, and the typed-command
// bypass handed the WHOLE line to the shell verbatim — git parsed "with", "comment",
// "micheal", "is", "the" and "goat" as refspecs and died with:
//     error: src refspec comment does not match any
//     error: failed to push some refs to 'with'
// The user then had to guess that "push the site with comment X" (a DIFFERENT phrasing, which
// the matcher does handle) was the working form.
//
// Root cause: the bypass decided "this is a command" purely from the FIRST TOKEN resolving on
// PATH. "git" resolves, so anything starting with "git" was treated as a shell line — even when
// the rest of the line was plainly English. The matcher never got a chance to see it.
//
// The rule: a real command line carries flags, paths and values, not English function words.
// Any bare (UNQUOTED) token that is a plain English connective or request-noun means the line
// is a sentence addressed to the console, so the matcher owns it. Quoted spans are excluded —
// `git commit -m "fix and ship"` is a command, and its "and" lives inside quotes.
//
// The token list is deliberately short and only contains words that never appear as bare
// positional arguments in the commands this console runs (git/npm/node/python/tsx/etc.).
// Multi-word flags ("--force-with-lease") never equal a listed token, so they are unaffected.
const NL_REQUEST_TOKENS = new Set([
  'with', 'and', 'then', 'but', 'so', 'please', 'instead',
  'comment', 'message', 'note', 'saying', 'reason',
]);

// Strips quoted spans so only the bare (unquoted) tokens are inspected.
function bareTokens(line) {
  return line
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when the line reads as a chat request rather than a shell command line.
 * Exported for the test harness.
 */
export function looksLikeNaturalLanguageRequest(line) {
  for (const token of bareTokens(line)) {
    const clean = token.replace(/[.,!?;:]+$/, '').toLowerCase();
    if (NL_REQUEST_TOKENS.has(clean)) return true;
  }
  return false;
}

/**
 * Extracts a command line from typed chat input, or null when the input is not a command.
 *
 * Rules:
 *  - strips trailing polite filler/"please" and outer quotes
 *  - accepts natural prefixes (run/execute/start/command -/command:)
 *  - prefix form: first token must resolve on PATH and not be a determiner
 *  - exact form with 2+ tokens: first token must resolve on PATH, OR the whole line must
 *    pass the allowlist check (covers `PORT=3001 npm run dev` env-prefix forms)
 *  - exact form with 1 token: must be allowlisted (never execute "help"/"status")
 *  - natural-language sentences (see NATURAL_LANG_FIRST_TOKENS) never bypass the matcher
 *  - lines whose bare tokens contain plain English request words (see NL_REQUEST_TOKENS)
 *    never bypass the matcher, even when the first token resolves on PATH
 */
export function extractCommandLine(input, projectRoot) {
  if (!input || typeof input !== 'string') return null;
  let line = input.trim();
  if (!line) return null;
  const wrapped = line.match(WRAP_QUOTES_RE);
  if (wrapped) line = wrapped[2].trim();
  line = line.replace(TRAILING_FILLER_RE, '').replace(TRAILING_PUNCT_RE, '').trim();
  if (!line) return null;

  let fromPrefix = false;
  for (const re of COMMAND_PREFIXES) {
    if (re.test(line)) {
      line = line.replace(re, '').trim();
      fromPrefix = true;
      break;
    }
  }
  const wrapped2 = line.match(WRAP_QUOTES_RE);
  if (wrapped2) line = wrapped2[2].trim();

  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const first = tokens[0];

  // Natural-language sentences never bypass the matcher: a first token in this set followed
  // by plain words (and, for the unit-conversion shapes, bare numbers) is a sentence, not a
  // command — "convert 5 km to miles" is the calculate intent, not the Windows `convert`
  // binary. Real command lines ("find . -name x", "convert d: /fs:ntfs") contain flags or
  // drive-letter colons that fail the plain-word test and still bypass.
  // 2026-08-26 live crosscheck: "help all" (the documented list_commands phrase) EXECUTED the
  // Windows help.exe binary ("This command is not supported by the help utility"). A bare
  // natural-lang token also never needs to run ("help", "find", "sort", "where", "convert"
  // with no arguments at all are useless invocations of their Windows binaries), so the guard
  // now covers single-token inputs too.
  if (NATURAL_LANG_FIRST_TOKENS.has(first.toLowerCase()) &&
      (tokens.length === 1 ||
       tokens.slice(1).every((t) => PLAIN_WORD_RE.test(t) || /^[\d.]+$/.test(t)))) {
    return null;
  }

  // 2026-11-12: a line whose bare tokens include plain English request words is a sentence
  // addressed to the console, not a command line — even when the first token resolves on PATH
  // ("git push with comment "x"" used to be executed verbatim and failed as a git refspec
  // error). The matcher handles these shapes properly (the commit/push comment flow extracts
  // the quoted message itself), so hand them over instead of guessing at a shell line.
  if (looksLikeNaturalLanguageRequest(line)) return null;

  if (fromPrefix) {
    if (DETERMINER_RE.test(first)) return null;
    if (!resolveExecutableOnPath(first, projectRoot)) return null;
  } else if (tokens.length === 1) {
    if (!isCommandAllowed(first)) return null;
  } else if (!resolveExecutableOnPath(first, projectRoot) && !isCommandAllowed(line)) {
    return null;
  }
  return line;
}
