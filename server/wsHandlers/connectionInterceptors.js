import { extractParamValue, isSafeParamValue, substituteParams } from '../paramCommand.js';
import { getFallbackSuggestions } from '../matcher.js';
import { handleBuiltinIntent } from './builtinIntents.js';
import { runCommandEntry } from './matchedEntry.js';
import { addToClaudeMd } from '../projectMemory.js';
import { pendingMemorySuggestions } from './connectionState.js';
import { parseFileNameOnly } from './builtinHelpers.js';

// The four "this message is a reply to a pending question" interceptors from handleExecute —
// each returns true when it consumed the message. They must be called in this order (param,
// followUp, disambiguation early, memory-suggestion reply after the dev-server checks), since
// these messages were never meant to be re-matched against the normal intent pipeline.

export async function handlePendingParamReply(ws, project, projectId, input, sessionContext) {
  // A parameterized command entry (see paramCommand.js / matchedEntry.js) is waiting on a plain
  // follow-up answer for this project — e.g. it asked "what interval?" and this message is the
  // reply. Must be checked before anything else touches `input`, since this message was never
  // meant to be re-matched against the normal intent pipeline. No AI involved: this is what lets
  // parameterized trigger-mode commands work with AI mode off.
  if (!sessionContext.pendingParam || sessionContext.pendingParam.projectId !== projectId) {
    return false;
  }
  const pending = sessionContext.pendingParam;
  const lower = input.trim().toLowerCase();
  if (lower === 'cancel' || lower === 'nevermind' || lower === 'never mind') {
    sessionContext.pendingParam = null;
    ws.send(JSON.stringify({ type: 'answer', data: 'Cancelled.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  const param = pending.params.find((p) => p.name === pending.paramName);
  let extracted = extractParamValue(input, param?.pattern, { anchored: true });
  // Confirmed live 2026-07-29: this fallback used to accept ANY safe-looking text whenever
  // the pattern match failed — including when a pattern WAS defined and the reply just didn't
  // match it (e.g. asked "what interval?", user typed an unrelated new message instead of a
  // number). That silently substituted the wrong text into the command template — a real
  // NetPulse run produced "python main.py watch --interval run the network speed" and crashed
  // with an argparse error. The raw-text fallback should only apply when the entry never
  // defined a pattern at all (nothing to validate against); if a pattern exists and doesn't
  // match, that's a genuinely invalid answer and the user should be asked again.
  if (!extracted && !param?.pattern && isSafeParamValue(input.trim())) extracted = input.trim();
  if (!extracted || !isSafeParamValue(extracted)) {
    ws.send(JSON.stringify({ type: 'answer', data: `That doesn't look like a valid value. ${param?.prompt || 'Please try again.'} (or say "cancel" to drop this)\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  pending.values[pending.paramName] = extracted;
  const nextMissing = pending.params.find((p) => pending.values[p.name] === undefined);
  if (nextMissing) {
    pending.paramName = nextMissing.name;
    ws.send(JSON.stringify({ type: 'answer', data: nextMissing.prompt }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  sessionContext.pendingParam = null;
  const resolvedEntry = { ...pending.entry, action: substituteParams(pending.entry.action, pending.values) };
  await runCommandEntry(ws, resolvedEntry, input, pending.matchedTrigger, project, sessionContext);
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}

export async function handlePendingFollowUpReply(ws, project, projectId, input, sessionContext) {
  // A command entry that declared `followUp` (see matchedEntry.js) is waiting on a plain reply
  // for this project — e.g. "start netpulse" asked "also watch the network? reply with an
  // interval". A number starts the follow-up entry with that value substituted; "no" runs just
  // the original entry; "cancel" aborts nothing having started. Same interception point and
  // reason as pendingParam: this reply was never meant to be re-matched against the pipeline.
  if (!sessionContext.pendingFollowUp || sessionContext.pendingFollowUp.projectId !== projectId) {
    return false;
  }
  const pending = sessionContext.pendingFollowUp;
  const lower = input.trim().toLowerCase();
  if (/^(cancel|nevermind|never mind)\b/.test(lower)) {
    sessionContext.pendingFollowUp = null;
    ws.send(JSON.stringify({ type: 'answer', data: 'Cancelled — nothing was started.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (/^(no|nope|nah|not now|skip (?:it|the watch))\b/.test(lower)) {
    sessionContext.pendingFollowUp = null;
    await runCommandEntry(ws, pending.entry, input, pending.followUp.entry, project, sessionContext);
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  const param = pending.target.params.find((p) => p.name === pending.followUp.param);
  const extracted = extractParamValue(input, param?.pattern, { anchored: true });
  if (!extracted || !isSafeParamValue(extracted)) {
    ws.send(JSON.stringify({
      type: 'answer',
      data: `That doesn't look like a valid ${param?.name || 'value'} — try again (e.g. 15), "no" to skip it, or "cancel" to stop.\n`,
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  sessionContext.pendingFollowUp = null;
  const resolvedWatch = { ...pending.target, action: substituteParams(pending.target.action, { [pending.followUp.param]: extracted }) };
  await runCommandEntry(ws, pending.entry, input, pending.followUp.entry, project, sessionContext);
  await runCommandEntry(ws, resolvedWatch, input, pending.followUp.entry, project, sessionContext);
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}

export async function handlePendingDisambiguationReply(ws, project, projectId, input, sessionContext) {
  // Requested directly (2026-07-30): when matcher.js hits a genuine collision (two different
  // intents scoring nearly identically — see semanticMatcher.js's `collision` field), it asks
  // "did you mean X or Y?" instead of silently guessing. This is the reply to that question —
  // checked before the normal matching pipeline for the same reason pendingParam is above.
  if (!sessionContext.pendingDisambiguation || sessionContext.pendingDisambiguation.projectId !== projectId) {
    return false;
  }
  const pending = sessionContext.pendingDisambiguation;
  sessionContext.pendingDisambiguation = null;
  const lower = input.trim().toLowerCase();
  const REJECT_RE = /^(no|nope|neither|none|none of (those|these|the above)|not (that|those|it)|thats wrong|that'?s wrong|wrong|cancel|nevermind|never mind)\b/;
  if (REJECT_RE.test(lower)) {
    ws.send(JSON.stringify({
      type: 'answer',
      data: `No problem — here are some other things I can try:\n_Suggestions: ${getFallbackSuggestions(input, project).join(', ')}_\n`,
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  let chosen = null;
  if (/^(1|one|first|the first|a)\b/.test(lower)) chosen = pending.candidates[0];
  else if (/^(2|two|second|the second|b)\b/.test(lower)) chosen = pending.candidates[1];
  if (chosen) {
    await handleBuiltinIntent(ws, chosen, pending.originalInput, project, sessionContext);
    if (chosen !== 'system.chit_chat.git_status') {
      ws.send(JSON.stringify({ type: 'end' }));
    }
    return true;
  }
  // Anything else (not a clear pick, not a clear rejection) — the user probably just moved on
  // to a new, unrelated message rather than answering the question at all. Backtracking here
  // means treating it as a brand-new input through the normal pipeline rather than getting
  // stuck insisting on an answer to a question nobody's addressing anymore.
  return false;
}

export async function handlePendingFileQuestionReply(ws, project, projectId, input, sessionContext) {
  // "Which file?" follow-up for the file-relations / open-file handlers (Matchday-Exchange
  // live session, 2026-08-14): the handlers answered with a plain "Which file?" and no
  // pending state, so the user's next message ("app.tsx") re-matched and dead-ended in the
  // generic fallback. This interceptor picks up a filename reply and re-dispatches the
  // original intent with it — same interception point and rationale as pendingParam.
  const pending = sessionContext.pendingFileQuestion;
  if (!pending || pending.projectId !== projectId) return false;
  const lower = input.trim().toLowerCase();
  if (/^(cancel|nevermind|never mind|none|skip|dont|don't)\b/.test(lower)) {
    sessionContext.pendingFileQuestion = null;
    ws.send(JSON.stringify({ type: 'answer', data: 'Cancelled.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  const trimmed = input.trim();
  // A single bare token is treated as the filename; longer replies must actually contain a
  // parseable file mention ("show me the imports of app.tsx" works, "what is the time" does
  // not — that's a fresh question, not an answer).
  const hasFilename = !/\s/.test(trimmed) || !!parseFileNameOnly(trimmed);
  if (!hasFilename) {
    // The user moved on to a new, unrelated message — drop the pending question and let the
    // normal pipeline handle it (same backtracking rule as pendingDisambiguation).
    sessionContext.pendingFileQuestion = null;
    return false;
  }
  sessionContext.pendingFileQuestion = null;
  await handleBuiltinIntent(ws, pending.intent, trimmed, project, sessionContext);
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}

export async function handlePendingMemorySuggestionReply(ws, project, lowerInput) {
  // Check if the user is responding to a pending memory suggestion (saying yes/sure/ok)
  const pendingMemSuggestion = pendingMemorySuggestions.get(project.id);
  if (pendingMemSuggestion && /^(yes|sure|ok|yeah|yep|add it|go ahead|please|do it)/i.test(lowerInput)) {
    pendingMemorySuggestions.delete(project.id);
    const { topic, content } = pendingMemSuggestion;
    addToClaudeMd(project.path, topic, content || '');
    ws.send(JSON.stringify({ type: 'answer', data: `✓ Added "${topic}" section to CLAUDE.md. I'll remember this context in future conversations.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (pendingMemSuggestion && /^(no|nope|nah|skip|not now|cancel|dont|don't)/i.test(lowerInput)) {
    pendingMemorySuggestions.delete(project.id);
    ws.send(JSON.stringify({ type: 'answer', data: `OK, won't add "${pendingMemSuggestion.topic}" to CLAUDE.md.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  return false;
}
