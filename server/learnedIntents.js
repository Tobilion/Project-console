import fs from 'fs';
import path from 'path';
import { INTENTS } from './intentsData.js';
import { writeFileAtomicSync } from './atomicWrite.js';
import { resolveData } from './dataPath.js';
import { filterHeldOut } from './evalGuard.js';
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
      const parsed = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return {};
}

/**
 * Merge previously-learned phrases into the shared INTENTS object. Must be called before
 * semanticMatcher.initialize() builds its embeddings/Fuse index, so learned phrases are treated
 * as first-class examples rather than only reachable via the Fuse fallback stage.
 * Also re-applies recorded cap evictions (the `_evicted` map — see persistEviction), so an
 * example evicted at promotion time stays evicted across restarts instead of resurrecting
 * from its source file on every boot.
 * Returns the number of phrases merged.
 */
export function loadLearnedIntents() {
  const learned = readLearnedFile();
  let merged = 0;
  for (const [intent, phrases] of Object.entries(learned)) {
    if (intent === '_evicted') continue;
    const config = INTENTS[intent];
    if (!config || !Array.isArray(phrases)) continue;
    // Held-out guard: a stale learned file must never inject eval messages on boot.
    const { kept } = filterHeldOut(phrases);
    const existing = new Set(config.examples);
    for (const phrase of kept) {
      if (!existing.has(phrase)) {
        config.examples.push(phrase);
        existing.add(phrase);
        merged++;
      }
    }
  }
  // Re-apply evictions after the merge (a learned phrase re-added above is removed again
  // when it was the eviction victim — the eviction record wins by design).
  const evicted = learned._evicted;
  if (evicted && typeof evicted === 'object') {
    for (const [intent, phrases] of Object.entries(evicted)) {
      const config = INTENTS[intent];
      if (!config || !Array.isArray(phrases)) continue;
      for (const phrase of phrases) {
        const i = config.examples.indexOf(phrase);
        if (i !== -1) config.examples.splice(i, 1);
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
  // Held-out guard: never persist eval messages even if a caller forgets to filter.
  const { kept } = filterHeldOut(added.map(a => a.phrase));
  const keptSet = new Set(kept);
  const filtered = added.filter(a => keptSet.has(a.phrase));
  if (!filtered.length) return;
  const learned = readLearnedFile();
  for (const { intent, phrase } of filtered) {
    if (!learned[intent] || !Array.isArray(learned[intent])) learned[intent] = [];
    if (!learned[intent].includes(phrase)) learned[intent].push(phrase);
  }
  writeFileAtomicSync(LEARNED_FILE, JSON.stringify(learned, null, 2));
}

/**
 * Record a cap eviction (from learningEngine.js's per-intent cap) so it survives restarts.
 * The evicted phrase stays in its source intent file on disk — this record is what keeps
 * loadLearnedIntents() removing it from the in-memory corpus on every boot. Also drops the
 * phrase from the learned list when the victim was itself a previously-learned phrase.
 */
export function persistEviction(intent, phrase) {
  if (!intent || !phrase) return;
  ensureDataDir();
  const learned = readLearnedFile();
  if (!learned._evicted || typeof learned._evicted !== 'object' || Array.isArray(learned._evicted)) {
    learned._evicted = {};
  }
  if (!Array.isArray(learned._evicted[intent])) learned._evicted[intent] = [];
  if (!learned._evicted[intent].includes(phrase)) learned._evicted[intent].push(phrase);
  if (Array.isArray(learned[intent])) {
    const i = learned[intent].indexOf(phrase);
    if (i !== -1) learned[intent].splice(i, 1);
  }
  writeFileAtomicSync(LEARNED_FILE, JSON.stringify(learned, null, 2));
}
