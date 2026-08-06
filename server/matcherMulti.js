// Phase 3 decomposition leaf: conjunction-splitting + multi-intent matching for
// SemanticMatcher (extracted verbatim from semanticMatcher.js — see that file's
// matchMulti / _splitConjunctions for the originals).

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
  // Split on common conjunctions (non-capturing groups to avoid split artifacts)
  const separators = /\s+(?:and|also|then|plus)\s+|,\s*|;\s*|\s+&\s+|\s+as well as\s+/i;
  const parts = input.split(separators).map(s => s.trim()).filter(s => s && s.length > 3);
  return parts.length > 1 ? parts : null;
}

/** Matches each conjunction-split part through the matcher; null unless 2+ distinct intents. */
export async function matchMultiParts(matcher, input) {
  const parts = splitConjunctions(input);
  if (!parts) return null;

  const results = [];
  const seenIntents = new Set();

  for (const part of parts) {
    const r = await matcher.match(part);
    if (r && !seenIntents.has(r.intent)) {
      seenIntents.add(r.intent);
      results.push({ ...r, originalPhrase: part });
    }
  }

  if (results.length <= 1) return null;
  return results;
}
