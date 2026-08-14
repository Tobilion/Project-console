/**
 * matchInput() — the unified trigger-mode dispatch pipeline (Phase 7 split, 2026-08-04:
 * the dispatch registry — BUILTIN_INTENTS / CONFIG_RUN_ENTRY_FLOOR / OPEN_PROJECT_RE /
 * ROUTER_REPO_MAP_CHARS / describeIntent — lives in intentRegistry.js, the trust guards in
 * intentTrust.js, and the shared helpers in matchHelpers.js; this file is the pipeline only,
 * logic unchanged). Stages:
 *  0. Multi-intent split (conjunctions)
 *  1. Semantic (embedding cosine similarity — highest confidence), 1a config-entry + 1b builtin
 *  2. NLP.js (trained classifier — legacy fallback)
 *  4. Local router tier (bounded local-model classification)
 *  5. Fuzzy fallback (Fuse.js suggestion chips + non-blocking "did you mean")
 */
import { semanticMatcher } from './semanticMatcher.js';
import { nlpEngine } from './nlpEngine.js';
import { getEffectiveThreshold } from './intentTelemetry.js';
import { metrics } from './metrics.js';
import { routeViaLocalModel } from './localRouter.js';
import { formatRepoMap } from './codebaseIndexer.js';
import { BUILTIN_INTENTS, CONFIG_RUN_ENTRY_FLOOR, OPEN_PROJECT_RE, ROUTER_REPO_MAP_CHARS, intentWorkspaceEligible } from './intentRegistry.js';
import { PURE_CHITCHAT_INTENTS, isTrustworthyChitChat, isTrustworthyKnowledgeIntent, looksLikeRealRequest } from './intentTrust.js';
import { tryLookupEntry, captureTelemetry, getFallbackSuggestions, computeDidYouMean } from './matchHelpers.js';

// Re-exported so existing external importers keep working unchanged: connection.js imports
// describeIntent + getFallbackSuggestions, localRouter.js imports BUILTIN_INTENTS (its
// allowed-intent list must stay drawn from exactly the set that gates dispatch).
export { describeIntent, BUILTIN_INTENTS } from './intentRegistry.js';
export { getFallbackSuggestions } from './matchHelpers.js';

/** Unified 3-stage matching pipeline:
 *  1. Semantic (embedding cosine similarity — highest confidence)
 *  2. NLP.js (trained classifier — legacy fallback)
 *  3. Fuzzy (Fuse.js suggestion — weakest, only for fallback text)
 */
export async function matchInput(input, project, projectIndex, options = {}) {
  metrics.inc('matching.total');
  const t0 = Date.now();

  // Matchday-Exchange live session (2026-08-14): "What as time\" — a stray trailing backslash
  // from a phone keyboard — drifted onto git_status and executed a command. Strip trailing
  // punctuation/junk before ANY stage so every tier (multi-split, pre-semantic overrides,
  // embeddings, NLP, fuzzy) sees the cleaned phrase. Only the END of the string is touched:
  // paths ("C:\Users\..."), "note: buy milk" (the colon is mid-string, and a bare "note:"
  // must keep its colon for the notes override), and command lines (which bypass the matcher
  // via typedCommand.js anyway) are unaffected. Quotes are deliberately NOT stripped — they
  // close comment strings ("push the site with comment \"x\"") and removing them shifts the
  // embedding just enough to flip closeSecond markers on git/deploy rows (measured in the
  // harness).
  input = input.replace(/(?:[?!.,;)\]}]+|\\+)$/g, '');

  // 0. Check for multi-intent queries (split on conjunctions)
  const tMulti = Date.now();
  const multiResult = await semanticMatcher.matchMulti(input);
      metrics.observe('matching.stage.multi', Date.now() - tMulti);
      metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'multi_intent', duration: Date.now() - t0 });
  if (multiResult) {
    const items = [];
    const telemetryIds = [];
    for (const r of multiResult) {
      // Telemetry for each sub-intent is captured by matchMultiParts() (matcherMulti.js) at the
      // moment each part is matched and carried on the result as `r.telemetry` — NOT re-read
      // here via getAndClearLastTelemetry(). That singleton field gets overwritten by every
      // subsequent part's match() call, so polling it in this loop (the old approach) only ever
      // returned the last part's telemetry once and null for every other part (audit
      // 2026-08-10 — silently lost training data for every compound command).
      const subTelemetry = r.telemetry;
      if (subTelemetry) {
        const tid = captureTelemetry(project?.id, r.originalPhrase || input, subTelemetry);
        if (tid) telemetryIds.push(tid);
      }
      if (r.meta) {
        const entryResult = tryLookupEntry([project], r.meta.projectIndex, r.meta.entryIndex, r.originalPhrase);
        if (entryResult) {
          items.push({ ...entryResult, source: r.source, confidence: r.confidence });
          continue;
        }
      }
      if (BUILTIN_INTENTS.has(r.intent)) {
        items.push({
          match: null,
          builtin: r.intent,
          suggestions: [],
          semanticConfidence: r.confidence,
          semanticSource: r.source,
        });
      }
    }
    if (items.length > 1) {
      return { multi: items, telemetryId: telemetryIds.length > 0 ? telemetryIds[0] : null };
    }
  }

  // 1. Semantic (highest confidence — embedding cosine similarity)
  const tSemantic = Date.now();
  const semanticResult = await semanticMatcher.match(input);
  metrics.observe('matching.stage.semantic', Date.now() - tSemantic);
  let telemetryId = null;

  if (semanticResult) {
    telemetryId = captureTelemetry(project?.id, input, semanticMatcher.getAndClearLastTelemetry());
    // semanticMatcher.match() internally runs 3 sub-stages (semantic -> fuzzy -> keyword) and
    // each fuzzy/keyword result is already self-gated against its own floor before being
    // returned (see semanticMatcher.js). Only re-apply the semantic embedding floor to results
    // that actually came from the semantic stage — otherwise every keyword-tier match (always
    // 0.4-0.55 confidence by design) gets silently discarded by the semantic default floor
    // (0.6) and the keyword fallback list can never win a match.
    const passesGate = semanticResult.source === 'semantic'
      ? semanticResult.confidence >= getEffectiveThreshold(semanticResult.intent)
      : true;
    if (passesGate) {
      // 1a. Project-specific entry match
      if (semanticResult.meta) {
        const entryResult = tryLookupEntry(
          [project],
          semanticResult.meta.projectIndex,
          semanticResult.meta.entryIndex,
          input
        );
        if (entryResult) {
          metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'semantic_entry', duration: Date.now() - t0 });
          return { ...entryResult, telemetryId };
        }
      }
      // 1b. Builtin intent match
      if (
        BUILTIN_INTENTS.has(semanticResult.intent) &&
        isTrustworthyChitChat(semanticResult.intent, input) &&
        isTrustworthyKnowledgeIntent(semanticResult.intent, input)
      ) {
        // Phase 3 (2026-08-03, NetPulse transcript): a project's own config command entries
        // lose to the huge run_project / npm_run phrase clusters in the embedding race, so a
        // "run the site and watch at interval of 5 minutes" never reached the project's own
        // `watch --interval {interval}` entry. When the winner is a generic run-family builtin,
        // give the project's own `command`-type entries a separate chance above their own floor;
        // dispatch through the exact same config-entry path as stage 1a (safety checks and the
        // parameterized-command ask live in handleMatchedEntry / runCommandEntry, unchanged).
        if ((semanticResult.intent === 'run_project' || semanticResult.intent === 'npm_run') && !OPEN_PROJECT_RE.test(input)) {
          const projEntry = await semanticMatcher.bestProjectCommandEntry(input, projectIndex);
          if (projEntry && projEntry.score >= CONFIG_RUN_ENTRY_FLOOR) {
            const entryResult = tryLookupEntry([project], 0, projEntry.entryIndex, input);
            if (entryResult) {
              metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'config_run_entry', duration: Date.now() - t0 });
              return { ...entryResult, telemetryId };
            }
          }
        }
        // Requested directly (2026-07-30): rather than silently guessing on a true collision
        // (two different intents scoring nearly identically — semanticMatcher.js's `collision`
        // field, computed only for genuine cross-intent ties, not multiple phrasings of the same
        // winning intent), ask which one was meant instead of picking one. Scoped deliberately
        // narrow per the user's own choice: only fires when both candidates are real builtin
        // intents and neither is a pure-chitchat/knowledge intent the input doesn't actually look
        // like (same trust guards as the winner itself) — an ordinary confident match is
        // completely unaffected.
        if (
          semanticResult.collision &&
          BUILTIN_INTENTS.has(semanticResult.collision.intent) &&
          isTrustworthyChitChat(semanticResult.collision.intent, input) &&
          isTrustworthyKnowledgeIntent(semanticResult.collision.intent, input)
        ) {
          metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'disambiguate', duration: Date.now() - t0 });
          return {
            match: null,
            builtin: null,
            disambiguate: [semanticResult.intent, semanticResult.collision.intent],
            suggestions: [],
            telemetryId,
          };
        }
        metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'semantic_builtin', duration: Date.now() - t0 });
        // Requested directly (2026-08-04): a near-tie (margin 0.03-0.10) that isn't ambiguous
        // enough to block on (that's the collision question above) surfaces as a non-blocking
        // "did you mean" chip on the answer. Same dispatchability + trust guards as the winner,
        // plus the Phase 1 workspaceType gate so a 'general' workspace never suggests a
        // dev-only intent. Matching itself is unaffected — this only hides the chip.
        const closeSecond = semanticResult.closeSecond &&
          BUILTIN_INTENTS.has(semanticResult.closeSecond.intent) &&
          intentWorkspaceEligible(semanticResult.closeSecond.intent, project?.workspaceType) &&
          isTrustworthyChitChat(semanticResult.closeSecond.intent, input) &&
          isTrustworthyKnowledgeIntent(semanticResult.closeSecond.intent, input)
          ? { intent: semanticResult.closeSecond.intent, confidence: semanticResult.closeSecond.confidence }
          : null;
        return {
          match: null,
          builtin: semanticResult.intent,
          suggestions: [],
          semanticConfidence: semanticResult.confidence,
          semanticSource: semanticResult.source,
          telemetryId,
          closeSecond,
        };
      }
    }
  }

  // 2. NLP.js (trained classifier fallback)
  const tNlp = Date.now();
  const nlpResult = await nlpEngine.classify(input);
  metrics.observe('matching.stage.nlp', Date.now() - tNlp);
  if (nlpResult && nlpResult.score >= 0.45) {
    const intent = nlpResult.intent;

    if ((intent.startsWith('system.chit_chat.') || intent.startsWith('project.context.')) && isTrustworthyChitChat(intent, input)) {
      metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'nlp_builtin', duration: Date.now() - t0 });
      return { match: null, builtin: intent, suggestions: [], telemetryId };
    }

    const canonMap = {
      'project.knowledge.overview': 'project.knowledge.overview',
      'project.knowledge.stack': 'project.knowledge.stack',
      'project.knowledge.commands': 'project.knowledge.commands',
      'project.knowledge.gotchas': 'project.knowledge.gotchas',
      'project.knowledge.architecture': 'project.knowledge.architecture',
    };
    if (canonMap[intent] && isTrustworthyKnowledgeIntent(intent, input)) {
      return { match: null, builtin: canonMap[intent], suggestions: [], telemetryId };
    }

    if (intent.startsWith('project.action.') || intent.startsWith('project.knowledge.')) {
      const parts = intent.split('.');
      const pIndex = parseInt(parts[2], 10);
      const eIndex = parseInt(parts[3], 10);
      if (pIndex === projectIndex) {
        const cfg = project?.config || project;
        if (cfg && cfg.entries && cfg.entries[eIndex]) {
          return { match: cfg.entries[eIndex], matchedTrigger: input, suggestions: [], telemetryId };
        }
      }
    }
  }

  // 4. Local router tier — one bounded local-model call for phrasings the embedding/NLP/fuzzy
  // stages above didn't confidently resolve, before giving up and falling to commandGuesser's
  // naive regex guess (in connection.js) / the plain suggestion-chip fallback below. Additive
  // only: any failure, timeout, or low-confidence result from routeViaLocalModel() returns null
  // and execution falls straight through to exactly the same fallback as before this tier
  // existed — Ollama being off or slow causes zero behavior change to trigger mode.
  const tRouter = Date.now();
  let routerResult = null;
  try {
    // Same defense-in-depth as the semantic/nlp guards above: don't even offer the router a
    // pure-chitchat intent when the input looks like a real request (filename/quote present).
    // A weak local model is exactly as prone to defaulting to a "safe sounding" reply as
    // nlpEngine's trained classifier was — no reason to trust it more here.
    const routerAllowedIntents = looksLikeRealRequest(input)
      ? [...BUILTIN_INTENTS].filter((i) => !PURE_CHITCHAT_INTENTS.has(i))
      : [...BUILTIN_INTENTS];
    routerResult = await routeViaLocalModel(input, {
      model: options.model,
      allowedIntents: routerAllowedIntents,
      repoMapSlice: formatRepoMap(project?.codebaseIndex?.repoMap, ROUTER_REPO_MAP_CHARS) || undefined,
    });
  } catch {
    routerResult = null;
  }
  metrics.observe('matching.stage.router', Date.now() - tRouter);
  if (routerResult) {
    metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'router', duration: Date.now() - t0 });
    return {
      match: null,
      builtin: routerResult.intent,
      suggestions: [],
      telemetryId,
      routedByModel: true,
      routerConfidence: routerResult.confidence,
    };
  }

  // 5. Fuzzy fallback (lowest confidence — just for suggestion chips)
  metrics.observe('matching.total_time', Date.now() - t0);
  metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'fallback', duration: Date.now() - t0 });

  let didYouMean = null;
  try {
    didYouMean = await computeDidYouMean(input, project);
  } catch {
    didYouMean = null;
  }

  return {
    match: null,
    builtin: null,
    suggestions: getFallbackSuggestions(input, project),
    telemetryId,
    didYouMean,
  };
}
