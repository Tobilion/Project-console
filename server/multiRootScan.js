// D-9 (2026-09-08/09): scan MULTIPLE roots for one tab instead of being stuck to a single
// path per tab/workspace. Deliberately additive on top of the existing single-root scan path
// (server/routes/projectRoutes.js's GET /api/projects and POST /api/scan-path) rather than a
// rewrite of it: each root is still scanned and cached exactly as it always was (scanCache.js
// is keyed per-root already, so no cache-signature changes were needed at all — a multi-root
// tab is just several independent per-root cache entries, merged here). A tab with only one
// root never touches this module.
import path from 'path';
import { discoverProjects } from './projectScanner.js';
import { dedupeProjectIds } from './state.js';
import { getCachedScanStale, isRevalidating, setRevalidating, setCachedScan } from './scanCache.js';
import { log as logger } from './logger.js';

/**
 * Scans every root in `roots`, merging the results into one project list. Each project is
 * tagged with `sourceRoot` (which of the tab's roots it came from) so the UI can show where a
 * project lives when a tab has more than one folder open. Dedupes by resolved absolute path
 * first (the same project folder listed twice, e.g. an overlapping root, must not appear
 * twice), then re-runs dedupeProjectIds() across the FULL merged set — two different roots can
 * each contain a same-named folder ("frontend" in two different clients' folders), and the
 * per-root id-collision guard in discoverProjects()/dedupeProjectIds only ever saw one root's
 * worth of projects at a time, so a merge-time re-dedupe is required to keep ids unique across
 * the whole tab.
 *
 * Reuses the exact same per-root whole-scan cache (scanCache.js) and stale-while-revalidate
 * behavior as the single-root path in projectRoutes.js — a cache hit for a root already
 * scanned by another tab (or by this same tab before it became multi-root) is honored here
 * too, so adding a second folder to a tab never forces a redundant cold scan of the first one.
 */
export async function discoverProjectsAcrossRoots(roots, includeAll) {
  const merged = [];
  const seenPaths = new Set();

  for (const root of roots) {
    let projects;
    const staleEntry = getCachedScanStale(root, includeAll);
    if (staleEntry) {
      projects = staleEntry.projects;
      if (!staleEntry.fresh && !isRevalidating(root, includeAll)) {
        setRevalidating(root, includeAll, true);
        (async () => {
          try {
            const refreshed = dedupeProjectIds(await discoverProjects(root, { includeAll }));
            setCachedScan(root, includeAll, refreshed);
          } catch (err) {
            logger.warn('[multiRootScan] background revalidation failed for %s: %s', root, err?.message || err);
          } finally {
            setRevalidating(root, includeAll, false);
          }
        })();
      }
    } else {
      projects = dedupeProjectIds(await discoverProjects(root, { includeAll }));
      setCachedScan(root, includeAll, projects);
    }

    for (const p of projects) {
      const key = path.resolve(p.path).toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      merged.push({ ...p, sourceRoot: root });
    }
  }

  return dedupeProjectIds(merged);
}

/** Adds `newRoot` to `existingRoots` (dedupe on resolved path, case-insensitive), preserving
 *  order — used by POST /api/scan-path's `mode: 'add'` so re-adding an already-open folder is
 *  a no-op instead of a duplicate root. */
export function addRoot(existingRoots, newRoot) {
  const norm = path.resolve(newRoot).toLowerCase();
  if (existingRoots.some((r) => path.resolve(r).toLowerCase() === norm)) return existingRoots;
  return [...existingRoots, newRoot];
}
