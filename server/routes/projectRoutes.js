import fs from 'fs';
import path from 'path';
import { discoverProjects } from '../projectScanner.js';
import { indexProject } from '../codebaseIndexer.js';
import { semanticMatcher } from '../semanticMatcher.js';
import { nlpEngine } from '../nlpEngine.js';
import { setupMockProjectsIfMissing } from '../mockProjects.js';
import { state, projectsMutex, resolveProject, getTabWorkspace, setTabWorkspace, allKnownProjects, dedupeProjectIds } from '../state.js';
import { broadcast } from '../wsServer.js';
import { asyncHandler } from '../asyncHandler.js';
import { projectChatLogPath } from '../sessionExport.js';
import { listActions } from '../actionHistory.js';
import { syncProjectWatchers } from '../codeIndex/codeIndexBuilder.js';
import { readProfile } from './profileRoutes.js';
import { getCachedScanStale, isRevalidating, setRevalidating, setCachedScan, invalidateScanCacheForPath } from '../scanCache.js';
import { log as logger } from '../logger.js';

// Phase T (2026-08-14): whether discovery includes every subfolder as a project — read fresh
// from the profile at each scan so a setting change applies without a restart (the routes
// below and the boot scan all pass it into discoverProjects).
function scanAllFoldersEnabled() {
  return readProfile().scanAllFolders;
}

// A plain browser tab (not Electron/Tauri) can never receive an absolute host filesystem path
// from <input type="file" webkitdirectory> — that's a deliberate File API restriction, not a
// bug. The frontend's native "Browse for folder" button can only recover the *folder name*
// (via webkitRelativePath's first segment), so when a bare name (no drive letter / no leading
// slash) comes in here, search a small set of likely roots for a directory with that name
// instead of failing outright. This covers the common case (folder lives under the current
// scan root or its parent, e.g. anything under `C:\Users\<you>\Desktop`) without pretending to
// be a full arbitrary-path picker, which a plain web page fundamentally cannot be.
function looksAbsolute(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

export function registerProjectRoutes(app, dirname) {
  // Current project list, scanned from the (tab's or global) scan directory.
  // Phase T (2026-08-14): an optional ?tab=<id> query scopes the scan to that tab's own
  // workspace — two tabs can scan different folders without clobbering each other. The first
  // GET for a tab id creates its workspace seeded with the global scan directory; the global
  // path (no ?tab=) is unchanged for CLI/legacy callers.
  app.get('/api/projects', asyncHandler(async (req, res) => {
    const tabId = typeof req.query.tab === 'string' ? req.query.tab : null;
    const tabWs = getTabWorkspace(tabId);
    const scanDir = tabWs ? tabWs.scanDirectory : state.currentScanDirectory;
    const dirToScan = setupMockProjectsIfMissing(scanDir, dirname);
    const includeAll = scanAllFoldersEnabled();
    // Phase 6 (2026-08-17): whole-scan cache. Previously every fetch re-ran the full
    // container walk (per-project config/doc reads + codebase indexing), which a multi-tab
    // reload paid once per tab. A hit is validated against per-project mtimes, so config/
    // doc/git edits apply immediately; code-content-only changes are bounded by the TTL
    // (scanCache.js documents the staleness contract). On a hit the projects are the same
    // objects already injected into the matcher/NLP, so the refresh below is skipped.
    // D-2 (2026-09-08): getCachedScanStale distinguishes a fresh hit from a TTL-expired-but-
    // signature-still-matching hit — the latter is served immediately (stale by at most a
    // few seconds, no correctness cost) while a background re-scan refreshes it, instead of
    // blocking this request the same way a true cold miss must. Exactly one background
    // re-scan runs per root at a time (isRevalidating/setRevalidating guards it), so a burst
    // of requests hitting the same stale entry (multiple tabs, rapid polling) doesn't fan out
    // into N redundant scans.
    const staleEntry = getCachedScanStale(dirToScan, includeAll);
    let projects;
    let cacheHit;
    if (staleEntry) {
      projects = staleEntry.projects;
      cacheHit = true;
      if (!staleEntry.fresh && !isRevalidating(dirToScan, includeAll)) {
        setRevalidating(dirToScan, includeAll, true);
        (async () => {
          try {
            const refreshed = dedupeProjectIds(await discoverProjects(dirToScan, { includeAll }));
            setCachedScan(dirToScan, includeAll, refreshed);
            if (tabWs) {
              tabWs.projectsCache = refreshed;
            } else {
              await projectsMutex.runExclusive(async () => {
                state.activeProjectsCache = refreshed;
              });
            }
            const known = allKnownProjects();
            await semanticMatcher.clearProjectIntents().catch(() => {});
            await semanticMatcher.addProjectIntents(known).catch(() => {});
            broadcast({ type: 'projects_updated', data: refreshed });
          } catch (err) {
            logger.warn('[projectRoutes] background scan revalidation failed:', err?.message || err);
          } finally {
            setRevalidating(dirToScan, includeAll, false);
          }
        })();
      }
    } else {
      projects = dedupeProjectIds(await discoverProjects(dirToScan, { includeAll }));
      setCachedScan(dirToScan, includeAll, projects);
      cacheHit = false;
    }
    if (tabWs) {
      tabWs.projectsCache = projects;
    } else {
      await projectsMutex.runExclusive(async () => {
        state.activeProjectsCache = projects;
      });
    }
    // Global consumers (matcher intents, NLP) must see projects from ALL tabs — one tab's
    // rescan must never silently drop another tab's projects from those views. Skipped for a
    // stale-served hit above: the background task above (if just kicked off) will do this
    // once the fresh scan actually lands, and re-running it here against still-stale data
    // would be wasted work.
    if (!cacheHit) {
      const known = allKnownProjects();
      semanticMatcher.clearProjectIntents().catch(() => {});
      semanticMatcher.addProjectIntents(known).catch(() => {});
    }
    res.json({
      scanPath: scanDir,
      projects
    });
  }));

  // Change the directory being scanned and rescan it. This is the endpoint the
  // frontend's "Scan" box actually calls (see src/App.tsx handleScan). Wrapped in
  // asyncHandler: a POST without a JSON body leaves req.body undefined, and the
  // destructure used to throw before the handler's own try/catch ever saw it — an
  // unwrapped async rejection that hung the request (audit 2026-08-06, Phase 2).
  // Phase T (2026-08-14): ?tab=<id> mutates that tab's workspace instead of the global
  // scan root — the "duplicate tab scans a different folder" feature.
  app.post('/api/scan-path', asyncHandler(async (req, res) => {
    const { path: newPath } = req.body || {};
    const tabId = typeof req.query.tab === 'string' ? req.query.tab : null;

    if (!newPath || typeof newPath !== 'string' || newPath.trim() === '') {
      return res.status(400).json({ success: false, error: 'Directory path is required.' });
    }

    const sanitizedPath = newPath.trim();

    // Name-only picks resolve relative to the tab's own root (or the global root for
    // no-tab callers) — a second tab's folder-picker name must resolve inside ITS root.
    const currentRoot = tabId
      ? (getTabWorkspace(tabId)?.scanDirectory || state.currentScanDirectory)
      : state.currentScanDirectory;
    const resolveScanTarget = (candidate) => {
      const trimmed = candidate.trim();
      if (looksAbsolute(trimmed)) return trimmed;
      const roots = [
        path.dirname(currentRoot),
        currentRoot,
      ];
      for (const root of roots) {
        try {
          const entries = fs.readdirSync(root, { withFileTypes: true });
          const match = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === trimmed.toLowerCase());
          if (match) return path.join(root, match.name);
        } catch {
          // root doesn't exist or isn't readable — try the next one
        }
      }
      return null;
    };

    let resolvedPath = sanitizedPath;
    if (!looksAbsolute(sanitizedPath)) {
      const found = resolveScanTarget(sanitizedPath);
      if (!found) {
        return res.status(400).json({
          success: false,
          error: `Couldn't find a folder named "${sanitizedPath}" automatically. Browser folder pickers ` +
            `can't reveal a full path for security reasons — please paste the complete path instead ` +
            `(e.g. C:\\Users\\you\\Desktop\\${sanitizedPath}).`,
        });
      }
      resolvedPath = found;
    }

    try {
      // Move the mock-seed inside the try too — it does filesystem work that can throw, and
      // previously sat outside the handler's only guard (audit 2026-08-06, Phase 2).
      const effectivePath = setupMockProjectsIfMissing(resolvedPath, dirname);
      const includeAll = scanAllFoldersEnabled();
      // D-3 (2026-09-08): this endpoint used to cold-scan unconditionally, even when a
      // duplicated tab or a restored tab pointed at the SAME root another tab had already
      // scanned moments earlier (5 saved tabs on the same root previously meant 5 full
      // container walks instead of 1). Check the whole-scan cache first — a fresh hit skips
      // the scan entirely; a stale-but-valid hit is served immediately with a background
      // refresh, same as GET /api/projects' D-2 fix — and only a genuine miss re-scans.
      const staleEntry = getCachedScanStale(effectivePath, includeAll);
      let projects;
      if (staleEntry) {
        projects = staleEntry.projects;
        if (!staleEntry.fresh && !isRevalidating(effectivePath, includeAll)) {
          setRevalidating(effectivePath, includeAll, true);
          (async () => {
            try {
              const refreshed = dedupeProjectIds(await discoverProjects(effectivePath, { includeAll }));
              setCachedScan(effectivePath, includeAll, refreshed);
              if (tabId) {
                setTabWorkspace(tabId, { scanDirectory: resolvedPath, projectsCache: refreshed });
              } else {
                await projectsMutex.runExclusive(async () => {
                  state.activeProjectsCache = refreshed;
                });
              }
              broadcast({ type: 'projects_updated', data: refreshed });
            } catch (err) {
              logger.warn('[projectRoutes] background scan-path revalidation failed:', err?.message || err);
            } finally {
              setRevalidating(effectivePath, includeAll, false);
            }
          })();
        }
      } else {
        projects = dedupeProjectIds(await discoverProjects(effectivePath, { includeAll }));
        // Phase 6: prime the whole-scan cache so the next GET /api/projects for this root
        // (tab restore, dashboard-ish fetches) hits instead of re-walking the container.
        setCachedScan(effectivePath, includeAll, projects);
      }
      if (tabId) {
        setTabWorkspace(tabId, { scanDirectory: resolvedPath, projectsCache: projects });
      } else {
        state.currentScanDirectory = resolvedPath;
        await projectsMutex.runExclusive(async () => {
          state.activeProjectsCache = projects;
        });
      }
      // Close code-index watchers for projects that left ANY scan set (codeIndexBuilder) —
      // per-tab sets feed the same global watchers, so sync against the union.
      syncProjectWatchers(allKnownProjects());

      res.json({
        success: true,
        scanPath: resolvedPath,
        projects
      });

      const known = allKnownProjects();
      nlpEngine.train(known).catch((err) => {
        logger.error('Background NLP retrain failed:', err.message);
      });
      semanticMatcher.clearProjectIntents().catch(() => {});
      semanticMatcher.addProjectIntents(known).catch((err) =>
        logger.warn('Project-intent refresh failed after rescan:', err?.message || err));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }));

  // Re-index a specific project's codebase and broadcast the update to connected clients.
  app.post('/api/projects/:id/index', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const idx = await indexProject(project.path);
    project.codebaseIndex = idx;
    broadcast({ type: 'project_updated', data: project });
    res.json({ success: true, codebaseIndex: idx });
  }));

  // Round-6 audit (2026-08-24): Aider-style repo-map visibility. The codebase index's
  // whole-project symbol map has only ever fed the AI system prompt; this endpoint exposes the
  // same structure (per-file top-level signatures + imports + reverse "used by" + API routes)
  // to the web Repo Map panel. Reuses the project's cached codebaseIndex when present and
  // builds it on demand otherwise — the same indexProject() every other consumer uses, so the
  // panel and the AI prompt can never describe different structures.
  app.get('/api/projects/:id/repo-map', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    let idx = project.codebaseIndex;
    if (!idx) {
      idx = await indexProject(project.path);
      if (idx) project.codebaseIndex = idx;
    }
    if (!idx) return res.status(500).json({ error: 'Could not index this project' });
    res.json({
      repoMap: idx.repoMap || [],
      apiRoutes: idx.apiRoutes || [],
      languages: idx.languages || [],
      frameworks: idx.frameworks || [],
      entryPoints: idx.entryPoints || [],
      subPackages: idx.subPackages || [],
      isMonorepo: !!idx.isMonorepo,
      totalFiles: idx.totalFiles ?? 0,
      totalDirs: idx.totalDirs ?? 0,
      hasRealCode: !!idx.hasRealCode,
      indexed: true,
    });
  }));

  // Phase 4: action history for the ProcessDock History tab (most-recent-first, capped).
  app.get('/api/projects/:id/action-history', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '30', 10) || 30, 1), 200);
    res.json({ actions: listActions(project.path, { limit }) });
  }));

  // "Export whole project" (Phase 0): direct download of the project's existing
  // .console/chat-log.md — already a complete human-readable transcript of every session in
  // that project (chatLog.js), no generation logic needed here, just exposure.
  app.get('/api/projects/:id/chat-log', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const logPath = await projectChatLogPath(project.path);
    if (!logPath) return res.status(404).json({ error: 'No chat log yet for this project — send a message first.' });
    // folderName is a real Windows filesystem name (cannot contain / " etc.), safe as a
    // Content-Disposition filename.
    res.download(logPath, `${project.folderName}-chat-log.md`);
  }));
}
