// Phase 3 decomposition leaf: conjunction-splitting + multi-intent matching for
// SemanticMatcher (extracted verbatim from semanticMatcher.js — see that file's
// matchMulti / _splitConjunctions for the originals).
import { PURE_CHITCHAT_INTENTS } from './intentTrust.js';

/**
 * Splits an input on common conjunctions. Confirmed live 2026-07-29: `push this code with
 * comment "Massive Memory and Learning improvements"` has "and" sitting right inside a quoted
 * commit message that was never meant to be split at all — this function has no concept of
 * quote boundaries, so it would happily chop that string into two "intents" at the word "and"
 * regardless of the quotes around it. Since a multi-intent split is only ever a convenience
 * for genuinely separate requests ("show structure and run tests"), not something any
 * quoted-argument command needs, splitting is skipped entirely whenever the input contains a
 * quote character — safer to fall through to normal single-intent matching (which already
 * treats the whole string as one request) than to risk cutting a quoted value in half.
 */
export function splitConjunctions(input) {
  if (/["']/.test(input)) return null;
  // Phase 2 audit (2026-08-12): the File Tools panel sends explicit file lists after a
  // colon ("tidy this folder: pic.jpg, doc.pdf", "delete duplicates, keep newest: a.txt")
  // — the commas there are list separators, not conjunction splits, and chopping them
  // produces a bogus multi-intent (tidy + file_find). Skip splitting whenever a colon
  // introduces the comma-separated tail, same "don't cut a structured value in half"
  // reasoning as the quote guard above.
  if (/:\s*[\w.,\s/-]+$/.test(input)) return null;
  // Split on common conjunctions (non-capturing groups to avoid split artifacts)
  const separators = /\s+(?:and|also|then|plus)\s+|,\s*|;\s*|\s+&\s+|\s+as well as\s+/i;
  const parts = input.split(separators).map(s => s.trim()).filter(s => s && s.length > 3);
  return parts.length > 1 ? parts : null;
}

/** Matches each conjunction-split part through the matcher; null unless 2+ distinct intents. */
export async function matchMultiParts(matcher, input) {
  const parts = splitConjunctions(input);
  if (!parts) return null;

  // 2026-08-26 live batch crosscheck: "commit and push" split into [git_status, deploy] —
  // the parts matched wrong intents ("commit" prefix-matches git_status's "commit history"
  // example; bare "push" lands on deploy by design), dispatching a status check + a push
  // confirm instead of the single git_commit_push flow. When the WHOLE phrase already
  // matches one intent confidently (semantic stage only — pre-semantic overrides and the
  // keyword tier stay out of this decision), the split is a false positive: the user said
  // one thing, not two. The 0.75 floor keeps genuinely compound requests ("pull the latest
  // changes and then run the tests") splitting as before — the whole phrase never clears the
  // floor for two different actions — and PURE_CHITCHAT_INTENTS stay splittable ("hi and
  // thanks" still answers twice).
  const whole = await matcher.match(input);
  if (
    whole &&
    whole.source === 'semantic' &&
    whole.confidence >= 0.75 &&
    !PURE_CHITCHAT_INTENTS.has(whole.intent)
  ) {
    return null;
  }

  const results = [];
  const seenIntents = new Set();

  for (const part of parts) {
    const r = await matcher.match(part);
    // `matcher.match()` sets a single shared `_lastTelemetry` field per call, overwritten on
    // every subsequent call. Reading and clearing it HERE, immediately after each part's match,
    // is the only correct place to capture it — waiting until this loop finishes (as the old
    // caller in matcher.js used to do) means every part except the last one has already had its
    // telemetry silently clobbered by the part after it (audit 2026-08-10: confirmed the caller
    // was reconstructing per-item telemetry after the fact and getting `null` for all but one
    // part, permanently losing training data for compound commands). Attaching it to the result
    // object carries it out of this function correctly instead of relying on the caller to poll
    // a mutable singleton after the fact.
    const telemetry = matcher.getAndClearLastTelemetry();
    if (r && !seenIntents.has(r.intent)) {
      seenIntents.add(r.intent);
      results.push({ ...r, originalPhrase: part, telemetry });
    }
  }

  if (results.length <= 1) return null;
  return results;
}
