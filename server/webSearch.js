import { isSafeExternalUrl } from './urlSafety';

const SEARCH_CACHE = new Map();

/**
 * DuckDuckGo's HTML endpoint (html.duckduckgo.com/html) never links straight to the destination
 * page — every result__a href is wrapped as a same-site redirect,
 * `//duckduckgo.com/l/?uddg=<url-encoded-destination>&rut=...`. Left unwrapped, every `url` this
 * module returns (shown to users as a citation, and what deepResearch's own host allowlist below
 * checks) is DDG's redirect link, not the real source — decode it back to the actual destination
 * so citations point somewhere useful and the allowlist check downstream means what it says.
 */
function resolveRealUrl(href) {
  if (!href) return href;
  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(normalized, 'https://duckduckgo.com');
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
      const real = parsed.searchParams.get('uddg');
      if (real) return decodeURIComponent(real);
    }
    return parsed.href;
  } catch {
    return href;
  }
}

export async function webSearch(query) {
  const cacheKey = query.toLowerCase().trim();
  if (SEARCH_CACHE.has(cacheKey)) return SEARCH_CACHE.get(cacheKey);

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const results = [];
    const itemRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;
    const links = [];
    while ((match = itemRegex.exec(html)) !== null) {
      links.push({ href: match[1], title: match[2].replace(/<[^>]+>/g, '').trim() });
    }
    const snippets = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
    }

    for (let i = 0; i < Math.min(links.length, 8); i++) {
      results.push({
        title: links[i]?.title || '',
        url: resolveRealUrl(links[i]?.href) || '',
        snippet: snippets[i] || '',
      });
    }

    SEARCH_CACHE.set(cacheKey, results);
    setTimeout(() => SEARCH_CACHE.delete(cacheKey), 5 * 60 * 1000);
    return results;
  } catch (err) {
    return { error: err.message };
  }
}

// SSRF guards shared with tools.js/livenessProbe.js live in urlSafety.js; re-export
// isProbeableUrl here so this module's original export surface is preserved for any importer.
export { isProbeableUrl } from './urlSafety';

export async function deepResearch(query) {
  try {
    const searchResults = await webSearch(query);
    if (searchResults.error) return { error: `Search failed: ${searchResults.error}` };
    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      return { error: 'No search results found.' };
    }
    const topResults = searchResults.slice(0, 5);
    const contents = [];
    for (const r of topResults) {
      try {
        const urlObj = new URL(r.url);
        if (!isSafeExternalUrl(urlObj)) continue;
        const pageRes = await fetch(r.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          // redirect: 'manual' — only the URL that passed isSafeExternalUrl may be fetched.
          // Following a Location header would let a public page redirect the fetch to an
          // internal/metadata host that was never validated (the SSRF class livenessProbe's
          // dashboard probe guards against the same way).
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        if (pageRes.ok) {
          const text = await pageRes.text();
          const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          const bodyText = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
          contents.push({ title: r.title, url: r.url, content: bodyText.substring(0, 3000) });
        }
      } catch {}
    }

    return { results: searchResults, contents };
  } catch (err) {
    return { error: err.message };
  }
}
