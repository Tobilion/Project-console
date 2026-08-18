import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { metrics } from '../metrics.js';
import { runningProcesses, getProcessLog } from '../executor.js';
import { state, getTabWorkspace } from '../state.js';
import { forgetDevUrl } from '../devUrlStore.js';
import { probeUrl } from '../livenessProbe.js';
import { asyncHandler } from '../asyncHandler.js';

/** Runs a git command in the given directory with a timeout, returning { stdout, stderr }. */
function runGit(cwd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

export function registerMonitoringRoutes(app) {
  app.get('/api/metrics', (req, res) => {
    res.json(metrics.snapshot());
  });

  app.post('/api/metrics/reset', (req, res) => {
    metrics.reset();
    res.json({ success: true });
  });

  // Returns every project that currently has a running process tracked by the
  // executor — includes the command that started it, its PID, PID of the tracked
  // child, and any detected dev-server URL.
  app.get('/api/active-servers', (req, res) => {
    const servers = [];
    for (const [projectId, slot] of runningProcesses) {
      for (const proc of slot.values()) {
        servers.push({
          projectId,
          command: proc.command,
          pid: proc.child?.pid || null,
          url: state.lastDevUrls.get(projectId) || null,
        });
      }
    }
    res.json(servers);
  });

  // Phase 6: live process registry for the Processes dock — same data as /api/active-servers
  // plus a startedAt timestamp (derived from the child's spawnTime, no new state). The dock
  // fetches this on mount and refetches on every 'processes_update' WS event.
  app.get('/api/processes', (req, res) => {
    const processes = [];
    for (const [projectId, slot] of runningProcesses) {
      for (const proc of slot.values()) {
        processes.push({
          projectId,
          command: proc.command,
          pid: proc.child?.pid || null,
          url: state.lastDevUrls.get(projectId) || null,
          startedAt: proc.startedAt ? new Date(proc.startedAt).toISOString() : null,
        });
      }
    }
    res.json(processes);
  });

  // Phase 6: per-process log replay from the server-side ring buffer (tail-capped ~2000 lines,
  // memory only) so the dock can show recent output to a reconnecting client.
  app.get('/api/processes/:projectId/log', (req, res) => {
    const log = getProcessLog(req.params.projectId);
    if (!log) {
      res.status(404).json({ error: 'No running process for that project.' });
      return;
    }
    res.json(log);
  });

  // Per-project dashboard aggregating git status, recent commits, dev URLs, and
  // running processes. Cached for 30s to avoid hammering git on every request —
  // but only served while the cheap volatile state (project list, running
  // processes, dev URLs) is byte-identical to what the cache was built from.
  // Any start/stop/URL-detect invalidates it implicitly, so a stopped process
  // can never stay "running" in the grid until the TTL expires (fixed 2026-08-04:
  // reported directly — stop/cancel didn't reflect live; the WS-triggered refetch
  // was hitting a stale cache). The git calls are the expensive part and they're
  // still TTL-gated.
  // The dashboard cache is per-tab (audit 2026-08-17): a single global triple made two tabs
  // with different project sets thrash each other — the signature covers the requesting tab's
  // projects, so every alternating request missed the TTL and rebuilt the expensive git state,
  // and each rebuild overwrote the other tab's cache with its own project set (correct per
  // request thanks to the signature, but a guaranteed cache miss for every second request).
  const dashboardCaches = new Map(); // tabId (or 'global') -> { cache, time, sig }
  const CACHE_TTL = 30000;

  // Windows path strings are case-insensitive and often typed differently than the scan
  // records them (start.bat launches from "Desktop\project-console", discovery records
  // "Desktop\Projects\Project console") — a raw `===` on path.resolve output made the
  // console's own project entry fail the self-detection below and never show as live
  // (reported live 2026-08-10). Compare normalized, case-folded paths on win32. Declared at
  // function scope (not inside the route handler) because buildEntry below also uses it —
  // a handler-local const would be out of scope for the hoisted buildEntry (TDZ ReferenceError,
  // caught live 2026-08-17).
  const consoleRoot = path.resolve(process.cwd());
  const isConsolePath = (projectPath) => {
    const norm = (p) => path.resolve(p).replace(/\\/g, '/');
    const a = norm(projectPath);
    const b = norm(consoleRoot);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  };

  // Phase 6 (2026-08-17): per-project git-state cache. The dashboard cache above is
  // invalidated by ANY volatile change (process start/stop, URL detection), which used to
  // re-run `git status`/`log`/`rev-list` for every project on every rebuild — frequent
  // during dev-server churn. Git state only changes on commits/stages/fetches, so cache it
  // per project with its own TTL + a cheap .git/HEAD+index mtime signature; unstaged
  // working-tree edits are bounded by the TTL (same bound the whole-dashboard cache already
  // had), while a commit invalidates immediately via the signature.
  const GIT_CACHE_TTL = 30000;
  const gitStateCache = new Map(); // projectPath -> { data, sig, at }

  function gitSignature(projectPath) {
    const parts = [];
    const stat = (p) => {
      try {
        parts.push(fs.statSync(p).mtimeMs);
      } catch {
        parts.push('missing');
      }
    };
    stat(path.join(projectPath, '.git', 'HEAD'));
    stat(path.join(projectPath, '.git', 'index'));
    return parts.join('|');
  }

  async function getGitDashboardState(projectPath) {
    const sig = gitSignature(projectPath);
    const cached = gitStateCache.get(projectPath);
    if (cached && cached.sig === sig && Date.now() - cached.at < GIT_CACHE_TTL) {
      return cached.data;
    }
    const data = { uncommitted: [], recentCommits: [], isGitRepo: false, hasUpstream: false, aheadCount: 0 };
    try {
      if (!fs.existsSync(path.join(projectPath, '.git'))) return data;
      data.isGitRepo = true;
      // status + log are independent — run them concurrently; the upstream count needs the
      // repo only, so all three run in parallel.
      const [statusRes, logRes] = await Promise.all([
        runGit(projectPath, ['status', '--short']),
        runGit(projectPath, ['log', '--oneline', '-5']),
      ]);
      if (statusRes.stdout.trim()) {
        data.uncommitted = statusRes.stdout.trim().split('\n').slice(0, 100);
      }
      if (logRes.stdout.trim()) {
        data.recentCommits = logRes.stdout.trim().split('\n').filter(Boolean);
      }
      try {
        const { stdout: aheadOut } = await runGit(projectPath, ['rev-list', '--count', '@{u}..HEAD']);
        data.hasUpstream = true;
        data.aheadCount = parseInt(aheadOut.trim(), 10) || 0;
      } catch {
        // No upstream configured (or detached HEAD) — leave hasUpstream false, aheadCount 0.
      }
    } catch {
      // Not a git repo, or git unavailable — data stays with empty arrays
    }
    gitStateCache.set(projectPath, { data, sig, at: Date.now() });
    return data;
  }

  function getDashboardCache(tabId) {
    const key = tabId || 'global';
    let entry = dashboardCaches.get(key);
    if (!entry) {
      entry = { cache: null, time: 0, sig: '' };
      dashboardCaches.set(key, entry);
    }
    return entry;
  }

  function volatileSignature(tabId) {
    const parts = [];
    // Phase T (2026-08-14): the signature covers the requesting tab's OWN project set (a
    // second tab's scan must not invalidate — or, worse, serve stale data to — this one).
    const cache = tabId ? getTabWorkspace(tabId)?.projectsCache || [] : state.activeProjectsCache;
    for (const project of cache) parts.push(`p:${project.id}`);
    for (const [pid, slot] of runningProcesses) {
      for (const proc of slot.values()) {
        parts.push(`r:${pid}|${proc.command}|${proc.startedAt || ''}`);
      }
    }
    for (const [pid, url] of state.lastDevUrls) parts.push(`u:${pid}|${url}`);
    return parts.sort().join(';');
  }

  app.get('/api/dashboard', asyncHandler(async (req, res) => {
    const tabId = typeof req.query.tab === 'string' ? req.query.tab : null;
    const now = Date.now();
    const sig = volatileSignature(tabId);
    const cacheEntry = getDashboardCache(tabId);
    if (cacheEntry.cache && sig === cacheEntry.sig && (now - cacheEntry.time < CACHE_TTL)) {
      return res.json(cacheEntry.cache);
    }

    // Phase T: the dashboard lists the requesting tab's projects only — the same set the
    // tab's sidebar shows — never another tab's scan results.
    const tabProjects = tabId ? (getTabWorkspace(tabId)?.projectsCache || []) : state.activeProjectsCache;

    // Phase 6: per-project work (probe + git state + assembly) was serial — a slow probe or
    // git call delayed every later project. The pieces are independent, so a small worker
    // pool overlaps them; results land by index so the response order is unchanged.
    const results = new Array(tabProjects.length);
    const POOL_SIZE = 6;
    let nextIdx = 0;
    const worker = async () => {
      while (nextIdx < tabProjects.length) {
        const idx = nextIdx++;
        results[idx] = await buildEntry(tabProjects[idx]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL_SIZE, tabProjects.length) }, () => worker()));

    cacheEntry.cache = results;
    cacheEntry.time = now;
    cacheEntry.sig = sig;
    res.json(results);
  }));

  async function buildEntry(project) {
      const rawDevUrl = state.lastDevUrls.get(project.id) || null;
      const procs = [...(runningProcesses.get(project.id)?.values() || [])];
      // `running` is the dashboard's live-truth flag: true when a tracked process exists, the
      // recorded dev URL answered the probe below, or the entry IS the console (it is serving
      // the very request being answered — reported live 2026-08-11: the console's own card and
      // NetPulse showed "process not currently running" in the Live Sites tab because that tab
      // keyed off runningCommand only, and neither has a tracked process in this console).
      let running = procs.length > 0;
      let probeConfirmedAlive = false;
      // A stored URL on the console's own port is the console, not this project's server —
      // the console took that port over (or held it all along); drop it and forget it so the
      // stale entry can't keep "showing live" (confirmed live 2026-08-10: Matchday Exchange
      // stayed live on :3001 after the console moved there). recordDevUrl now refuses such
      // URLs at write time; this cleanup handles entries stored before that guard existed.
      let devUrl = rawDevUrl;
      try {
        if (rawDevUrl && Number(new URL(rawDevUrl).port) === Number(state.serverPort)) {
          devUrl = null;
          forgetDevUrl(project.id);
        }
      } catch { devUrl = rawDevUrl; }
      // A stored URL that no longer answers is dead — drop it so "live" stays honest
      // (reported live 2026-08-10: Matchday Exchange stayed "live" on a stale :3001 with
      // nothing listening). On-demand probe with a short bound; the dashboard's 30s cache
      // keeps the cost amortized. Only stored URLs are probed — the console-self URL is
      // assigned below and never enters lastDevUrls (recordDevUrl refuses that port).
      if (devUrl) {
        try {
          // Phase 6: probe bound tightened to 600ms — the parallel worker pool overlaps the
          // per-project probes, so each individual bound can be shorter.
          const probe = await probeUrl(devUrl, 600);
          if (probe.alive) {
            probeConfirmedAlive = true;
          } else {
            devUrl = null;
            // 2026-08-18: a single failed 600ms probe is NOT proof the server is gone — a
            // busy machine, a mid-restart server, or vite still binding can all time out
            // transiently. Forgetting here permanently erased the persisted URL, which
            // killed the open-site chip and the Live Sites row until the next server_url
            // event (reported live alongside the Matchday force-detach fix). The entry
            // already shows "not running" — honesty doesn't require deletion. Real cleanup
            // happens in the executor's close handler, which forgets only when the tracked
            // process actually exited and nothing answers. A stale entry just shows
            // not-live and is re-probed at the next cache rebuild.
          }
        } catch { /* keep the URL if the probe itself failed — a stale link is better than a wrong truth */ }
      }
      // The console itself is a live server — its own frontend answers on state.serverPort.
      // A project whose root IS this repository gets the console URL so it shows up as live
      // in the dashboard and its "Open site" action works.
      const isConsoleSelf = isConsolePath(project.path);
      if (!devUrl && isConsoleSelf) {
        devUrl = `http://127.0.0.1:${state.serverPort}`;
      }
      running = running || probeConfirmedAlive || (isConsoleSelf && Boolean(devUrl));
      const gitState = await getGitDashboardState(project.path);
      const entry = {
        id: project.id,
        name: project.name,
        path: project.path,
        workspaceType: project.workspaceType || 'dev',
        uncommitted: gitState.uncommitted,
        recentCommits: gitState.recentCommits,
        devUrl,
        running,
        runningCommand: null,
        isGitRepo: gitState.isGitRepo,
        // Dashboard QoL expansion (2026-08-10, requested directly — a project card's push
        // button needs to know about commits that are committed-but-unpushed, not just dirty
        // working-tree files). `hasUpstream: false` covers both "no upstream branch configured
        // yet" and "detached HEAD" — either way there's no ahead/behind count to report, but a
        // first push is still meaningful, so the frontend treats it as "needs push" too.
        aheadCount: gitState.aheadCount,
        hasUpstream: gitState.hasUpstream,
      };

      if (procs.length > 0) entry.runningCommand = procs.map((p) => p.command).join('; ');

      return entry;
    }
}
