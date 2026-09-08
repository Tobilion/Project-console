// Persisted intent-embedding cache (Phase D-4, 2026-09-08): the batch-embed step in
// semanticMatcherInit.js recomputes every phrase in the ~2500-phrase INTENTS corpus on
// EVERY server boot — this is the single largest piece of the ~35s cold-boot time
// (CLAUDE.md's "Startup is slow" gotcha). The vectors are a pure function of (a) the phrase
// corpus and (b) the embedding model, so once computed they can be written to disk and
// reused on the next boot as long as neither has changed.
//
// Cache-validity key: a hash of the model id/version plus every intent name + example
// phrase, in a stable order. Any corpus edit (a phrase added/removed/reworded, a new
// intent, a locale phrase set toggled) changes the hash and forces a fresh compute — this
// is deliberately conservative (recompute on any doubt) over trying to diff which phrases
// changed, since a stale vector for even one phrase would silently corrupt matching.
//
// Format on disk: { modelId, hash, createdAt, intentVectors: { [intent]: number[][] } }.
// The embedding model returns typed arrays; Array.from() before JSON.stringify is
// mandatory — the same typed-array-serializes-as-object corruption documented for
// server/codeIndex/ (Phase 7) applies here identically, and cosineSimilarity's plain
// indexed access works the same whether the array is typed or not, so a plain array
// round-trips safely through JSON.
import crypto from 'crypto';
import fs from 'fs';
import { resolveData } from './dataPath.js';
import { writeFileAtomicSync } from './atomicWrite.js';
import { log } from './logger.js';

const CACHE_FILE = resolveData('.cache', 'intent-vectors.json');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/** Stable hash over the model id + every (intent, phrase) pair, order-independent per intent
 *  set but phrase-order-sensitive within an intent (phrase order is also vector order, and
 *  the caller zips results back onto phraseTasks in the same order it read them in). */
function computeCorpusHash(intents) {
  const hash = crypto.createHash('sha256');
  hash.update(MODEL_ID);
  for (const intentName of Object.keys(intents).sort()) {
    hash.update('\n#' + intentName);
    for (const example of intents[intentName].examples) {
      hash.update('\n' + example);
    }
  }
  return hash.digest('hex');
}

/** Returns { intentVectors } on a valid cache hit, or null on any miss/corruption — callers
 *  must fall back to a full recompute on null, never partial-fill from a corrupt cache. */
export function loadIntentVectorCache(intents) {
  let raw;
  try {
    raw = fs.readFileSync(CACHE_FILE, 'utf8');
  } catch {
    return null; // no cache yet — first boot, or CONSOLE_DATA_DIR/.cache/ was cleared
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('[intentVectorCache] cache file is corrupt JSON, recomputing:', err.message);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.intentVectors || parsed.modelId !== MODEL_ID) {
    return null;
  }
  const expectedHash = computeCorpusHash(intents);
  if (parsed.hash !== expectedHash) {
    log.info('[intentVectorCache] intent corpus or model changed since the cache was written — recomputing.');
    return null;
  }
  // Shape sanity: every intent in the current corpus must have a matching vector array of
  // the same length as its example list, and every vector must be a non-empty number array.
  // A hash match already implies this in the normal case, but a hand-edited or truncated
  // cache file could still slip past — verify rather than trust before handing this to the
  // matcher, since a bad vector here corrupts matching silently instead of failing loudly.
  for (const [intentName, config] of Object.entries(intents)) {
    const vectors = parsed.intentVectors[intentName];
    if (!Array.isArray(vectors) || vectors.length !== config.examples.length) {
      log.warn(`[intentVectorCache] shape mismatch on intent "${intentName}", recomputing.`);
      return null;
    }
    for (const vec of vectors) {
      if (!Array.isArray(vec) || vec.length === 0 || typeof vec[0] !== 'number') {
        log.warn(`[intentVectorCache] malformed vector on intent "${intentName}", recomputing.`);
        return null;
      }
    }
  }
  return { intentVectors: parsed.intentVectors };
}

/** Persists the freshly computed intentVectors (owner.intentVectors — plain arrays already,
 *  per the Array.from() conversion at the call site in semanticMatcherInit.js). Best-effort:
 *  a write failure only costs the NEXT boot's time savings, never today's matching. */
export function saveIntentVectorCache(intents, intentVectors) {
  try {
    fs.mkdirSync(resolveData('.cache'), { recursive: true });
    const payload = JSON.stringify({
      modelId: MODEL_ID,
      hash: computeCorpusHash(intents),
      createdAt: new Date().toISOString(),
      intentVectors,
    });
    writeFileAtomicSync(CACHE_FILE, payload);
  } catch (err) {
    log.warn('[intentVectorCache] failed to persist cache (non-fatal, will recompute next boot):', err.message);
  }
}
