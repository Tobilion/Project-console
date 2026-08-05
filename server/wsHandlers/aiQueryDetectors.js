/**
 * Detectors for the two confirmed-live "model didn't actually call a tool" failure modes
 * (Phase 14 split of aiQuery.js, 2026-08-05 — bodies moved verbatim). Both are deliberately
 * narrow so they can't fire on ordinary short answers.
 */

/**
 * Detects a model narrating an intention to call a tool ("We need to call getGitStatus.") without
 * actually emitting a `<tool_call>{...}</tool_call>` block — `streamWithToolDetection` has nothing
 * to intercept in that case, so the narration would otherwise silently become the "final answer"
 * with no tool ever running and no error surfaced. Confirmed live 2026-07-29 via a real exported
 * transcript: qwen3.5:cloud did this three times in a row for "push this code to github" (each
 * reply along the lines of "We need to call getGitStatus." / "...We output tool call.") — nothing
 * ever got pushed, and there was no signal to the user that the request had silently failed,
 * until they gave up and turned AI mode off. Deliberately narrow (looks for explicit "narrating a
 * call" phrasing) so it doesn't fire on legitimate short answers that just happen to mention a
 * tool name in passing.
 */
export function looksLikeUnexecutedToolIntent(text) {
  if (!text || !text.trim()) return false;
  return /\b(?:we|i)\s+(?:need|should|must|will|have)\s+to\s+call\b/i.test(text)
    || (text.length < 200 && /\btool\s*call\b/i.test(text));
}

/**
 * Detects a reply that describes a completed mutating action (push/commit/deploy/write/delete/
 * install) in success language, checked against `toolHistory` — every tool ACTUALLY run anywhere
 * in this exchange, across every round. If that's empty, nothing real happened, so a reply that
 * still claims one of these actions succeeded is fabricated.
 *
 * Confirmed live 2026-07-29 via a real exported transcript: asked to "push", the model skipped
 * straight to "That **pushed successfully** ✅" with a fabricated-looking list of commit hashes —
 * no `<tool_call>` block, and no narrated intention either (so `looksLikeUnexecutedToolIntent`
 * above wouldn't have caught this one — there was nothing to retry, the model just invented a
 * result outright). It even second-guessed itself two messages later ("let me actually verify
 * what's in the commits since I claimed to push but have no visibility into the contents"),
 * confirming after the fact that the success claim was never backed by a real action. This is a
 * more serious failure mode than narrating-without-calling: the user could easily believe a
 * destructive git operation happened when it didn't.
 */
export function looksLikeFabricatedActionClaim(text) {
  if (!text) return false;
  const actionVerbs = /\b(pushed|committed|deployed|deleted|installed|wrote|written|created|merged|reverted)\b/i;
  const successWords = /\b(successfully|success|done|complete[d]?|✅|now on (?:origin|main)|origin\/main)\b/i;
  return actionVerbs.test(text) && successWords.test(text);
}
