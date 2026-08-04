// Shared URL-safety guards for every place this server fetches URLs on the user's behalf.
// Split out of webSearch.js (Phase 1 modularization) because the probeUrl tool (tools.js) and
// livenessProbe.js need the same SSRF discipline without pulling in the whole search module.

// `webSearch()`'s results carry the real destination URL, not DuckDuckGo's redirect wrapper —
// so an allowlist of DDG's own hostnames makes no sense for the deepResearch fetch (it would
// silently skip every real result). The actual risk at that fetch is SSRF: a crafted/compromised
// search result pointing at an internal address (localhost, a LAN IP, a cloud metadata endpoint)
// that this server would then fetch on the user's behalf. Guard against that class of target
// instead of allowlisting hosts we can't predict in advance.
const BLOCKED_HOSTNAME_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|\[::1\])/i;
const PRIVATE_172_RE = /^172\.(1[6-9]|2\d|3[01])\./;

export function isSafeExternalUrl(urlObj) {
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return false;
  const host = urlObj.hostname;
  if (BLOCKED_HOSTNAME_RE.test(host) || PRIVATE_172_RE.test(host)) return false;
  return true;
}

/**
 * Phase 5 (PASS 5.3) — the probeUrl tool's inverse allowlist. webSearch fetches EXTERNAL pages
 * (isSafeExternalUrl rejects internal addresses for SSRF). probeUrl is the opposite shape: the
 * model checks whether a project's dev server is up, so it must ONLY be allowed to reach
 * localhost/private http(s) URLs and must never reach a public site (or the metadata endpoint
 * 169.254.x — deliberately excluded here; that's a known SSRF target and never a dev server).
 * Mirrors the BLOCKED_HOSTNAME_RE deny-format above for the private ranges we DO permit.
 */
const PROBEABLE_HOSTNAME_RE = /^(localhost|127\.|10\.|192\.168\.|::1|\[::1\])/i;

export function isProbeableUrl(urlObj) {
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return false;
  const host = urlObj.hostname;
  if (!PROBEABLE_HOSTNAME_RE.test(host) && !PRIVATE_172_RE.test(host)) return false;
  return true;
}
