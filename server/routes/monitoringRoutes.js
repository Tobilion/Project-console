import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { metrics } from '../metrics.js';
import { runningProcesses, getProcessLog } from '../executor.js';
import { state } from '../state.js';
import { forgetDevUrl } from '../devUrlStore.js';
import { probeUrl } from '../livenessProbe.js';

/** Runs a git command in the given directory with a timeout, returning { stdout, stderr }. */
function runGit(cwd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    exec(`git ${args.join(' ')}`, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
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
  let dashboardCache = null;
  let dashboardCacheTime = 0;
  let dashboardCacheSig = '';
  const CACHE_TTL = 30000;

  function volatileSignature() {
    const parts = [];
    for (const project of state.activeProjectsCache) parts.push(`p:${project.id}`);
    for (const [pid, slot] of runningProcesses) {
      for (const proc of slot.values()) {
        parts.push(`r:${pid}|${proc.command}|${proc.startedAt || ''}`);
      }
    }
    for (const [pid, url] of state.lastDevUrls) parts.push(`u:${pid}|${url}`);
    return parts.sort().join(';');
  }

  app.get('/api/dashboard', async (req, res) => {
    const now = Date.now();
    const sig = volatileSignature();
    if (dashboardCache && sig === dashboardCacheSig && (now - dashboardCacheTime < CACHE_TTL)) {
      return res.json(dashboardCache);
    }

    const results = [];
    const consoleRoot = path.resolve(process.cwd());
    // Windows path strings are case-insensitive and often typed differently than the scan
    // records them (start.bat launches from "Desktop\project-console", discovery records
    // "Desktop\Projects\Project console") — a raw `===` on path.resolve output made the
    // console's own project entry fail the self-detection below and never show as live
    // (reported live 2026-08-10). Compare normalized, case-folded paths on win32.
    const isConsolePath = (projectPath) => {
      const norm = (p) => path.resolve(p).replace(/\\/g, '/');
      const a = norm(projectPath);
      const b = norm(consoleRoot);
      return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    };
    for (const project of state.activeProjectsCache) {
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
          const probe = await probeUrl(devUrl, 1200);
          if (probe.alive) {
            probeConfirmedAlive = true;
          } else {
            devUrl = null;
            forgetDevUrl(project.id);
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
      const entry = {
        id: project.id,
        name: project.name,
        path: project.path,
        workspaceType: project.workspaceType || 'dev',
        uncommitted: [],
        recentCommits: [],
        devUrl,
        running,
        runningCommand: null,
        isGitRepo: false,
        // Dashboard QoL expansion (2026-08-10, requested directly — a project card's push
        // button needs to know about commits that are committed-but-unpushed, not just dirty
        // working-tree files). `hasUpstream: false` covers both "no upstream branch configured
        // yet" and "detached HEAD" — either way there's no ahead/behind count to report, but a
        // first push is still meaningful, so the frontend treats it as "needs push" too.
        aheadCount: 0,
        hasUpstream: false,
      };

      if (procs.length > 0) entry.runningCommand = procs.map((p) => p.command).join('; ');

      try {
        const gitDir = path.join(project.path, '.git');
        entry.isGitRepo = fs.existsSync(gitDir);
        if (entry.isGitRepo) {
          const { stdout: statusOut } = await runGit(project.path, ['status', '--short']);
          if (statusOut.trim()) {
            entry.uncommitted = statusOut.trim().split('\n').slice(0, 100);
          }

          const { stdout: logOut } = await runGit(project.path, ['log', '--oneline', '-5']);
          if (logOut.trim()) {
            entry.recentCommits = logOut.trim().split('\n').filter(Boolean);
          }

          try {
            const { stdout: aheadOut } = await runGit(project.path, ['rev-list', '--count', '@{u}..HEAD']);
            entry.hasUpstream = true;
            entry.aheadCount = parseInt(aheadOut.trim(), 10) || 0;
          } catch {
            // No upstream configured (or detached HEAD) — leave hasUpstream false, aheadCount 0.
          }
        }
      } catch {
        // Not a git repo, or git unavailable — entry stays with empty arrays
      }

      results.push(entry);
    }

    dashboardCache = results;
    dashboardCacheTime = now;
    dashboardCacheSig = sig;
    res.json(results);
  });
}
