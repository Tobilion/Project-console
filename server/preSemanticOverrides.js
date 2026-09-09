/**
 * Pre-semantic literal overrides — thin lookup over the pin data in
 * ./preSemanticOverridePins.js (B.1 split, 2026-09-09). The array lived here since the
 * Phase 5 extraction from semanticMatcher.js; only its home changed, not its content or
 * order (first match still wins). The single consumer is server/matcherMatch.js.
 */
import { PRE_SEMANTIC_OVERRIDES } from './preSemanticOverridePins.js';

export { PRE_SEMANTIC_OVERRIDES };

/**
 * Returns the first override whose pattern matches, or null. semanticMatcher.js's match()
 * returns the override's intent with a fixed 0.9 confidence when this hits.
 */
export function findPreSemanticOverride(inputStr) {
  for (const { intent, pattern } of PRE_SEMANTIC_OVERRIDES) {
    if (pattern.test(inputStr)) return { intent, pattern };
  }
  return null;
}
