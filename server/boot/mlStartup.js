import { retrainConfidenceModel } from '../confidenceModel.js';
import { autoApplyThresholdsForAll } from '../intentTelemetry.js';
import { autoApplySuggestionsForAll } from '../learningEngine.js';
import { log } from '../logger.js';

/**
 * Stage 1 ML work at boot: retrain the confidence model, auto-apply telemetry threshold
 * adjustments, and auto-promote high-confidence near-miss patterns. All three are fire-and-
 * forget with non-fatal error handling — a failed startup step is logged and skipped, never
 * fatal (read-only data/, disk-full, etc.).
 */
export async function runMlStartupWork() {
  // Retrain the learned confidence model from every project's accept/reject telemetry before
  // the threshold auto-apply sweep runs, so the sweep uses the freshest learned floor
  // (see confidenceModel.js / intentTelemetry.js's suggestThresholds()) rather than whatever
  // was cached from the last server run. Below MIN_LABELED examples this is a fast no-op
  // and the sweep falls back to the original heuristic.
  try {
    const modelResult = retrainConfidenceModel();
    if (modelResult.trained) {
      log.info(`Confidence model retrained from ${modelResult.sampleCount} labeled outcomes.`);
    }
  } catch (err) {
    log.error('Confidence model retrain failed (non-fatal):', err.message);
  }

  // Auto-apply telemetry-based threshold adjustments on startup.
  try {
    const autoResults = autoApplyThresholdsForAll();
    if (autoResults.length > 0) {
      log.info(`Auto-applied threshold adjustments for ${autoResults.length} project(s):`);
      for (const r of autoResults) {
        log.info(`  ${r.projectId}: ${r.applied} adjustment(s)`);
      }
    }
  } catch (err) {
    log.error('Auto-apply threshold adjustments failed (non-fatal):', err.message);
  }

  // Auto-promote high-confidence near-miss patterns (5+ occurrences, >=80% acceptance) into
  // real intent examples on startup, instead of requiring a manual `review learning` +
  // `approve suggestions` round trip.
  try {
    const learningResults = await autoApplySuggestionsForAll();
    if (learningResults.length > 0) {
      log.info(`Auto-applied near-miss learning for ${learningResults.length} project(s):`);
      for (const r of learningResults) {
        log.info(`  ${r.projectId}: ${r.applied}/${r.total} suggestion(s) promoted`);
      }
    }
  } catch (err) {
    log.error('Auto-apply near-miss learning failed (non-fatal):', err.message);
  }
}
