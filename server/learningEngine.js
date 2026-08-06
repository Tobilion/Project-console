import { readNearMisses, clearNearMisses, listNearMissProjectIds } from './nearMissLogger.js';
import { semanticMatcher } from './semanticMatcher.js';
import { INTENTS } from './intentsData.js';
import { persistLearnedPhrases } from './learnedIntents.js';
import { nlpEngine } from './nlpEngine.js';
import { mapNearMissToIntent } from './nearMissIntentMap.js';

// Minimum occurrences before a pattern is suggested for promotion to an intent
const MIN_OCCURRENCES = 3;

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
 * Apply approved suggestions — inject phrases into the in-memory INTENTS object
 * and rebuild the Fuse.js index so fuzzy matching picks them up immediately.
 *
 * Returns the list of phrases actually added.
 */
export function applySuggestions(suggestionIds, projectId) {
  const allSuggestions = generateSuggestions(projectId);
  const approved = allSuggestions.filter(s => suggestionIds.includes(s.id));

  const added = [];
  for (const suggestion of approved) {
    const intent = INTENTS[suggestion.intent];
    if (!intent) continue;

    const existing = new Set(intent.examples);
    for (const phrase of suggestion.phrases) {
      if (!existing.has(phrase)) {
        intent.examples.push(phrase);
        existing.add(phrase);
        added.push({ intent: suggestion.intent, phrase });
      }
    }
  }

  // Rebuild the Fuse.js index so new phrases are immediately matchable
  if (added.length > 0) {
    semanticMatcher._rebuildFuseIndex();
    // Persist to disk so this survives a server restart (INTENTS is shared across every
    // project in memory, but was never written back — this is what makes learning "stick").
    persistLearnedPhrases(added);
    // Confirmed live 2026-07-29: nlpEngine (a real trained NLP.js classifier, not just curated
    // examples) used to be trained once at startup and then frozen — it never got these same
    // confirmed-real phrases, even though the semantic matcher right above it did. Kept as a
    // fire-and-forget background retrain (not awaited) rather than making this function and both
    // of its call sites async, since a slightly-delayed classifier refresh is harmless but a
    // startup path blocking on a full NLP.js retrain is not worth the risk.
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
export function autoApplySuggestions(projectId) {
  const suggestions = generateSuggestions(projectId);
  const highConfidence = suggestions.filter(s => s.confidence === 'high');
  if (highConfidence.length === 0) return { applied: 0, total: suggestions.length };
  const added = applySuggestions(highConfidence.map(s => s.id), projectId);
  return { applied: added.length, total: suggestions.length };
}

/** Sweep every project with a near-miss log and auto-apply high-confidence suggestions. */
export function autoApplySuggestionsForAll() {
  const results = [];
  for (const projectId of listNearMissProjectIds()) {
    const result = autoApplySuggestions(projectId);
    if (result.applied > 0) {
      results.push({ projectId, ...result });
    }
  }
  return results;
}
