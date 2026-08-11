/**
 * Shared helpers for matcher.js's dispatch pipeline (Phase 7 split, 2026-08-04 — extracted
 * from matcher.js, logic unchanged): config-entry lookup, telemetry capture, no-match
 * suggestion chips, and the non-blocking "did you mean" computation.
 */
import { semanticMatcher } from './semanticMatcher.js';
import { logMatch } from './intentTelemetry.js';
import { BUILTIN_INTENTS, intentWorkspaceEligible } from './intentRegistry.js';
import { PURE_CHITCHAT_INTENTS, looksLikeRealRequest } from './intentTrust.js';

export function tryLookupEntry(projects, projectIndex, entryIndex, input) {
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

export function captureTelemetry(projectId, input, telemetry) {
  if (!telemetry) return null;
  return logMatch(projectId || 'unknown', {
    input,
    stages: telemetry.stages,
    winner: telemetry.winner,
    finalIntent: telemetry.finalIntent,
    finalConfidence: telemetry.finalConfidence,
  });
}

const FALLBACK_SUGGESTIONS = ['help', 'overview', 'what are the commands', 'project structure', 'git status', 'monitoring'];

/**
 * `project` is optional and used only for Phase 1 workspaceType filtering: in a 'general'
 * workspace, dev-only base-intent phrases (git/npm/run/diagnostics) are dropped from the
 * fuzzy suggestions; the canned FALLBACK_SUGGESTIONS fallback stays untouched so a totally
 * unrecognized input still offers the same list as before in every workspace type.
 */
export function getFallbackSuggestions(input, project = null) {
  const isExcluded = project?.workspaceType === 'general'
    ? (intent) => !intentWorkspaceEligible(intent, project.workspaceType)
    : null;
  const fuzzy = semanticMatcher.getSuggestions(input, 5, isExcluded);
  return fuzzy.length > 0 ? fuzzy : FALLBACK_SUGGESTIONS;
}

/**
 * Requested directly (2026-08-04): on total no-match, offer the single nearest intent as a
 * non-blocking "did you mean" chip when the embedding still strongly favors it (>= 0.45),
 * alongside the canned fallback chips. Never a blocking question, and never a
 * pure-chitchat intent for an input that looks like a real request (same trap as the
 * PURE_CHITCHAT_INTENTS guard above). Returns { intent, confidence } or null.
 * `project` gates dev-only intents out of 'general' workspaces' did-you-mean chips (Phase 1).
 */
export async function computeDidYouMean(input, project = null) {
  try {
    const nearest = await semanticMatcher.nearestIntent(input);
    if (
      nearest &&
      nearest.confidence >= 0.45 &&
      BUILTIN_INTENTS.has(nearest.intent) &&
      intentWorkspaceEligible(nearest.intent, project?.workspaceType) &&
      !(looksLikeRealRequest(input) && PURE_CHITCHAT_INTENTS.has(nearest.intent))
    ) {
      return { intent: nearest.intent, confidence: nearest.confidence };
    }
  } catch {
    return null;
  }
  return null;
}
