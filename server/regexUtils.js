// Small shared regex helpers. Split out of contextResolver.js (Phase 1 modularization) so any
// other module doing word-boundary keyword matching gets the same semantics for free.

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Plain `\b` only fires at a transition between a word char (\w) and a non-word char — it never
// matches between two non-word chars. That breaks a keyword like ".env": the boundary right
// before the leading "." would need one side to be \w, but a space (or string start) before it is
// also non-word, so `\b\.env\b` would silently never match ".env" at all. Build the boundary only
// on whichever edge is actually a word character, so a non-word-leading/trailing keyword like
// ".env" is still bounded by real separators without requiring an impossible \w/\W transition.
export function keywordRegex(keyword) {
  const escaped = escapeRegExp(keyword);
  const startsWithWord = /\w/.test(keyword[0]);
  const endsWithWord = /\w/.test(keyword[keyword.length - 1]);
  const startBoundary = startsWithWord ? '(?<![A-Za-z0-9_])' : '';
  const endBoundary = endsWithWord ? '(?![A-Za-z0-9_])' : '';
  return new RegExp(`${startBoundary}${escaped}${endBoundary}`, 'i');
}
