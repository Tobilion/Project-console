// Shared external-endpoint constants (Phase B.3, 2026-09-08) — single source of truth for
// the external HTTP services the console talks to outside the user's own machine, following
// the same env-overridable, centralized pattern as server/portConfig.js. Before this module
// the npm registry URL was built independently in server/updateChecker.js and server/
// doctor.js, and the DuckDuckGo search endpoint was a bare literal in server/webSearch.js —
// none of them overridable, which matters for anyone running behind a private npm mirror or
// a self-hosted search proxy since this app is shipped to other users, not just this machine.

const NPM_REGISTRY_BASE = process.env.NPM_REGISTRY_URL || 'https://registry.npmjs.org';
const DUCKDUCKGO_HTML_BASE = process.env.DUCKDUCKGO_SEARCH_URL || 'https://html.duckduckgo.com/html/';

/** `GET`-able URL for a package's latest published version metadata. */
export function npmRegistryLatestUrl(packageName) {
  return `${NPM_REGISTRY_BASE}/${packageName}/latest`;
}

/** `GET`-able URL for a DuckDuckGo HTML search results page. */
export function duckDuckGoSearchUrl(query) {
  return `${DUCKDUCKGO_HTML_BASE}?q=${encodeURIComponent(query)}`;
}
