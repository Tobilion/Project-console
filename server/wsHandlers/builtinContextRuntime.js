import { runningProcesses } from '../executor.js';
import { state, withPortCollisionWarning } from '../state.js';
import { probeDevServerCandidate, scanProjectServers, candidateDevUrls } from '../livenessProbe.js';
import { recordDevUrl } from '../devUrlStore.js';
import { searchAllProjectMemory } from '../crossProjectMemory.js';

// "when did it start running" / "how long has the site been running" — dev_server_status answers
// these from the tracked process's startedAt (2026-10-18 live crosscheck: the question used to fall
// through to the generic fallback). Mirrors the pre-semantic pin's shape so the answer only adds
// the start-time line for those questions, not for an ordinary "is it running" ask.
const START_TIME_RE = /^(?:when|how long)\s+(?:did|has|have)\s+(?:it|the\s+(?:server|site|app|website|dev\s+server|backend|frontend)|this)\s+(?:start|start\s+running|come\s+up|boot|boot\s+up|go\s+live|been\s+running|been\s+up)\b/i;

function formatRelativeTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * Live-runtime handlers (Phase 14 split of builtinProjectContext.js, 2026-08-05 — bodies moved
 * verbatim). dev_server_status/scan_servers probe on demand only (never in the background) and
 * apply the port-collision heads-up exactly like connection.js's "what is the link" pre-check.
 */
export const contextRuntimeHandlers = {
  async 'project.context.dev_server_status'(ws, _action, input, project) {
    // Intent expansion (Phase 1, 2026-08-03): "is the server running" / "is the site live" /
    // "what's the URL" now has a real intent instead of depending on a config entry or the
    // "what is the link" pre-check in connection.js happening to catch the phrasing. Reads the
    // same runningProcesses + lastDevUrls the pre-check reports — read-only, immediate, and the
    // port-collision heads-up is applied the same way the pre-check applies it.
    const procs = [...(runningProcesses.get(project.id)?.values() || [])];
    const url = state.lastDevUrls.get(project.id);
    const asksStartTime = START_TIME_RE.test((input || '').trim().toLowerCase());
    if (procs.length > 0) {
      const cmdText = procs.map((p) => `\`${p.command}\``).join(' and ');
      let msg = `**[${project.name}]** has ${cmdText} running right now.`;
      if (asksStartTime) {
        const started = procs.map((p) => p.startedAt).filter(Boolean).sort((a, b) => a - b)[0];
        if (started) msg += `\n\nIt started ${formatRelativeTime(Date.now() - started)}.`;
      }
      if (url) msg += `\n\nOpen it at **${url}** — or say "what is the link" to see it again.`;
      else msg += `\n\nThe processes are tracked but no local URL was detected yet — it may still be starting up, or it doesn't expose an HTTP server.`;
      ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(msg, url) }));
    } else if (url) {
      // Not console-tracked (started outside the console or before a restart) but we have a
      // persisted last-known URL — probe it instead of guessing. On-demand only, 3s bound.
      const probe = await probeDevServerCandidate(url, 3000);
      if (probe.alive) {
        const extra = asksStartTime ? `\n\nIt was started outside the console, so I don't know exactly when.` : '';
        ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(
          `**[${project.name}]** is still responding at **${url}** — it was started outside the console (or before a restart), so it isn't console-tracked. Say "stop the server" and I'll find and stop it for you.${extra}`,
          url
        ) }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** has no console-tracked server, and its last-known address **${url}** isn't responding${probe.error === 'timeout' ? ' (timed out)' : ''}. Say "run the site" to start it.` }));
      }
    } else {
      // Nothing tracked and no recorded URL (2026-08-04, reported directly: a server started
      // OUTSIDE the console that it never observed was invisible). Best-effort discovery —
      // probe the ports the project's own package.json scripts reference (vite --port=N etc.,
      // console's own port excluded), each bounded at 1.5s, and report honestly if one answers.
      const candidates = candidateDevUrls(project);
      let found = null;
      for (const candidate of candidates) {
        const probe = await probeDevServerCandidate(candidate, 1500);
        if (probe.alive) { found = candidate; break; }
      }
      if (found) {
        recordDevUrl(project.id, found);
        ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(
          `**[${project.name}]** is responding at **${found}** — it was started outside the console (I probed the ports its own \`package.json\` scripts reference), so it isn't console-tracked. Say "stop the server" and I'll find and stop it for you.`,
          found
        ) }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** has no server running right now. Say "run the site" to start it, or "how do I run this" for instructions.` }));
      }
    }
  },

  async 'project.context.scan_servers'(ws, _action, _input, _project) {
    // Requested directly (2026-08-04): probe every project's last-known dev URL on demand and
    // report which are still alive. Deliberately never runs in the background — a scan happens
    // only when asked, with a 2s per-URL bound and a small worker pool, and only projects that
    // HAVE a recorded URL are probed at all.
    const found = await scanProjectServers(state.activeProjectsCache, { timeoutMs: 2000, concurrency: 3 });
    if (found.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dev-server URLs are known for any project right now, and none of the ports its \`package.json\` scripts reference are responding either. Start something with "run the site" first, then scan again.` }));
    } else {
      const lines = found.map((f) =>
        `- **[${f.projectName}]** ${f.url} — ${f.alive ? `✓ responding${f.status ? ` (HTTP ${f.status})` : ''}${f.viaCandidate ? ' *(found by probing its package.json ports — not previously recorded)*' : ''}` : `✖ not responding${f.viaCandidate ? ' *(candidate port from its package.json)*' : ''}`}`
      ).join('\n');
      const liveCount = found.filter((f) => f.alive).length;
      ws.send(JSON.stringify({ type: 'answer', data: `### Server scan (${liveCount}/${found.length} alive)\n\n${lines}\n\nServers started outside the console (or before a restart) show as not console-tracked — say "stop the server" to stop one.` }));
    }
  },

  'project.context.running_processes'(ws, _action, _input, _project) {
    // Phase 3 (2026-08-03): GLOBAL list across ALL projects from runningProcesses + lastDevUrls.
    const procs = [];
    for (const [pid, slot] of runningProcesses) {
      const proj = state.activeProjectsCache.find((p) => p.id === pid);
      const url = state.lastDevUrls.get(pid);
      for (const info of slot.values()) {
        procs.push({ project: proj?.name || pid, command: info.command, url, runningSince: info.startedAt });
      }
    }
    if (procs.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `Nothing running across all projects. Say "run the site" in a project to start one.` }));
    } else {
      const lines = procs.map((p) =>
        `- **[${p.project}]** \`${p.command}\`${p.url ? ` — ${p.url}` : ''}${p.runningSince ? ` (since ${new Date(p.runningSince).toLocaleTimeString()})` : ''}`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Running processes\n\n${lines}` }));
    }
  },

  async 'system.knowledge.cross_project_search'(ws, _action, input, _project) {
    // Infrastructure expansion (2026-08-10): searches every scanned project's memory.md at once
    // — global, not scoped to the active project, same treatment as running_processes above.
    // Uses the raw input as the embedding query rather than trying to strip the "which project
    // did I ... in" wrapper — cosine similarity against a short saved fact tolerates the extra
    // wrapper words reasonably well, and a real parser for every phrasing variant isn't worth it
    // for a heuristic search feature.
    const results = await searchAllProjectMemory(state.activeProjectsCache, input);
    if (results === null) {
      ws.send(JSON.stringify({ type: 'answer', data: `Cross-project search isn't ready yet — the embedding model is still loading. Try again in a moment.` }));
      return;
    }
    if (results.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No saved memory across any project matches that. This only searches what's been explicitly remembered (via AI mode's saveMemory) — it doesn't search file contents.` }));
      return;
    }
    const lines = results.map((r) => `- **[${r.projectName}]** ${r.line} *(${Math.round(r.score * 100)}% match)*`).join('\n');
    ws.send(JSON.stringify({ type: 'answer', data: `### Cross-project memory search\n\n${lines}\n\nOnly searches remembered facts, not file contents — say "switch to [project]" to jump into one of these.` }));
  },

  async 'project.context.session_info'(ws) {
    // Phase 3 (2026-08-03): session count + most recent 3 from conversationStore index.
    const { listSessions } = await import('../conversationStore.js');
    const sessions = await listSessions();
    if (sessions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: `No chat sessions found.` }));
    } else {
      const recent = sessions.slice(0, 3).map((s) =>
        `- **${s.title}** ([${s.projectName}] — ${new Date(s.updatedAt).toLocaleString()})`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Chat sessions (${sessions.length} total)\n\n${recent}${sessions.length > 3 ? `\n\n...and ${sessions.length - 3} more` : ''}` }));
    }
  },
};
