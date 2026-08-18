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
    || (text.length < 200 && /\btool\s*call\b/i.test(text))
    // Corrective-retry promises (audit 2026-08-17): a model that just failed a tool call often
    // answers the follow-up turn with "let me actually fix that" / "let me retry the push"
    // and then produces plain text with NO <tool_call> block — the same announce-but-don't-call
    // failure class as "we need to call X", previously invisible to the corrective retry loop
    // (aiQuery.js). Fires only when the turn ended with zero executed tool calls, so a model
    // that DID call tools is never re-prompted.
    || /\blet\s+me\s+(?:actually\s+|properly\s+|try\s+to\s+)?(?:fix|retry|rerun|re-?run|push|execute|do)\b/i.test(text);
}

/**
 * Detects a reply that describes a completed mutating action (push/commit/deploy/write/delete/
 * install) in success language, checked against the tools ACTUALLY run in this exchange.
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
 *
 * The check is per-claim, not per-exchange: the old `toolHistory.length === 0` guard meant ONE
 * benign call anywhere (a readFile, a getGitStatus) disabled the detector entirely, so a model
 * that ran one harmless tool and then claimed "pushed successfully" streamed the lie with no
 * warning (audit 2026-08-17). Now the claimed action class is matched against the tools that
 * actually ran — executeCommand commands are inspected for a plausible verb (git push/commit,
 * npm install) rather than trusting the tool name alone.
 */
export function looksLikeFabricatedActionClaim(text, toolHistory = []) {
  if (!text) return false;
  const actionVerbs = /\b(pushed|committed|deployed|deleted|installed|wrote|written|created|merged|reverted)\b/i;
  const successWords = /\b(successfully|success|done|complete[d]?|✅|now on (?:origin|main)|origin\/main)\b/i;
  if (!(actionVerbs.test(text) && successWords.test(text))) return false;

  const execCommands = toolHistory.filter((t) => t?.tool === 'executeCommand').map((t) => t.args?.command || '');
  const joinedExec = execCommands.join('\n');
  const ranWrite = ['writeFile', 'editFile', 'insertAtLine', 'appendToFile'].some((t) => toolHistory.some((h) => h?.tool === t));

  const claimedPush = /\b(pushed|committed|deployed|merged|reverted)\b/i.test(text);
  const claimedWrite = /\b(wrote|written|created)\b/i.test(text);
  const claimedDelete = /\bdeleted\b/i.test(text);
  const claimedInstall = /\binstalled\b/i.test(text);

  const plausible = claimedPush
    ? /\bgit\s+(?:push|commit|merge|revert)\b|\b(?:npm|cargo|yarn|pnpm)\s+publish\b/i.test(joinedExec)
    : claimedInstall
      ? /\b(?:npm|yarn|pnpm|bun)\s+(?:install|add|i)\b/i.test(joinedExec)
      : claimedWrite
        ? ranWrite || /\b(?:echo\s*[>»]|cp\b|copy\b|mkdir\b|touch\b)/i.test(joinedExec)
        : claimedDelete
          ? /\b(?:rm\b|del\b|Remove-Item\b)/i.test(joinedExec)
          : true;

  return !plausible;
}
