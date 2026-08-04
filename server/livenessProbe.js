import { isProbeableUrl } from './webSearch.js';
import { state } from './state.js';

// On-demand liveness probing for dev-server URLs. Runs ONLY when the user asks — nothing
// scans or polls in the background, so the system cost is zero unless a question triggers it.
// Same SSRF discipline as webSearch's external allowlist (reversed): only localhost/private
// http(s) URLs can ever be probed, never public sites or link-local metadata endpoints.

/**
 * One bounded HTTP probe. Returns { alive: true, status } or { alive: false, error }.
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function probeUrl(url, timeoutMs = 3000) {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    return { alive: false, error: `Not a valid URL: "${url}"` };
  }
  if (!isProbeableUrl(urlObj)) {
    return { alive: false, error: `Refusing to probe "${url}" — only localhost/private http(s) URLs are allowed.` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(urlObj.toString(), { method: 'GET', redirect: 'follow', signal: controller.signal });
    return { alive: true, status: res.status };
  } catch (err) {
    return { alive: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes the last-known dev URL of every project that has one, bounded by a per-URL timeout
 * and a small worker pool. Only projects WITH a recorded URL are ever touched — for a typical
 * console that's one or two, so a scan finishes in a couple of seconds.
 * @param {Array<{id: string, name: string}>} projects
 * @returns {Promise<Array<{projectId, projectName, url, alive, status}>>}
 */
export async function scanProjectServers(projects, { timeoutMs = 2000, concurrency = 3 } = {}) {
  const targets = projects
    .map((project) => ({ project, url: state.lastDevUrls.get(project.id) }))
    .filter((t) => t.url);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const { project, url } = targets[next++];
      const probe = await probeUrl(url, timeoutMs);
      results.push({
        projectId: project.id,
        projectName: project.name,
        url,
        alive: probe.alive,
        status: probe.status ?? null,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return results;
}
