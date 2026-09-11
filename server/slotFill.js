// slotFill.js — lightweight per-intent slot filling (Step 4).
//
// Resolves an utterance to { intent, entities } with pattern/regex extraction on top of the
// EXISTING MiniLM model — no separate BERT-sized model. Reuses the canonical extractors the
// handlers already run (extractCommentMessage, extractRequestedPort) so match-time entities
// and handler behavior can never disagree about what was said; the run_script slot adds a
// small regex candidate plus an optional embedding-assisted validation against real script
// names when the caller has them (handler time) — at match time there is no project, so the
// candidate rides unvalidated as a hint for Step 5's structured fallback.
//
// Rules: every extractor is total (never throws — the match path must not break on odd
// input) and additive (intents without a spec resolve to {}). Handlers are untouched: they
// keep parsing `input` themselves exactly as before.

import { extractCommentMessage } from './wsHandlers/builtinHelpers.js';
import { extractRequestedPort } from './requestedPort.js';
import { cosineSimilarity } from './intentVectorScan.js';

/** Embedding floor for accepting a fuzzy script-name match (mirrors the semantic stage floor). */
export const SLOT_SCRIPT_FLOOR = 0.6;
/**
 * Floor for prefix-sharing candidates (measured 2026-09-11: sim(server, serve) = 0.426 —
 * derivational morphology scores far below the semantic floor on single words, so a bare
 * 0.6 would leave the embedding half dead code). 0.4 is the codebase's existing weak-guess
 * floor (FALLBACK_SCORE_FLOOR vocabulary): shared-stem + weak-embedding agreement.
 */
export const SLOT_SCRIPT_PREFIX_FLOOR = 0.4;
/** Minimum shared-prefix length for the prefix rule (4 covers serv/er, test/ing, build/er). */
export const SLOT_SCRIPT_PREFIX_LEN = 4;

/** Tokens skipped when hunting the run-verb's argument (determiners only — script names win). */
const SKIPPED_TOKENS = new Set(['the', 'a', 'an', 'my', 'this', 'that', 'these', 'those']);

/** First non-determiner token after a run verb — an unvalidated candidate, quotes stripped. */
function runVerbCandidate(text) {
  const m = String(text || '').match(/\b(?:run|execute|launch|start|serve)\b\s+(?:(?:the|a|an|my|this|that|these|those)\s+)?([^\s"'`.,;!?]+)/i);
  if (!m) return null;
  const tok = m[1].replace(/^["'`]+|["'`]+$/g, '').trim();
  return tok || null;
}

function wholeWord(haystack, needle) {
  const escaped = String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(String(haystack));
}

/**
 * Resolve the run script slot. Pure-regex candidate always; validated against `scripts`
 * (array of real package.json script names) when provided. Embedding-assisted fallback:
 * when the candidate matches no script exactly but `embedInput` (MiniLM) is available, the
 * closest script at >= SLOT_SCRIPT_FLOOR wins (covers "server" vs a `serve` script).
 * Returns { script } with script null when nothing is found; `validated` tells whether the
 * value was checked against real names (false at match time — a hint, not a promise).
 */
export async function resolveRunScript(text, { scripts = null, embedInput = null } = {}) {
  const candidate = runVerbCandidate(text);
  if (!scripts || scripts.length === 0) return { script: candidate, validated: false };
  if (candidate && scripts.some(s => wholeWord(s, candidate) || wholeWord(candidate, s))) {
    const exact = scripts.find(s => wholeWord(s, candidate)) || scripts.find(s => wholeWord(candidate, s));
    return { script: exact, validated: true };
  }
  if (candidate && typeof embedInput === 'function') {
    try {
      const candVec = await embedInput(candidate);
      if (candVec) {
        let best = null;
        let bestScore = -Infinity;
        for (const name of scripts) {
          const v = await embedInput(name);
          if (!v) continue;
          const s = cosineSimilarity(candVec, v);
          if (s > bestScore) { bestScore = s; best = name; }
        }
        if (best && bestScore >= SLOT_SCRIPT_FLOOR) {
          return { script: best, validated: true, via: 'embedding', score: Number(bestScore.toFixed(4)) };
        }
        // Prefix + weak-embedding agreement (server/serve class): same stem, some signal.
        if (best) {
          const lcp = sharedPrefixLen(candidate.toLowerCase(), best.toLowerCase());
          if (lcp >= SLOT_SCRIPT_PREFIX_LEN && bestScore >= SLOT_SCRIPT_PREFIX_FLOOR) {
            return { script: best, validated: true, via: 'embedding-prefix', score: Number(bestScore.toFixed(4)) };
          }
        }
      }
    } catch {
      // fall through to the unvalidated candidate below
    }
  }
  return { script: candidate, validated: false };
}

function sharedPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** "my notes about X" / "notes on X" trailing-topic filter (null when absent). */
function notesFilter(text) {
  const m = String(text || '').match(/\bnotes?\b.*\b(?:about|containing|with|on)\s+(.+?)\s*[.?!]*$/i);
  const q = m ? m[1].trim().replace(/[.?!]+$/, '') : '';
  return q || null;
}

/**
 * Extract entities for one (intent, utterance) pair. Always resolves — unknown intents and
 * empty findings yield {}. Never throws.
 *
 * Specs v1 (Step 4): run_project {script, port}, git_push {message}, git_commit {message},
 * git_commit_push {message} (same helper as the commit/push pair), system.notes.list {filter}.
 */
export async function extractSlots(intent, text, opts = {}) {
  try {
    const input = String(text || '');
    if (!intent || !input.trim()) return {};
    if (intent === 'run_project' || intent === 'npm_run') {
      const entities = {};
      const { script, validated, via, score } = await resolveRunScript(input, opts);
      if (script) {
        entities.script = script;
        if (validated) entities.scriptValidated = true;
        if (via) { entities.scriptVia = via; entities.scriptScore = score; }
      }
      const port = extractRequestedPort(input);
      if (port) entities.port = port;
      return entities;
    }
    if (intent === 'git_push' || intent === 'git_commit' || intent === 'git_commit_push') {
      const message = extractCommentMessage(input);
      return message ? { message } : {};
    }
    if (intent === 'system.notes.list') {
      const filter = notesFilter(input);
      return filter ? { filter } : {};
    }
    return {};
  } catch {
    return {};
  }
}
