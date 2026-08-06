import crypto from 'crypto';
import { matchInput, describeIntent } from '../matcher.js';
import { resolveContext } from '../contextResolver.js';
import { injectContext } from '../contextInjector.js';
import { handleBuiltinIntent } from './builtinIntents.js';
import { handleMatchedEntry } from './matchedEntry.js';
import { guessCommand } from '../commandGuesser.js';
import { logNearMiss } from '../nearMissLogger.js';
import { state, pendingConfirmations } from '../state.js';

// The main trigger-mode matching pipeline (handleExecute block O): matchInput → collision
// disambiguation → multi-intent → builtin (+did-you-mean) → config entry → conversation
// context carryover → command guess → fallback + suggestions. Always consumes the message.
export async function handleMatchingPipeline(ws, project, projectId, input, sessionContext) {
  const projectIndex = state.activeProjectsCache.findIndex((p) => p.id === projectId);
  // Router tier (matcher.js stage 4) reuses whatever model the user has selected for full AI
  // mode, if any — it works independently of the aiEnabled toggle (that flag only gates the
  // multi-turn tool-call loop in aiQuery.js) and falls back to its own default model if unset.
  const matchResult = await matchInput(input, project, projectIndex, { model: sessionContext.aiModel });

  // A genuine collision (matcher.js/semanticMatcher.js — two different intents scoring nearly
  // identically) — ask which one was meant instead of guessing. See the pendingDisambiguation
  // reply handler above for how the answer is consumed.
  if (matchResult.disambiguate) {
    const [a, b] = matchResult.disambiguate;
    sessionContext.pendingDisambiguation = { projectId, candidates: [a, b], originalInput: input };
    ws.send(JSON.stringify({
      type: 'answer',
      data: `Not sure which you meant:\n1. ${describeIntent(a)}\n2. ${describeIntent(b)}\n\nReply with "1" or "2" — or say "neither" if it's something else.\n`,
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  if (matchResult.routedByModel) {
    // Observability parity with the 'guess'/'fallback' near-miss sources already logged below —
    // lets `review learning` surface phrasings the fast pipeline is missing so they can be
    // promoted into real examples later, same as any other near-miss.
    logNearMiss(project.id, {
      input,
      resolvedCommand: null,
      description: `router -> ${matchResult.builtin} (${matchResult.routerConfidence})`,
      source: 'router',
      intentSuggestion: matchResult.builtin,
      telemetryEntryId: matchResult.telemetryId || undefined,
    });
  }

  const isMatched = !!(matchResult.multi || matchResult.builtin || matchResult.match);
  sessionContext.conversationHistory.push({
    input,
    matched: isMatched,
    intent: matchResult.builtin || null,
    entry: matchResult.match || null,
    projectId,
  });
  if (sessionContext.conversationHistory.length > 5) {
    sessionContext.conversationHistory.shift();
  }

  // 0. Multi-intent queries (e.g. "show structure and run tests")
  if (matchResult.multi) {
    for (const item of matchResult.multi) {
      if (item.builtin) {
        await handleBuiltinIntent(ws, item.builtin, input, project, sessionContext);
      } else if (item.match) {
        await handleMatchedEntry(ws, item.match, input, item.matchedTrigger, project, sessionContext);
      }
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // 1. Builtin conversational intents
  if (matchResult.builtin) {
    await handleBuiltinIntent(ws, matchResult.builtin, input, project, sessionContext);
    if (matchResult.closeSecond) {
      // Requested directly (2026-08-04): a non-blocking "did you mean" chip when a different
      // intent scored within the near-tie band (margin 0.03-0.10) of the winner.
      ws.send(JSON.stringify({
        type: 'did_you_mean',
        data: { ...matchResult.closeSecond, label: describeIntent(matchResult.closeSecond.intent) },
      }));
    }
    if (matchResult.builtin !== 'system.chit_chat.git_status') {
      ws.send(JSON.stringify({ type: 'end' }));
    }
    return;
  }

  // 2. Matched triggers
  if (matchResult.match) {
    await handleMatchedEntry(ws, matchResult.match, input, matchResult.matchedTrigger, project, sessionContext);
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // 3. No match — try conversation context carryover before giving up
  const ctxResult = resolveContext(input, sessionContext.conversationHistory);
  if (ctxResult) {
    sessionContext.conversationHistory.push({
      input,
      matched: true,
      intent: ctxResult.builtin || null,
      entry: null,
      projectId,
    });
    if (sessionContext.conversationHistory.length > 5) {
      sessionContext.conversationHistory.shift();
    }
    await handleBuiltinIntent(ws, ctxResult.builtin, input, project, sessionContext);
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // 4. Best-guess command fallback — no intent or context matched, but maybe we can
  // infer a shell command from the phrasing (e.g. "remove node_modules from git").
  const guessed = guessCommand(input);
  if (guessed) {
    const nearMissId = logNearMiss(project.id, {
      input,
      resolvedCommand: guessed.command,
      description: guessed.description,
      source: 'guess',
      telemetryEntryId: matchResult.telemetryId || undefined,
    });
    const token = crypto.randomUUID();
    pendingConfirmations.set(token, {
      owner: ws,
      projectId: project.id,
      command: guessed.command,
      trigger: input,
      createdAt: Date.now(),
      nearMissId,
      telemetryEntryId: matchResult.telemetryId || undefined,
    });
    ws.send(JSON.stringify({
      type: 'confirm_prompt', token,
      command: `${guessed.command}  (${guessed.description})`,
      trigger: 'guessed'
    }));
    return;
  }

  // 5. No match at all: always send the informative fallback text, then attach suggestion
  // chips to it if we have any (getFallbackSuggestions in matcher.js means we almost always
  // do). Suggestions must ride on a preceding 'answer' — the frontend attaches the chip list
  // to the last chat bubble, so sending 'suggestions' with no bubble to attach to is a no-op.
  logNearMiss(project.id, {
    input,
    resolvedCommand: null,
    description: null,
    source: 'fallback',
    telemetryEntryId: matchResult.telemetryId || undefined,
  });
  const idx = project.codebaseIndex;
  let fallback = `I don't have a command configured for that in **[${project.name}]**.\n\n`;
  if (idx) {
    if (idx.entryPoints?.length) fallback += `**Entry point:** \`${idx.entryPoints[0]}\`\n`;
    if (idx.languages?.length) fallback += `**Languages:** ${idx.languages.slice(0, 3).join(', ')}\n`;
    if (idx.hasTests) fallback += '✓ Tests detected — try asking about tests\n';
    if (idx.hasConfig) fallback += '⚙ Config files present — try "overview" or "stack"\n';
  }
  const ctxFb = injectContext(input, null, project.codebaseIndex);
  if (ctxFb) fallback += `\n${ctxFb}\n`;
  fallback += `\nTry **"help"** for available triggers, **"overview"** for project summary, or **"structure"** to explore directories.`;
  ws.send(JSON.stringify({ type: 'answer', data: fallback }));
  if (matchResult.didYouMean) {
    // Requested directly (2026-08-04): no-match inputs with a strongly favored nearest intent
    // get a non-blocking "did you mean" chip alongside the canned suggestions.
    ws.send(JSON.stringify({
      type: 'did_you_mean',
      data: { ...matchResult.didYouMean, label: describeIntent(matchResult.didYouMean.intent) },
    }));
  }
  if (matchResult.suggestions && matchResult.suggestions.length > 0) {
    ws.send(JSON.stringify({ type: 'suggestions', data: matchResult.suggestions }));
  }
  ws.send(JSON.stringify({ type: 'end' }));
}
