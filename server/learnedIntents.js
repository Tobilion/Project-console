import fs from 'fs';
import path from 'path';
import { INTENTS } from './intentsData.js';
import { writeFileAtomicSync } from './atomicWrite.js';
import { resolveData } from './dataPath.js';
import { log } from './logger.js';

// `INTENTS` (from intentsData.js) is a single module-level object shared by the whole running
// Node process — it is NOT per-project. That means when `learningEngine.js`'s applySuggestions()
// pushes a confirmed near-miss phrase into INTENTS[intent].examples, every project the server is
// currently serving benefits from it immediately, in memory, for free. The real gap was
// persistence: that mutation was never written to disk, so a server restart silently forgot
// every phrase the app had ever learned, in every project, at once. This module closes that gap.

const LEARNED_FILE = resolveData('learned-intents.json');

function ensureDataDir() {
  const dir = path.dirname(LEARNED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readLearnedFile() {
  try {
    if (fs.existsSync(LEARNED_FILE)) {
      return JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

/**
 * Merge previously-learned phrases into the shared INTENTS object. Must be called before
 * semanticMatcher.initialize() builds its embeddings/Fuse index, so learned phrases are treated
 * as first-class examples rather than only reachable via the Fuse fallback stage.
 * Returns the number of phrases merged.
 */
export function loadLearnedIntents() {
  const learned = readLearnedFile();
  let merged = 0;
  for (const [intent, phrases] of Object.entries(learned)) {
    const config = INTENTS[intent];
    if (!config || !Array.isArray(phrases)) continue;
    const existing = new Set(config.examples);
    for (const phrase of phrases) {
      if (!existing.has(phrase)) {
        config.examples.push(phrase);
        existing.add(phrase);
        merged++;
      }
    }
  }
  if (merged > 0) {
    log.info(`[LearnedIntents] Restored ${merged} previously-learned phrase(s) across all projects.`);
  }
  return merged;
}

/**
 * Persist newly-applied phrases (from learningEngine.js's applySuggestions) so they survive a
 * restart. `added` is [{ intent, phrase }, ...] — the same shape applySuggestions returns.
 */
export function persistLearnedPhrases(added) {
  if (!added?.length) return;
  ensureDataDir();
  const learned = readLearnedFile();
  for (const { intent, phrase } of added) {
    if (!learned[intent]) learned[intent] = [];
    if (!learned[intent].includes(phrase)) learned[intent].push(phrase);
  }
  writeFileAtomicSync(LEARNED_FILE, JSON.stringify(learned, null, 2));
}
