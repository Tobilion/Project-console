import { readNearMisses, clearNearMisses, listNearMissProjectIds } from './nearMissLogger.js';
import { semanticMatcher } from './semanticMatcher.js';
import { INTENTS } from './intentsData.js';
import { persistLearnedPhrases, persistEviction } from './learnedIntents.js';
import { filterHeldOut } from './evalGuard.js';
import { REDUNDANT_COSINE_THRESHOLD } from './memoryDedupe.js';
import { cosineSimilarity } from './intentVectorScan.js';
import { nlpEngine } from './nlpEngine.js';
import { mapNearMissToIntent } from './nearMissIntentMap.js';

// Minimum occurrences before a pattern is suggested for promotion to an intent
const MIN_OCCURRENCES = 3;

/**
 * Max examples per intent, enforced at promotion time (Step 2). A qualifying novel phrase
 * at cap evicts the intent's most-redundant existing example (exactly one victim per added
 * phrase) instead of growing the corpus unboundedly (the 2e0e2f3 bulk-add is why this gate
 * exists). Intents already over cap from curated history hold steady — each approval trades
 * at most one stale example for the new one — they are never converged downward by
 * automation; shrinking curated stock stays a human decision.
 */
export const MAX_EXAMPLES_PER_INTENT = 30;

/**
 * Reviews near-miss log entries for a project and generates suggestions for
 * promoting frequently-seen patterns into intent examples.
 *
 * Returns an array of suggestion objects:
 *   { id, intent, phrases: [], count, confidence }
 */
export function generateSuggestions(projectId) {
  const entries = readNearMisses(projectId);
  if (entries.length === 0) return [];

  // Group by the resolved command (which reflects the guessCommand pattern that fired)
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.resolvedCommand) continue;
    const key = entry.resolvedCommand;
    if (!groups.has(key)) {
      groups.set(key, {
        command: entry.resolvedCommand,
        description: entry.description,
        inputs: [],
        accepted: 0,
        rejected: 0,
      });
    }
    const group = groups.get(key);
    group.inputs.push(entry.input);
    if (entry.accepted === true) group.accepted++;
    if (entry.accepted === false) group.rejected++;
  }

  const suggestions = [];
  for (const [command, group] of groups) {
    if (group.inputs.length < MIN_OCCURRENCES) continue;

    // Resolve the pattern's intent (GUESS_TO_INTENT description match, else command inference)
    const intent = mapNearMissToIntent(command, group.description);
    if (!intent) continue;

    // Deduplicate input phrases
    const phrases = [...new Set(group.inputs)];

    // Confidence based on acceptance rate and frequency. The || 1 must guard the whole
    // fraction, not just the denominator: `a / (b || 1)` with both counts at 0 evaluates
    // 0/1 = 0, which wrongly rates an unanswered group as 'low' forever — the intended
    // fallback for "no feedback yet" is a perfect 1, not 0.
    const acceptanceRate = group.accepted / (group.accepted + group.rejected) || 1;
    let confidence = 'low';
    if (group.inputs.length >= 5 && acceptanceRate >= 0.8) confidence = 'high';
    else if (group.inputs.length >= 3 && acceptanceRate >= 0.6) confidence = 'medium';

    suggestions.push({
      // Deterministic and stable across generateSuggestions() calls — applySuggestions()
      // re-runs this function to resolve the submitted IDs, and a random UUID (fresh on
      // every call) could never match. The resolved command is the grouping key, so it
      // uniquely identifies the suggestion and survives the review -> approve round-trip.
      id: command,
      intent,
      phrases,
      count: group.inputs.length,
      accepted: group.accepted,
      rejected: group.rejected,
      confidence,
    });
  }

  // Sort by count descending
  suggestions.sort((a, b) => b.count - a.count);
  return suggestions;
}

/**
 * Batch-embed phrases for the novelty gate. Returns plain-array vectors in input order, or
 * null when the embedding model isn't ready / any item fails — the caller falls back to
 * exact-string dedup rather than blocking learning on model availability.
 */
async function embedForNovelty(texts) {
  try {
    const results = await semanticMatcher._embedBatch(texts);
    if (!results || results.length !== texts.length) return null;
    const vecs = results.map(r => (r && r.data ? Array.from(r.data) : null));
    if (vecs.some(v => !v)) return null;
    return vecs;
  } catch {
    return null;
  }
}

function maxSimilarity(vec, vecs) {
  let m = -Infinity;
  for (const v of vecs) {
    const s = cosineSimilarity(vec, v);
    if (s > m) m = s;
  }
  return m;
}

/** Index of the most redundant vector: the one with the highest max-similarity to any other. */
function mostRedundantIndex(vecs) {
  let idx = 0;
  let best = -Infinity;
  for (let i = 0; i < vecs.length; i++) {
    let m = -Infinity;
    for (let j = 0; j < vecs.length; j++) {
      if (i === j) continue;
      const s = cosineSimilarity(vecs[i], vecs[j]);
      if (s > m) m = s;
    }
    if (m > best) { best = m; idx = i; }
  }
  return idx;
}

/**
 * Apply approved suggestions — inject phrases into the in-memory INTENTS object
 * and rebuild the Fuse.js index so fuzzy matching picks them up immediately.
 *
 * Gated promotion (Steps 1+2) — a phrase is added only when it passes, in order:
 *   1. held-out eval filter (frozen real-user messages are never training data),
 *   2. exact-string dedup (cheap first pass),
 *   3. cosine novelty: rejected when similarity to the nearest existing example of the
 *      same intent is at/above REDUNDANT_COSINE_THRESHOLD (0.92, shared with memoryDedupe),
 *   4. per-intent cap (30): a qualifying phrase at cap evicts the most-redundant
 *      pre-existing example — exactly one victim per added phrase, never a mass convergence.
 * When the embedding model is unavailable the cosine stages are skipped with a warning and
 * the exact-dedup result is promoted as before — learning degrades, never blocks.
 *
 * Returns the list of phrases actually added.
 */
export async function applySuggestions(suggestionIds, projectId) {
  const allSuggestions = generateSuggestions(projectId);
  const approved = allSuggestions.filter(s => suggestionIds.includes(s.id));

  const added = [];
  let redundantRejected = 0;
  const evicted = [];
  for (const suggestion of approved) {
    const intentName = suggestion.intent;
    const intent = INTENTS[intentName];
    if (!intent) continue;

    // Held-out guard: frozen eval messages must never be promoted into training examples.
    const { kept, blocked } = filterHeldOut(suggestion.phrases);
    if (blocked > 0) console.warn(`[learningEngine] skipped ${blocked} held-out eval phrase(s) for ${intentName}`);
    const existing = new Set(intent.examples);
    const fresh = kept.filter(p => !existing.has(p));
    if (fresh.length === 0) continue;

    // Cosine novelty gate over existing + candidates in one batch. acceptedVecs grows with
    // each accepted candidate so near-duplicate candidates within one approval reject
    // against each other, not just against the pre-existing corpus.
    const batch = [...intent.examples, ...fresh];
    const vecs = await embedForNovelty(batch);
    let candidates; // [{ phrase, vector|null }]
    let curVecs = null; // working vectors parallel to intent.examples (model path only)
    if (!vecs) {
      console.warn(`[learningEngine] embedding unavailable — exact-dedup fallback for ${intentName}, cap eviction skipped`);
      candidates = fresh.map(phrase => ({ phrase, vector: null }));
    } else {
      const acceptedVecs = vecs.slice(0, intent.examples.length);
      candidates = [];
      const candVecs = vecs.slice(intent.examples.length);
      fresh.forEach((phrase, i) => {
        if (maxSimilarity(candVecs[i], acceptedVecs) >= REDUNDANT_COSINE_THRESHOLD) {
          redundantRejected++;
        } else {
          candidates.push({ phrase, vector: candVecs[i] });
          acceptedVecs.push(candVecs[i]);
        }
      });
      // Working vector array parallel to intent.examples for cap eviction below.
      // acceptedVecs also holds this batch's accepted candidates after index
      // intent.examples.length; curVecs tracks only the pre-existing ones and is
      // maintained in the loop below.
      curVecs = acceptedVecs.slice(0, intent.examples.length);
    }

    // Stored embedding-stage vectors, spliced/pushed in lockstep with intent.examples when
    // they are parallel (the steady state). When they diverge (a past embed failure skipped
    // an append) the examples mutation still lands and the next boot recompute re-syncs.
    const stored = semanticMatcher.intentVectors?.[intentName];
    let parallel = Array.isArray(stored) && stored.length === intent.examples.length;
    if (!parallel && stored) console.warn(`[learningEngine] intentVectors out of sync for ${intentName} — vector splice skipped (restart recomputes)`);
    // Pre-existing count bounds eviction victims (see loop below).
    let eligible = intent.examples.length;

    for (const { phrase, vector } of candidates) {
      // Victims come from the pre-existing corpus only (eligible): phrases approved in this
      // same run are never evicted behind the approver's back (added[] must stay truthful).
      // Exactly ONE eviction per added phrase: at cap this holds the line (30→29→30); on a
      // grandfathered over-cap intent it holds steady instead of converging. A `while` loop
      // here looked tempting for convergence but live-probed destructive: one approval on a
      // 48-example intent wiped 19 hand-curated examples at once. Shrinking curated stock is
      // a human curation decision (a future report can LIST most-redundant candidates for
      // review) — the gate's job is to stop unbounded growth, never mass-delete.
      if (intent.examples.length >= MAX_EXAMPLES_PER_INTENT) {
        if (!vecs || !curVecs || eligible <= 0) {
          console.warn(`[learningEngine] ${intentName} at cap (${intent.examples.length}) with no embeddings — phrase skipped, nothing evicted blindly`);
          continue;
        }
        const victimIdx = mostRedundantIndex(curVecs.slice(0, eligible));
        const victim = intent.examples[victimIdx];
        intent.examples.splice(victimIdx, 1);
        curVecs.splice(victimIdx, 1);
        eligible--;
        if (parallel) stored.splice(victimIdx, 1);
        existing.delete(victim);
        persistEviction(intentName, victim);
        evicted.push({ intent: intentName, phrase: victim });
      }
      if (intent.examples.length >= MAX_EXAMPLES_PER_INTENT && eligible <= 0) continue; // cap held, no blind eviction
      intent.examples.push(phrase);
      existing.add(phrase);
      if (vecs && curVecs) {
        curVecs.push(vector);
        if (parallel) stored.push(vector);
      }
      added.push({ intent: intentName, phrase });
    }
  }

  if (redundantRejected > 0) console.warn(`[learningEngine] rejected ${redundantRejected} semantically-redundant phrase(s) (>= ${REDUNDANT_COSINE_THRESHOLD} cosine)`);
  if (evicted.length > 0) console.warn(`[learningEngine] evicted ${evicted.length} redundant example(s) at cap: ${evicted.map(e => `${e.intent}:${e.phrase.slice(0, 40)}`).join('; ')}`);

  // Rebuild the Fuse.js index so new phrases are immediately matchable
  if (added.length > 0) {
    semanticMatcher._rebuildFuseIndex();
    // Embedding-stage refresh for phrases added without a synced vector (model-unavailable
    // fallback path). The model-ready path above already pushed vectors directly, so this
    // is a no-op-safe backstop, not a double-add — addLearnedExamples appends only what it
    // embeds, and parallel intents were synced inline.
    const needsRefresh = added.filter(a => {
      const s = semanticMatcher.intentVectors?.[a.intent];
      const cfg = INTENTS[a.intent];
      return !Array.isArray(s) || s.length < cfg.examples.length;
    });
    for (const a of needsRefresh) {
      semanticMatcher.addLearnedExamples(a.intent, [a.phrase]).catch(() => {});
    }
    // Persist to disk so this survives a server restart (INTENTS is shared across every
    // project in memory, but was never written back — this is what makes learning "stick").
    persistLearnedPhrases(added);
    // Confirmed live 2026-07-29: nlpEngine (a real trained NLP.js classifier, not just curated
    // examples) used to be trained once at startup and then frozen — it never got these same
    // confirmed-real phrases, even though the semantic matcher right above it did. Still a
    // fire-and-forget background retrain (not awaited): this function is async for the
    // embedding gate now, but a slightly-delayed classifier refresh stays harmless while a
    // chat/boot path blocking on a full NLP.js retrain is not worth the risk. Known limit:
    // cap-evicted victims linger in the classifier until the next process boot rebuilds it —
    // node-nlp has no removal path worth the churn for an already-rare event.
    for (const a of added) nlpEngine.addLearnedPhrase(a.phrase, a.intent);
    nlpEngine.retrainFromLearned().catch(() => {});
  }

  // Clear the near-miss log for this project once its suggestions have been acted on — even
  // when every approved phrase already existed in INTENTS (previously auto-applied, or an
  // overlap between grouped suggestions). Clearing only on `added.length > 0` left those
  // patterns regenerating the same suggestions on every review and every startup sweep,
  // and the log file growing unbounded.
  if (approved.length > 0) {
    clearNearMisses(projectId);
  }

  return added;
}

/**
 * Auto-apply only the near-miss suggestions the engine is already highly confident about
 * (5+ occurrences, ≥80% acceptance rate — see the `confidence` calc in generateSuggestions)
 * without waiting for the user to run `review learning` + `approve suggestions` by hand.
 * Mirrors intentTelemetry.js's autoApplyThresholds, which already runs unattended on startup.
 */
export async function autoApplySuggestions(projectId) {
  const suggestions = generateSuggestions(projectId);
  const highConfidence = suggestions.filter(s => s.confidence === 'high');
  if (highConfidence.length === 0) return { applied: 0, total: suggestions.length };
  const added = await applySuggestions(highConfidence.map(s => s.id), projectId);
  return { applied: added.length, total: suggestions.length };
}

/** Sweep every project with a near-miss log and auto-apply high-confidence suggestions. */
export async function autoApplySuggestionsForAll() {
  const results = [];
  for (const projectId of listNearMissProjectIds()) {
    const result = await autoApplySuggestions(projectId);
    if (result.applied > 0) {
      results.push({ projectId, ...result });
    }
  }
  return results;
}
