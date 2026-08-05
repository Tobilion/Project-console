import { runningProcesses } from '../executor.js';
import { state, withPortCollisionWarning } from '../state.js';
import { formatApiRoutes, findTodos, findBiggestFiles, findRecentActivity } from '../codebaseIndexer.js';
import { probeUrl, scanProjectServers, candidateDevUrls } from '../livenessProbe.js';
import { recordDevUrl } from '../devUrlStore.js';
import { parseFileNameOnly } from './builtinHelpers.js';
import { injectContext } from '../contextInjector.js';

/**
 * project.context.* / project.context.running_processes / project.context.session_info — the
 * read-only codebase-introspection branch bodies extracted verbatim from builtinIntents.js
 * (Phase 10 step 5).
 */
export const projectContextHandlers = {
  'project.context.structure'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No indexed structure available for **[${project.name}]**. Run a re-index first.` }));
    } else {
      let msg = `### Directory Structure [${project.name}]\n\n**${idx.totalDirs} directories, ${idx.totalFiles} files**\n`;
      if (idx.directoryTree.length) {
        msg += '\n```\n' + idx.directoryTree.join('\n') + '\n```';
      }
      if (idx.fileSample.length) {
        msg += `\n\n**Sample files (${idx.fileSample.length} shown):**\n` + idx.fileSample.map((f) => `- ${f}`).join('\n');
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  },

  'project.context.languages'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx?.languages?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No language data indexed for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Languages in [${project.name}]\n\n${idx.languages.map((l) => `- ${l}`).join('\n')}` }));
    }
  },

  'project.context.file_count'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No index data for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Project Size [${project.name}]\n\n- **Total files:** ${idx.totalFiles}\n- **Total directories:** ${idx.totalDirs}\n- **Languages:** ${(idx.languages || []).slice(0, 5).join(', ') || 'N/A'}` }));
    }
  },

  'project.context.entry_point'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx?.entryPoints?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No entry point detected for **[${project.name}]**. Try "show me the project structure" to explore.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Entry Points [${project.name}]\n\n${idx.entryPoints.map((e) => `- \`${e}\``).join('\n')}` }));
    }
  },

  'project.context.tech_preview'(ws, action, input, project) {
    const idx = project.codebaseIndex;
    let msg = `### Tech Preview [${project.name}]\n\n`;
    if (idx) {
      msg += `**${idx.totalFiles} files** across **${idx.totalDirs} directories**.\n\n`;
      if (idx.languages?.length) msg += `**Languages:** ${idx.languages.slice(0, 4).join(', ')}\n`;
      if (idx.entryPoints?.length) msg += `**Entry points:** ${idx.entryPoints.join(', ')}\n`;
      if (idx.hasTests) msg += '**Has tests**\n';
      if (idx.hasCli) msg += '**Has CLI**\n';
      if (idx.hasConfig) msg += '**Has config**\n';
      if (idx.directoryTree?.length) {
        msg += `\n**Top-level dirs:** ${idx.directoryTree.filter((d) => !d.includes('\\')).join(', ')}\n`;
      }
    } else {
      msg += 'No codebase index available. Use a tool to scan the project first.';
    }
    const ctxTp = injectContext(input, action, project.codebaseIndex);
    if (ctxTp) msg += `\n\n${ctxTp}`;
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
  },

  'project.context.tests'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx || !idx.hasTests) {
      ws.send(JSON.stringify({ type: 'answer', data: `No tests detected for **[${project.name}]**.` }));
    } else {
      let msg = `### Tests [${project.name}]\n\n✅ Test files detected.\n`;
      if (idx.fileSample) {
        const testFiles = idx.fileSample.filter((f) =>
          f.includes('test') || f.includes('spec') || f.includes('.test.')
        );
        if (testFiles.length > 0) {
          msg += `\n**Test files found:**\n${testFiles.map((f) => `- \`${f}\``).join('\n')}`;
        }
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  },

  'project.context.dependencies'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx?.keyFiles) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dependency information for **[${project.name}]**.` }));
    } else {
      const depFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'Gemfile', 'go.mod'];
      let found = false;
      let msg = `### Dependencies [${project.name}]\n\n`;
      for (const name of depFiles) {
        if (idx.keyFiles[name]) {
          msg += `**${name}**\n\`\`\`\n${idx.keyFiles[name]}\n\`\`\`\n`;
          found = true;
        }
      }
      if (!found) msg += 'No standard dependency files detected.';
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  },

  'project.context.config'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx?.keyFiles) {
      ws.send(JSON.stringify({ type: 'answer', data: `No config information for **[${project.name}]**.` }));
    } else {
      const configFiles = Object.keys(idx.keyFiles).filter(
        (name) => name.includes('.env') || name.includes('config') || name.endsWith('.json')
      );
      if (configFiles.length === 0) {
        ws.send(JSON.stringify({ type: 'answer', data: `No config files detected for **[${project.name}]**.` }));
      } else {
        let msg = `### Configuration [${project.name}]\n\n`;
        for (const name of configFiles.slice(0, 3)) {
          msg += `**${name}**\n\`\`\`\n${idx.keyFiles[name]}\n\`\`\`\n`;
        }
        ws.send(JSON.stringify({ type: 'answer', data: msg }));
      }
    }
  },

  'project.context.routes'(ws, _action, _input, project) {
    // New (2026-07-30, requested directly): surfaces idx.apiRoutes (Express/Flask/FastAPI/Django
    // route declarations — see codebaseIndexer.js's extractRoutes()) that was already being
    // collected for the AI system prompt but had no trigger-mode-visible way to ask for it.
    const idx = project.codebaseIndex;
    const routesText = formatApiRoutes(idx?.apiRoutes, 3000);
    if (!routesText) {
      ws.send(JSON.stringify({ type: 'answer', data: `No API routes detected for **[${project.name}]** (only Express/Flask/FastAPI/Django route declarations are recognized).` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Detected API routes [${project.name}]\n\n\`\`\`\n${routesText}\n\`\`\`` }));
    }
  },

  'project.context.file_relations'(ws, _action, input, project) {
    // New (2026-07-30, requested directly): "which files import X" / "who uses this file" —
    // leverages the reverse-import index already attached to each repoMap entry
    // (buildReverseImportIndex() in codebaseIndexer.js) instead of scanning anything fresh.
    const idx = project.codebaseIndex;
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      ws.send(JSON.stringify({ type: 'answer', data: `Which file? Try "which files import utils.js" or "what does state.js import".` }));
    } else {
      const entry = (idx?.repoMap || []).find((e) => e.path === fileName || e.path.endsWith('/' + fileName) || e.path.endsWith('\\' + fileName));
      if (!entry) {
        ws.send(JSON.stringify({ type: 'answer', data: `Couldn't find "${fileName}" in the indexed repo map. Try "read file ${fileName}" to check the exact path, or re-scan the project.` }));
      } else {
        const parts = [`### ${entry.path}`];
        parts.push(entry.imports?.length ? `**Imports:** ${entry.imports.join(', ')}` : '**Imports:** (none detected)');
        parts.push(entry.importedBy?.length ? `**Imported by:** ${entry.importedBy.join(', ')}` : '**Imported by:** (no other indexed file imports this — or it\'s not a local import)');
        ws.send(JSON.stringify({ type: 'answer', data: parts.join('\n') }));
      }
    }
  },

  'project.context.monorepo'(ws, _action, _input, project) {
    // New (2026-07-30, requested directly): surfaces idx.subPackages/isMonorepo (see
    // codebaseIndexer.js's detectSubPackages()).
    const idx = project.codebaseIndex;
    if (!idx?.isMonorepo) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** doesn't look like a monorepo — only one manifest file (package.json/pyproject.toml/Cargo.toml/etc.) was found.` }));
    } else {
      const list = idx.subPackages.map((p) => `- \`${p.path}\` (${p.manifests.join(', ')})`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### [${project.name}] looks like a monorepo\n\n${idx.subPackages.length} sub-packages detected:\n\n${list}\n\nEach should likely be run/installed independently.` }));
    }
  },

  async 'project.context.todos'(ws, _action, _input, project) {
    // New (2026-07-30, requested directly): "find all todos" — a fresh on-demand scan (see
    // codebaseIndexer.js's findTodos()), not part of the cached index since it's asked for
    // rarely enough that paying the cost on-demand beats slowing down every project select.
    const todos = await findTodos(project.path);
    if (!todos.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No TODO/FIXME/HACK/XXX comments found in **[${project.name}]** (scanned up to 150 code files).` }));
    } else {
      const list = todos.map((t) => `- **${t.tag}** \`${t.file}:${t.line}\`${t.text ? ` — ${t.text}` : ''}`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### TODO/FIXME markers in [${project.name}]\n\n${list}${todos.length >= 60 ? '\n\n_(capped at 60 results)_' : ''}` }));
    }
  },

  async 'project.context.biggest_files'(ws, _action, _input, project) {
    // New (2026-07-30, requested directly): "what's the biggest file" — on-demand fs.stat scan
    // (see codebaseIndexer.js's findBiggestFiles()), same on-demand-only reasoning as TODOs above.
    const biggest = await findBiggestFiles(project.path, 10);
    if (!biggest.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `Couldn't determine file sizes for **[${project.name}]**.` }));
    } else {
      const list = biggest.map((f) => `- \`${f.path}\` — ${(f.bytes / 1024).toFixed(1)} KB`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Largest files in [${project.name}]\n\n${list}` }));
    }
  },

  async 'project.context.dev_server_status'(ws, _action, _input, project) {
    // Intent expansion (Phase 1, 2026-08-03): "is the server running" / "is the site live" /
    // "what's the URL" now has a real intent instead of depending on a config entry or the
    // "what is the link" pre-check in connection.js happening to catch the phrasing. Reads the
    // same runningProcesses + lastDevUrls the pre-check reports — read-only, immediate, and the
    // port-collision heads-up is applied the same way the pre-check applies it.
    const proc = runningProcesses.get(project.id);
    const url = state.lastDevUrls.get(project.id);
    if (proc) {
      let msg = `**[${project.name}]** has \`${proc.command}\` running right now.`;
      if (url) msg += `\n\nOpen it at **${url}** — or say "what is the link" to see it again.`;
      else msg += `\n\nThe process is tracked but no local URL was detected yet — it may still be starting up, or it doesn't expose an HTTP server.`;
      ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(msg, url) }));
    } else if (url) {
      // Not console-tracked (started outside the console or before a restart) but we have a
      // persisted last-known URL — probe it instead of guessing. On-demand only, 3s bound.
      const probe = await probeUrl(url, 3000);
      if (probe.alive) {
        ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(
          `**[${project.name}]** is still responding at **${url}** — but it was started outside the console (or before a restart), so I can't stop it from here.`,
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
        const probe = await probeUrl(candidate, 1500);
        if (probe.alive) { found = candidate; break; }
      }
      if (found) {
        recordDevUrl(project.id, found);
        ws.send(JSON.stringify({ type: 'answer', data: withPortCollisionWarning(
          `**[${project.name}]** is responding at **${found}** — started outside the console (I probed the ports its own \`package.json\` scripts reference), so I can't stop it from here.`,
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
        `- **[${f.projectName}]** ${f.url} — ${f.alive ? `✅ responding${f.status ? ` (HTTP ${f.status})` : ''}${f.viaCandidate ? ' *(found by probing its package.json ports — not previously recorded)*' : ''}` : `❌ not responding${f.viaCandidate ? ' *(candidate port from its package.json)*' : ''}`}`
      ).join('\n');
      const liveCount = found.filter((f) => f.alive).length;
      ws.send(JSON.stringify({ type: 'answer', data: `### Server scan (${liveCount}/${found.length} alive)\n\n${lines}\n\nServers started outside the console (or before a restart) show as not console-tracked — I can only probe their URLs, not stop them.` }));
    }
  },

  async 'project.context.recent_activity'(ws, _action, _input, project) {
    // Intent expansion (Phase 2, 2026-08-03): on-demand file-mtime scan via findRecentActivity
    // (same readProjectTree walk findBiggestFiles uses — IGNORE_DIRS + dotfile skipping included),
    // deliberately not part of the cached index since it's asked for rarely.
    try {
      const recent = await findRecentActivity(project.path, { limit: 10 });
      if (!recent.length) {
        ws.send(JSON.stringify({ type: 'answer', data: `No recently modified files found for **[${project.name}]**.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `### Recently modified [${project.name}]\n\n` + recent.map(f => `- \`${f.path}\` — ${new Date(f.mtime).toLocaleString()}`).join('\n') }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Could not scan recent activity: ${err.message}\n` }));
    }
    return true;
  },

  'project.context.running_processes'(ws, _action, _input, _project) {
    // Phase 3 (2026-08-03): GLOBAL list across ALL projects from runningProcesses + lastDevUrls.
    const procs = [];
    for (const [pid, info] of runningProcesses) {
      const proj = state.activeProjectsCache.find((p) => p.id === pid);
      const url = state.lastDevUrls.get(pid);
      procs.push({ project: proj?.name || pid, command: info.command, url, runningSince: info.startedAt });
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
