// Phase 3 decomposition leaf: conjunction-splitting + multi-intent matching for
// SemanticMatcher (extracted verbatim from semanticMatcher.js — see that file's
// matchMulti / _splitConjunctions for the originals).
import { PURE_CHITCHAT_INTENTS } from './intentTrust.js';

/**
 * Splits an input on common conjunctions. Confirmed live 2026-07-29: `push this code with
 * comment "Massive Memory and Learning improvements"` has "and" sitting right inside a quoted
 * commit message that was never meant to be split at all.
 *
 * REFINED 2026-09-08 (A-15): the original fix bailed on splitting entirely whenever the input
 * contained ANY quote character anywhere, even when every actual conjunction separator sits
 * outside the quoted span — so "open the site and measure network at 3" would never have hit
 * this problem (no quotes at all), but a phrase like `run tests and commit with message "fix
 * bug"` also lost its legitimate split even though the "and" is nowhere near the quotes.
 * Now: quoted spans are located first, and a separator is only treated as a real split point
 * when it falls OUTSIDE all of them — `comment "Massive Memory and Learning improvements"`
 * still refuses to split (its only "and" is inside the quotes), while `run tests and commit
 * with message "fix bug"` splits on the first "and" and leaves the quoted text intact in
 * whichever part it landed in.
 */
export function splitConjunctions(input) {
  const quoteSpans = [];
  const quoteRe = /"[^"]*"|'[^']*'/g;
  let qm;
  while ((qm = quoteRe.exec(input))) {
    quoteSpans.push([qm.index, qm.index + qm[0].length]);
  }
  const insideQuote = (idx) => quoteSpans.some(([s, e]) => idx >= s && idx < e);

  // Phase 2 audit (2026-08-12): the File Tools panel sends explicit file lists after a
  // colon ("tidy this folder: pic.jpg, doc.pdf", "delete duplicates, keep newest: a.txt")
  // — the commas there are list separators, not conjunction splits, and chopping them
  // produces a bogus multi-intent (tidy + file_find). Skip splitting whenever a colon
  // introduces the comma-separated tail, same "don't cut a structured value in half"
  // reasoning as the quote guard above.
  if (/:\s*[\w.,\s/-]+$/.test(input)) return null;

  // Split on common conjunctions (non-capturing groups to avoid split artifacts), but only at
  // occurrences outside any quoted span.
  const separators = /\s+(?:and|also|then|plus)\s+|,\s*|;\s*|\s+&\s+|\s+as well as\s+/gi;
  const cuts = [];
  let m;
  while ((m = separators.exec(input))) {
    if (!insideQuote(m.index)) cuts.push([m.index, m.index + m[0].length]);
  }
  if (cuts.length === 0) return null;

  const parts = [];
  let last = 0;
  for (const [s, e] of cuts) {
    parts.push(input.slice(last, s));
    last = e;
  }
  parts.push(input.slice(last));

  const trimmed = parts.map(s => s.trim()).filter(s => s && s.length > 3);
  return trimmed.length > 1 ? trimmed : null;
}

/** Matches each conjunction-split part through the matcher; null unless 2+ distinct intents. */
export async function matchMultiParts(matcher, input) {
  const parts = splitConjunctions(input);
  if (!parts) return null;

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

  // 2026-08-26 live batch crosscheck, REFINED 2026-09-08 (A-15 live bug report): "commit and
  // push" split into [git_status, deploy] — the parts matched wrong intents ("commit"
  // prefix-matches git_status's "commit history" example; bare "push" lands on deploy by
  // design), dispatching a status check + a push confirm instead of the single
  // git_commit_push flow. The original fix bailed out of ANY split whenever the WHOLE phrase
  // matched one intent confidently (semantic stage only), on the theory that a confident
  // whole-phrase match means "the user said one thing, not two."
  //
  // That theory over-suppressed a different, equally real case (live report 2026-09-08):
  // "open the site and measure network at 3" — the whole phrase confidently matches
  // serve_site (it's the strongest signal in the sentence) while the "measure network at 3"
  // clause's tokens get semantically absorbed/ignored rather than genuinely combined into one
  // action. That's NOT a single combined intent the way "commit and push" -> git_commit_push
  // is (a real, dedicated intent whose whole meaning covers BOTH clauses) — it's the matcher
  // fixating on one clause and silently dropping the other, exactly the failure this function
  // exists to catch. Confirming a serve-site chip while the network-watch clause vanished
  // with zero acknowledgment was the reported symptom.
  //
  // The distinguishing signal: for "commit and push", the whole's winning intent
  // (git_commit_push) is NOT among the intents either clause resolves to on its own
  // (git_status / deploy) — it's a genuinely distinct combined action. For the site+network
  // case, the whole's winning intent (serve_site) IS the same intent clause 1 resolves to by
  // itself — the "confident whole match" is really just clause 1 winning outright, and clause
  // 2's separate, equally valid intent should still be surfaced. So: only suppress the split
  // when the whole's intent is absent from the parts' own intent set. The 0.75 floor and
  // PURE_CHITCHAT_INTENTS carve-out ("hi and thanks" still answers twice) are unchanged.
  const whole = await matcher.match(input);
  if (
    whole &&
    whole.source === 'semantic' &&
    whole.confidence >= 0.75 &&
    !PURE_CHITCHAT_INTENTS.has(whole.intent) &&
    !seenIntents.has(whole.intent)
  ) {
    return null;
  }

  return results;
}
