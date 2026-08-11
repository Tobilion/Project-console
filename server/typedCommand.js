import fs from 'fs';
import path from 'path';
import { isCommandAllowed } from './toolAllow.js';

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
