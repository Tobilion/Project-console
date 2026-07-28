const SEARCH_CACHE = new Map();

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
        url: links[i]?.href || '',
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

export async function deepResearch(query) {
  try {
    const searchResults = await webSearch(query);
    if (searchResults.error) return { error: `Search failed: ${searchResults.error}` };
    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      return { error: 'No search results found.' };
    }
    const ALLOWED_SEARCH_HOSTS = new Set(['duckduckgo.com', 'html.duckduckgo.com']);
    const topResults = searchResults.slice(0, 5);
    const contents = [];
    for (const r of topResults) {
      try {
        const urlObj = new URL(r.url);
        if (!ALLOWED_SEARCH_HOSTS.has(urlObj.hostname)) continue;
        const pageRes = await fetch(r.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
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
