import { semanticMatcher } from './semanticMatcher.js';
import { nlpEngine } from './nlpEngine.js';
import { logMatch, getEffectiveThreshold } from './intentTelemetry.js';
import { metrics } from './metrics.js';

const BUILTIN_INTENTS = new Set([
  'system.chit_chat.greeting', 'system.chit_chat.status', 'system.chit_chat.gratitude',
  'system.chit_chat.clear', 'system.chit_chat.help', 'system.chit_chat.git_status',
  'system.chit_chat.explain_followup', 'system.chit_chat.undo', 'system.chit_chat.deploy',
  'system.chit_chat.yes_no',
  'project.knowledge.overview', 'project.knowledge.stack', 'project.knowledge.commands',
  'project.knowledge.gotchas', 'project.knowledge.architecture',
  'project.context.structure', 'project.context.languages', 'project.context.file_count',
  'project.context.entry_point', 'project.context.tech_preview',
  'project.context.tests', 'project.context.dependencies', 'project.context.config',
  'run_project',
  'git_push', 'git_commit', 'git_commit_push', 'git_add',
  'git_init', 'git_ignore_add', 'git_rm_cached', 'npm_install',
  'npm_build', 'npm_run', 'file_create', 'file_delete', 'project_scan',
  'git_log', 'git_branch', 'git_checkout', 'git_pull',
  'system.monitoring.metrics',
]);

const FALLBACK_SUGGESTIONS = ['help', 'overview', 'what are the commands', 'project structure', 'git status', 'monitoring'];

function getFallbackSuggestions(input) {
  const fuzzy = semanticMatcher.getSuggestions(input, 5);
  return fuzzy.length > 0 ? fuzzy : FALLBACK_SUGGESTIONS;
}

function tryLookupEntry(projects, projectIndex, entryIndex, input) {
  const project = projects?.[projectIndex];
  if (!project) return null;
  const cfg = project.config || project;
  const entry = cfg?.entries?.[entryIndex];
  if (!entry) return null;
  return {
    match: entry,
    matchedTrigger: input,
    suggestions: [],
  };
}

function captureTelemetry(projectId, input, telemetry) {
  if (!telemetry) return null;
  return logMatch(projectId || 'unknown', {
    input,
    stages: telemetry.stages,
    winner: telemetry.winner,
    finalIntent: telemetry.finalIntent,
    finalConfidence: telemetry.finalConfidence,
  });
}

/** Unified 3-stage matching pipeline:
 *  1. Semantic (embedding cosine similarity — highest confidence)
 *  2. NLP.js (trained classifier — legacy fallback)
 *  3. Fuzzy (Fuse.js suggestion — weakest, only for fallback text)
 */
export async function matchInput(input, project, projectIndex) {
  metrics.inc('matching.total');
  const t0 = Date.now();

  // 0. Check for multi-intent queries (split on conjunctions)
  const tMulti = Date.now();
  const multiResult = await semanticMatcher.matchMulti(input);
      metrics.observe('matching.stage.multi', Date.now() - tMulti);
      metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'multi_intent', duration: Date.now() - t0 });
  if (multiResult) {
    const items = [];
    const telemetryIds = [];
    for (const r of multiResult) {
      // Capture telemetry for each sub-intent
      const subTelemetry = semanticMatcher.getAndClearLastTelemetry();
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
      if (BUILTIN_INTENTS.has(semanticResult.intent)) {
        metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'semantic_builtin', duration: Date.now() - t0 });
        return {
          match: null,
          builtin: semanticResult.intent,
          suggestions: [],
          semanticConfidence: semanticResult.confidence,
          semanticSource: semanticResult.source,
          telemetryId,
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

    if (intent.startsWith('system.chit_chat.') || intent.startsWith('project.context.')) {
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
    if (canonMap[intent]) {
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

  // 3. Fuzzy fallback (lowest confidence — just for suggestion chips)
  metrics.observe('matching.total_time', Date.now() - t0);
  metrics.event({ type: 'match_result', input: input.slice(0, 80), outcome: 'fallback', duration: Date.now() - t0 });
  return {
    match: null,
    builtin: null,
    suggestions: getFallbackSuggestions(input),
    telemetryId,
  };
}
