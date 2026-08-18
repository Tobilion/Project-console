/**
 * Trust guards for matcher.js's dispatch gates (Phase 7 split, 2026-08-04 — extracted from
 * matcher.js, logic unchanged). A stage may report a confident-looking intent, but some
 * intents are zero-argument, always-safe-sounding canned replies that a weak classifier
 * (NLP.js stage, or the local router) easily defaults to on out-of-distribution input —
 * these guards decide whether the reported intent is trustworthy enough to dispatch.
 */
// Confirmed live 2026-07-29: a garbled file-creation follow-up ("Call it jimmyjagz.md with tex
// :- \"") landed on system.chit_chat.gratitude — twice, across two different malformed inputs,
// neither containing anything resembling thanks. Both are zero-argument, always-safe-sounding
// canned replies with no real semantic bar to clear once *any* stage claims a confident-looking
// match, which is exactly the failure mode a weak/out-of-distribution classifier falls into
// (nlpEngine's trained classifier, stage 2 in matcher.js, is the most likely source — it's the
// pipeline's own documented "legacy fallback", gated only by a flat score >= 0.45 with no margin
// check, unlike the semantic stage's floor+margin gate). A message that names a file (has an
// extension) or contains an explicit quote is essentially never small talk in this app's domain,
// so treat a pure-chitchat result as untrustworthy — not a match at all — when either signal is
// present, letting the input fall through to the next stage instead of returning a
// wrong-but-harmless-looking answer. Narrower and cheaper than trying to fix the underlying
// classifier.
export const PURE_CHITCHAT_INTENTS = new Set([
  'system.chit_chat.greeting', 'system.chit_chat.status', 'system.chit_chat.gratitude',
  'system.chit_chat.clear', 'system.chit_chat.yes_no',
  // Added alongside these two new intents (2026-07-30) — same "zero-argument, always-safe-
  // sounding canned reply" shape as the four above, so a garbled real request could just as
  // easily misfire onto "goodbye" or "who are you" as it previously did onto "gratitude".
  'system.chit_chat.farewell', 'system.chit_chat.identity',
  // needs_ai_mode (2026-08-03, Phase 3 of the intent-expansion spec): same safe-sounding canned
  // reply as the rest of this set ("flip the AI toggle and ask again") — a garbled real request
  // could just as easily land here as on gratitude, so it gets the same guard. Registered in
  // BOTH this set and BUILTIN_INTENTS — this is the one intent that must be in both.
  'system.chit_chat.needs_ai_mode',
  // ack (2026-08-03, Phase 2.1): zero-argument, always-safe-sounding canned reply — same
  // garbled-input guard as the rest of this set.
  'system.chit_chat.ack',
  // joke (2026-08-03, Phase 2.3): zero-argument, deterministic jokes — same garbled-input guard.
  'system.chit_chat.joke',
  // Phase 0 (2026-08-10): time/date/calculate — zero-argument canned-shape answers with no real
  // semantic bar once any stage claims a match, exactly the thanks/gratitude failure mode this
  // set guards against. A garbled request must not land on "It's 4:32 PM".
  'system.chit_chat.time', 'system.chit_chat.date', 'system.chit_chat.calculate',
  // port (2026-08-17 audit): same zero-argument canned-shape answer as time/date — a garbled
  // real request must not land on "The console runs on port 3000". explain_followup likewise:
  // it's a canned "could you tell me more" reply, and its follow-up phrasing would be exactly
  // what a garbled continuation sounds like.
  'system.chit_chat.port', 'system.chit_chat.explain_followup',
]);

export function looksLikeRealRequest(input) {
  // Extension-ish pattern: a dot followed by at least one LETTER — ".md"/".tsx" read as file
  // names, but "8.25"/"64.50" (pure-digit decimals from the calculate grammar) must not, or
  // the Phase 6 percent/tax/tip shapes get blocked by the chit-chat guard below and fall
  // through to deploy (confirmed live 2026-08-12).
  return /\.[a-zA-Z][a-zA-Z0-9]{0,5}\b/.test(input) || /["']/.test(input);
}

export function isTrustworthyChitChat(intent, input) {
  return !(PURE_CHITCHAT_INTENTS.has(intent) && looksLikeRealRequest(input));
}

// Confirmed live 2026-07-30 (two separate transcripts, same exact failure): "who uses
// connection.js" landed on project.knowledge.stack ("### Tech Stack / No stack information
// parsed from markdown.") instead of project.context.file_relations. Root cause: the NLP.js
// classifier fallback in matcher.js is gated only by a flat score >= 0.45 with no margin check
// (the same documented weakness behind the gratitude/garbled-input bug that PURE_CHITCHAT_INTENTS
// fixes), but that guard only covers system.chit_chat.*/project.context.* — the
// project.knowledge.* canonMap right below it had zero real-request scrutiny at all. None of the
// five project.knowledge.* intents (overview/stack/commands/gotchas/architecture) are ever
// legitimately about one specific named file — a query naming a real filename is a strong signal
// the classifier picked the wrong bucket, so treat that combination as untrustworthy too and let
// the input fall through to the router/fallback stages instead of returning a wrong, unhelpful
// answer.
export const KNOWLEDGE_INTENTS_NEVER_ABOUT_A_FILE = new Set([
  'project.knowledge.overview', 'project.knowledge.stack', 'project.knowledge.commands',
  'project.knowledge.gotchas', 'project.knowledge.architecture',
]);

export function looksLikeFileReference(input) {
  // Same extension-ish rule as looksLikeRealRequest: dot + at least one letter.
  return /\.[a-zA-Z][a-zA-Z0-9]{0,5}\b/.test(input);
}

export function isTrustworthyKnowledgeIntent(intent, input) {
  return !(KNOWLEDGE_INTENTS_NEVER_ABOUT_A_FILE.has(intent) && looksLikeFileReference(input));
}
