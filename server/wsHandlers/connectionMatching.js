import crypto from 'crypto';
import { matchInput, describeIntent } from '../matcher.js';
import { resolveContext } from '../contextResolver.js';
import { injectContext } from '../contextInjector.js';
import { handleBuiltinIntent } from './builtinIntents.js';
import { handleMatchedEntry } from './matchedEntry.js';
import { guessCommand } from '../commandGuesser.js';
import { logNearMiss } from '../nearMissLogger.js';
import { patchMessageMeta } from '../conversationStore.js';
import { extractCommandLine } from '../typedCommand.js';
import { state, pendingConfirmations } from '../state.js';

/**
 * Compact matching transcript for one input (2026-08-24): which stage resolved it, at what
 * confidence, and what it would dispatch. Persisted onto the user message's `meta` (see
 * patchMessageMeta) so exported sessions show the routing that produced each answer —
 * pre-semantic overrides show as stage 'presemantic', embedding wins as 'semantic' (or
 * 'fuzzy'/'keyword' when the embedding tier's own fallbacks won), NLP as 'nlp', the local
 * model as 'router', config entries as 'config-entry', and so on.
 */
export function buildMatchInfo(matchResult, input, { guessed = null, viaContext = false } = {}) {
  if (matchResult.multi) {
    return {
      stage: 'multi',
      intents: matchResult.multi.map((m) => m.builtin || (m.match ? `${m.match.type || 'entry'}:${m.matchedTrigger || ''}` : null)).filter(Boolean),
      confidence: null,
    };
  }
  if (matchResult.disambiguate) {
    return { stage: 'disambiguate', intents: matchResult.disambiguate, confidence: null };
  }
  if (matchResult.builtin) {
    if (matchResult.routedByModel) {
      return { stage: 'router', intent: matchResult.builtin, confidence: matchResult.routerConfidence ?? null };
    }
    return {
      stage: matchResult.semanticSource || 'nlp',
      intent: matchResult.builtin,
      confidence: matchResult.semanticConfidence ?? null,
      closeSecond: matchResult.closeSecond?.intent || null,
    };
  }
  if (matchResult.match) {
    return {
      stage: matchResult.semanticSource || 'config-entry',
      intent: matchResult.match.type || 'entry',
      trigger: matchResult.matchedTrigger || null,
      confidence: matchResult.semanticConfidence ?? null,
    };
  }
  if (viaContext) return { stage: 'context', intent: null, confidence: null };
  if (guessed) return { stage: 'guess', command: guessed.command, confidence: null };
  return { stage: 'fallback', intent: null, confidence: null, didYouMean: matchResult.didYouMean?.intent || null };
}

/** Persists the matching transcript onto the just-appended user message, fire-and-forget. */
export function recordMatchInfo(sessionContext, input, matchResult, extra = {}) {
  if (!sessionContext?.lastUserMessageId || !sessionContext.currentSessionId) return;
  const info = buildMatchInfo(matchResult, input, extra);
  patchMessageMeta(sessionContext.currentSessionId, sessionContext.lastUserMessageId, { match: info })
    .catch(() => {});
}

// The main trigger-mode matching pipeline (handleExecute block O): matchInput → collision
// disambiguation → multi-intent → builtin (+did-you-mean) → config entry → conversation
// context carryover → command guess → fallback + suggestions. Always consumes the message.
export async function handleMatchingPipeline(ws, project, projectId, input, sessionContext) {
  const projectIndex = state.activeProjectsCache.findIndex((p) => p.id === projectId);
  // Router tier (matcher.js stage 4) reuses whatever model the user has selected for full AI
  // mode, if any — it works independently of the aiEnabled toggle (that flag only gates the
  // multi-turn tool-call loop in aiQuery.js) and falls back to its own default model if unset.
  const matchResult = await matchInput(input, project, projectIndex, { model: sessionContext.aiModel });
  recordMatchInfo(sessionContext, input, matchResult);

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
    recordMatchInfo(sessionContext, input, matchResult, { viaContext: true });
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
    recordMatchInfo(sessionContext, input, matchResult, { guessed });
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

/**
 * Dry-run / explain mode (2026-08-24, differentiation item): resolves what WOULD happen to
 * an input WITHOUT executing anything — no intent handler, no confirm card, no command.
 * Mirrors the real dispatch precedence (typed-command bypass → matchInput → guess) so the
 * explanation matches what a real send would do. Read-only by construction; answers with the
 * resolution and ends the turn. Driven by the execute payload's additive `dryRun: true` flag
 * (no new WS message type).
 */
export async function explainInput(ws, project, projectId, input, sessionContext) {
  // Typed-command bypass first — the same gate handleExecute applies before the pipeline.
  try {
    const direct = extractCommandLine(input, project);
    if (direct && direct.command) {
      ws.send(JSON.stringify({ type: 'answer', data: `Would run directly (typed-command bypass, no intent matching):\n\n\`${direct.command}\`` }));
      ws.send(JSON.stringify({ type: 'end' }));
      return;
    }
  } catch {
    // extraction is best-effort; fall through to matching
  }
  const projectIndex = state.activeProjectsCache.findIndex((p) => p.id === projectId);
  const matchResult = await matchInput(input, project, projectIndex, { model: sessionContext.aiModel });
  const info = buildMatchInfo(matchResult, input);
  const confidence = info.confidence !== null && info.confidence !== undefined ? ` (${Math.round(info.confidence * 100)}%)` : '';
  let lines = [`**Input:** \`${input}\``, `**Stage:** ${info.stage}${confidence}`];
  if (info.intent) lines.push(`**Intent:** \`${info.intent}\``);
  if (info.trigger) lines.push(`**Trigger:** \`${info.trigger}\``);
  if (info.command) lines.push(`**Would run:** \`${info.command}\``);
  if (info.closeSecond) lines.push(`*Near-tie second: \`${info.closeSecond}\` (did-you-mean chip would show)*`);
  if (info.didYouMean) lines.push(`*Did-you-mean candidate: \`${info.didYouMean}\`*`);
  if (matchResult.disambiguate) {
    lines.push(`Would ask which you meant:\n1. ${describeIntent(matchResult.disambiguate[0])}\n2. ${describeIntent(matchResult.disambiguate[1])}`);
  }
  if (matchResult.multi) {
    lines.push(`Would split into ${matchResult.multi.length} parts: ${matchResult.multi.map((m) => m.builtin || 'config entry').join(', ')}`);
  }
  lines.push(`\n_Dry run only — nothing was executed or confirmed._`);
  ws.send(JSON.stringify({ type: 'answer', data: lines.join('\n') }));
  ws.send(JSON.stringify({ type: 'end' }));
}
