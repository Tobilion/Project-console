// Phase 3 decomposition leaf: Fuse.js suggestion search for SemanticMatcher (extracted
// verbatim from semanticMatcher.js — see that file's getSuggestions for the original).

/**
 * Best-effort "did you mean" suggestions for when match() comes back empty. Reuses the
 * Fuse.js fuzzy index (built from both base-intent example phrases and project-specific
 * triggers) instead of the plain embedding search, since Fuse ranks by literal string
 * similarity — closer to what a human would guess caused the near-miss than cosine
 * similarity would be at this point (the input already failed the embedding pass).
 *
 * `isExcluded` (Phase 1 workspaceType filtering, 2026-08-11) lets callers drop base-intent
 * example phrases from a 'general' workspace's suggestions; project-specific triggers
 * (isProject) are never excluded — they're the user's own config, not dev-only by nature.
 */
export function searchFuseSuggestions(fuseIndex, input, limit = 5, isExcluded = null) {
  if (!fuseIndex || !input?.trim()) return [];
  const results = fuseIndex.search(input.trim().toLowerCase());
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const item = r.item;
    const text = item.text;
    if (seen.has(text)) continue;
    if (!item.isProject && isExcluded?.(item.intent)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}
