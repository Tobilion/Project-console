import { injectContext } from '../contextInjector.js';
import { runningProcesses } from '../executor.js';
import { createCheckpoint } from '../gitSafety.js';
import { state, withPortCollisionWarning } from '../state.js';
import { findDocumentedRunCommands } from '../readmeRunParser.js';
import { formatApiRoutes, findTodos, findBiggestFiles, findRecentActivity } from '../codebaseIndexer.js';
import { probeUrl, scanProjectServers, candidateDevUrls } from '../livenessProbe.js';
import { recordDevUrl } from '../devUrlStore.js';
import { parseFileNameOnly, enrichWithIndex } from './builtinHelpers.js';
import { gitHandlers } from './builtinGit.js';
import { chitChatHandlers } from './builtinChitChat.js';
import { fileNpmHandlers } from './builtinFileNpm.js';

/**
 * Confirmed live 2026-07-30 (Matchday Exchange transcript): "run its server" and "run .bat" both
/** Handles all built-in (non-project-config, non-AI) conversational intents. Returns false if the action wasn't recognized. */
export async function handleBuiltinIntent(ws, action, input, project, sessionContext) {
  if (action === 'system.chit_chat.undo' || action === 'undo') {
    return await chitChatHandlers['system.chit_chat.undo'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.greeting') {
    return await chitChatHandlers['system.chit_chat.greeting'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.status') {
    return await chitChatHandlers['system.chit_chat.status'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.gratitude') {
    return await chitChatHandlers['system.chit_chat.gratitude'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.farewell') {
    return await chitChatHandlers['system.chit_chat.farewell'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.identity') {
    return await chitChatHandlers['system.chit_chat.identity'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.needs_ai_mode') {
    return await chitChatHandlers['system.chit_chat.needs_ai_mode'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.ack') {
    return await chitChatHandlers['system.chit_chat.ack'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.joke') {
    return await chitChatHandlers['system.chit_chat.joke'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.clear') {
    return await chitChatHandlers['system.chit_chat.clear'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.help') {
    return await chitChatHandlers['system.chit_chat.help'](ws, action, input, project, sessionContext);
  } else if (action === 'project.knowledge.overview') {
    const descEntry = project.config.entries?.find((e) => e.type === 'answer' && e.triggers?.some((t) => t.includes('describe') || t.includes('overview') || t.includes('what')));
    let responseText = `### ${project.name}\n\n**Path:** \`${project.path}\`\n**Config Entries:** ${project.config.entries?.length || 0} actions/answers.`;
    if (descEntry) {
      responseText = descEntry.response;
    } else if (project.contextFiles && project.contextFiles.length > 0) {
      const mainDoc = project.contextFiles[0];
      const snippet = mainDoc.content.substring(0, 500) + '...';
      responseText = `### Overview from ${mainDoc.filename}\n\n${snippet}`;
    }
    responseText = enrichWithIndex(responseText, project.codebaseIndex);
    const ctx = injectContext(input, action, project.codebaseIndex);
    if (ctx) responseText += `\n\n${ctx}`;
    responseText += '\n\n*Type "explain more" for deeper details.*';
    ws.send(JSON.stringify({ type: 'answer', data: responseText }));
  } else if (action === 'project.knowledge.stack') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Tech Stack\n\n${project.parsedKnowledge?.stack || 'No stack information parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.commands') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Commands\n\n${project.parsedKnowledge?.commands || 'No commands parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.gotchas') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Gotchas / Known Issues\n\n${project.parsedKnowledge?.gotchas || 'No known issues parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.architecture') {
    ws.send(JSON.stringify({ type: 'answer', data: `### Architecture\n\n${project.parsedKnowledge?.architecture || 'No architecture information parsed from markdown.'}` }));
  } else if (action === 'project.knowledge.how_to_run') {
    // Requested directly (2026-07-30): a purely informational "how do I run/install/set this up"
    // answer — distinct from `run_project`, which actually executes a command. This is meant to
    // answer "how much can trigger mode (no AI) understand from the README" specifically: it
    // never guesses silently, it always says where the answer came from (a documented command
    // vs. a language-based inference vs. "nothing found, turn on AI mode").
    const documented = findDocumentedRunCommands(project);
    const idx = project.codebaseIndex;
    let msg;
    if (documented.length) {
      const single = documented.length === 1;
      const lines = documented.map((d, i) => {
        const srcLabel = d.header
          ? `Documented in **${d.doc}** under "${d.header}"`
          : `Found this command in **${d.doc}**`;
        const code = `\`\`\`\n${d.command}\n\`\`\``;
        return single ? `${srcLabel}:\n\n${code}` : `${i + 1}. ${srcLabel}:\n\n${code}`;
      });
      msg = lines.join('\n\n');
    } else if (idx?.frameworks?.length || idx?.languages?.length) {
      const parts = [];
      if (idx.languages?.length) parts.push(`**Languages:** ${idx.languages.slice(0, 4).join(', ')}`);
      if (idx.frameworks?.length) parts.push(`**Detected stack:** ${idx.frameworks.join(', ')}`);
      if (idx.entryPoints?.length) parts.push(`**Entry point(s):** ${idx.entryPoints.join(', ')}`);
      msg = `No documented run command found in this project's README/CLAUDE.md, but here's what was detected from the code itself:\n\n${parts.join('\n')}\n\nSay "run project" and I'll suggest a command based on this, or turn AI mode on for it to work it out from the source directly.`;
    }
    // 2026-08-03 (requested directly): always also list every exact command this project has
    // configured (console.config.json entries), so "how do I run/do X" gets the full precise
    // command list even when the README documents nothing — and without duplicating an entry
    // already shown as the documented command above.
    const documentedCmds = new Set(documented.map((d) => d.command));
    const configured = (project.config?.entries || []).filter((e) => e.type === 'command' && e.action && !documentedCmds.has(e.action));
    if (configured.length) {
      const list = configured
        .map((e) => `- \`${e.action}\`${e.params?.length ? ` (asks for: ${e.params.map((p) => p.name).join(', ')})` : ''}`)
        .join('\n');
      msg = msg ? `${msg}\n\n**Configured commands (exact):**\n${list}` : `**Configured commands (exact):**\n${list}`;
    }
    if (!msg) {
      msg = `Nothing documented or detected about how to run this project. Try "run project" for a best-effort guess, or turn AI mode on.`;
    }
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
  } else if (action === 'system.chit_chat.explain_followup') {
    return await chitChatHandlers['system.chit_chat.explain_followup'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.yes_no') {
    return await chitChatHandlers['system.chit_chat.yes_no'](ws, action, input, project, sessionContext);
  } else if (action === 'git_push') {
    return await gitHandlers.git_push(ws, action, input, project, sessionContext);
  } else if (action === 'git_remote_add') {
    return await gitHandlers.git_remote_add(ws, action, input, project, sessionContext);
  } else if (action === 'git_commit') {
    return await gitHandlers.git_commit(ws, action, input, project, sessionContext);
  } else if (action === 'git_commit_push') {
    return await gitHandlers.git_commit_push(ws, action, input, project, sessionContext);
  } else if (action === 'git_add') {
    return await gitHandlers.git_add(ws, action, input, project, sessionContext);
  } else if (action === 'git_init') {
    return await gitHandlers.git_init(ws, action, input, project, sessionContext);
  } else if (action === 'git_ignore_add') {
    return await gitHandlers.git_ignore_add(ws, action, input, project, sessionContext);
  } else if (action === 'git_rm_cached') {
    return await gitHandlers.git_rm_cached(ws, action, input, project, sessionContext);
  } else if (action === 'npm_install') {
    return await fileNpmHandlers.npm_install(ws, action, input, project, sessionContext);
  } else if (action === 'npm_build') {
    return await fileNpmHandlers.npm_build(ws, action, input, project, sessionContext);
  } else if (action === 'npm_run') {
    return await fileNpmHandlers.npm_run(ws, action, input, project, sessionContext);
  } else if (action === 'file_create') {
    return await fileNpmHandlers.file_create(ws, action, input, project, sessionContext);
  } else if (action === 'file_append') {
    return await fileNpmHandlers.file_append(ws, action, input, project, sessionContext);
  } else if (action === 'run_tests') {
    return await fileNpmHandlers.run_tests(ws, action, input, project, sessionContext);
  } else if (action === 'file_read') {
    return await fileNpmHandlers.file_read(ws, action, input, project, sessionContext);
  } else if (action === 'file_find') {
    return await fileNpmHandlers.file_find(ws, action, input, project, sessionContext);
  } else if (action === 'file_delete') {
    return await fileNpmHandlers.file_delete(ws, action, input, project, sessionContext);
  } else if (action === 'project_scan') {
    ws.send(JSON.stringify({ type: 'answer', data: `To reindex this project, select it again in the project list (web UI) or type "projects" (CLI chat) — either one triggers a fresh index.` }));
  } else if (action === 'project_list') {
    // Confirmed live 2026-07-29: this used to fall through to project_scan's reindex answer and
    // tell people to "restart the console" — wrong on both counts (nothing here is about
    // reindexing, and switching projects never required a restart). Real fix: a dedicated intent
    // that lists what's actually available and points at the real switch mechanism for whichever
    // interface the user is in — a project card click in the web UI, or the CLI's own "projects"
    // command (added alongside this).
    const projects = state.activeProjectsCache || [];
    const list = projects.length > 0
      ? projects.map((p) => `  - ${p.name}`).join('\n')
      : '  (none found — is the scan directory set correctly?)';
    ws.send(JSON.stringify({
      type: 'answer',
      data: `**Available projects:**\n${list}\n\nIn the web UI, click a different project card in the sidebar to switch — no restart needed. In CLI chat, type "projects" to rescan and pick a different one.`,
    }));
  } else if (action === 'system.chit_chat.port') {
    return await chitChatHandlers['system.chit_chat.port'](ws, action, input, project, sessionContext);
  } else if (action === 'git_log') {
    return await gitHandlers.git_log(ws, action, input, project, sessionContext);
  } else if (action === 'git_branch') {
    return await gitHandlers.git_branch(ws, action, input, project, sessionContext);
  } else if (action === 'git_checkout') {
    return await gitHandlers.git_checkout(ws, action, input, project, sessionContext);
  } else if (action === 'git_diff') {
    return await gitHandlers.git_diff(ws, action, input, project, sessionContext);
  } else if (action === 'git_stash') {
    return await gitHandlers.git_stash(ws, action, input, project, sessionContext);
  } else if (action === 'git_stash_list') {
    return await gitHandlers.git_stash_list(ws, action, input, project, sessionContext);
  } else if (action === 'git_stash_pop') {
    return await gitHandlers.git_stash_pop(ws, action, input, project, sessionContext);
  } else if (action === 'git_branch_create') {
    return await gitHandlers.git_branch_create(ws, action, input, project, sessionContext);
  } else if (action === 'git_pull') {
    return await gitHandlers.git_pull(ws, action, input, project, sessionContext);
  } else if (action === 'git_fetch') {
    return await gitHandlers.git_fetch(ws, action, input, project, sessionContext);
  } else if (action === 'git_ahead_behind') {
    return await gitHandlers.git_ahead_behind(ws, action, input, project, sessionContext);
  } else if (action === 'git_tag') {
    return await gitHandlers.git_tag(ws, action, input, project, sessionContext);
  } else if (action === 'project.workflow.checkpoint') {
    // Intent expansion (Phase 2, 2026-08-03, requested directly): an explicit user-asked
    // checkpoint commit — same createCheckpoint the auto-checkpoint-before-risky-commands flow
    // uses. A normal, recoverable commit, so no confirm; non-git projects get createCheckpoint's
    // own message surfaced as-is.
    const result = await createCheckpoint(project.path, input);
    if (result.success) {
      ws.send(JSON.stringify({ type: 'answer', data: result.message }));
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: (result.message || result.error || 'Checkpoint failed.') + '\n' }));
    }
    return true;
  } else if (action === 'run_project') {
    return await fileNpmHandlers.run_project(ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.git_status') {
    return await chitChatHandlers['system.chit_chat.git_status'](ws, action, input, project, sessionContext);
  } else if (action === 'system.chit_chat.deploy') {
    return await chitChatHandlers['system.chit_chat.deploy'](ws, action, input, project, sessionContext);
  } else if (action === 'project.context.structure') {
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
  } else if (action === 'project.context.languages') {
    const idx = project.codebaseIndex;
    if (!idx?.languages?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No language data indexed for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Languages in [${project.name}]\n\n${idx.languages.map((l) => `- ${l}`).join('\n')}` }));
    }
  } else if (action === 'project.context.file_count') {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No index data for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Project Size [${project.name}]\n\n- **Total files:** ${idx.totalFiles}\n- **Total directories:** ${idx.totalDirs}\n- **Languages:** ${(idx.languages || []).slice(0, 5).join(', ') || 'N/A'}` }));
    }
  } else if (action === 'project.context.entry_point') {
    const idx = project.codebaseIndex;
    if (!idx?.entryPoints?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No entry point detected for **[${project.name}]**. Try "show me the project structure" to explore.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Entry Points [${project.name}]\n\n${idx.entryPoints.map((e) => `- \`${e}\``).join('\n')}` }));
    }
  } else if (action === 'project.context.tech_preview') {
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
  } else if (action === 'project.context.tests') {
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
  } else if (action === 'project.context.dependencies') {
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
  } else if (action === 'project.context.config') {
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
  } else if (action === 'project.context.routes') {
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
  } else if (action === 'project.context.file_relations') {
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
  } else if (action === 'project.context.monorepo') {
    // New (2026-07-30, requested directly): surfaces idx.subPackages/isMonorepo (see
    // codebaseIndexer.js's detectSubPackages()).
    const idx = project.codebaseIndex;
    if (!idx?.isMonorepo) {
      ws.send(JSON.stringify({ type: 'answer', data: `**[${project.name}]** doesn't look like a monorepo — only one manifest file (package.json/pyproject.toml/Cargo.toml/etc.) was found.` }));
    } else {
      const list = idx.subPackages.map((p) => `- \`${p.path}\` (${p.manifests.join(', ')})`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### [${project.name}] looks like a monorepo\n\n${idx.subPackages.length} sub-packages detected:\n\n${list}\n\nEach should likely be run/installed independently.` }));
    }
  } else if (action === 'project.context.todos') {
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
  } else if (action === 'project.context.biggest_files') {
    // New (2026-07-30, requested directly): "what's the biggest file" — on-demand fs.stat scan
    // (see codebaseIndexer.js's findBiggestFiles()), same on-demand-only reasoning as TODOs above.
    const biggest = await findBiggestFiles(project.path, 10);
    if (!biggest.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `Couldn't determine file sizes for **[${project.name}]**.` }));
    } else {
      const list = biggest.map((f) => `- \`${f.path}\` — ${(f.bytes / 1024).toFixed(1)} KB`).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Largest files in [${project.name}]\n\n${list}` }));
    }
  } else if (action === 'project.context.dev_server_status') {
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
  } else if (action === 'project.context.scan_servers') {
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
  } else if (action === 'project.context.recent_activity') {
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
  } else if (action === 'system.monitoring.metrics') {
    const { default: fetch } = await import('node-fetch');
    try {
      const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/metrics`);
      const snap = await res.json();
      const counters = Object.entries(snap.counters || {}).map(([k, v]) => `- **${k}**: ${v}`).join('\n');
      let histoLines = '';
      for (const [name, stats] of Object.entries(snap.histograms || {})) {
        if (stats) {
          histoLines += `\n**${name}** — count: ${stats.count}, avg: ${stats.avg.toFixed(0)}ms, p95: ${stats.p95}ms, p99: ${stats.p99}ms`;
        }
      }
      const recent = (snap.recentEvents || []).slice(-10).map((e) =>
        `- ${e.type} (${new Date(e.ts).toLocaleTimeString()})${e.duration ? ` ${e.duration}ms` : ''}${e.outcome ? ` → ${e.outcome}` : ''}`
      ).join('\n');
      ws.send(JSON.stringify({ type: 'answer', data: `### Console Metrics\n\n**Counters:**\n${counters || '_(none)_'}\n\n**Latency:**${histoLines || ' _(none)_'}\n\n**Recent Events:**\n${recent || ' _(none)_'}` }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'answer', data: `### Console Metrics\n\nCould not fetch metrics: ${err.message}` }));
    }
  } else if (action === 'project.action.open_in_vscode') {
    // Phase 3 (2026-08-03): open project folder in VS Code. If `code` not on PATH, answer with
    // guidance instead of the raw error.
    const { spawn } = await import('child_process');
    const child = spawn('code', [project.path], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      if (err.code === 'ENOENT' || err.message.includes('not recognized')) {
        ws.send(JSON.stringify({ type: 'answer', data: `VS Code \`code\` CLI not found on PATH. Open VS Code manually and use File → Open Folder → \`${project.path}\`.` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open VS Code: ${err.message}\n` }));
      }
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** in VS Code...` }));
  } else if (action === 'project.action.open_in_explorer') {
    // Phase 3 (2026-08-03): open project folder in OS file explorer — branch on platform.
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let cmd, args;
    if (isWindows) {
      cmd = 'explorer';
      args = [project.path];
    } else if (isMac) {
      cmd = 'open';
      args = [project.path];
    } else {
      cmd = 'xdg-open';
      args = [project.path];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open folder: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **[${project.name}]** folder in file explorer...` }));
  } else if (action === 'project.action.open_site') {
    // Phase 3 (2026-08-03): open the dev server URL in browser. Reads state.lastDevUrls.
    const url = state.lastDevUrls.get(project.id);
    if (!url) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dev server URL recorded for **[${project.name}]**. Say "run the site" to start it, or "what is the link" if you think it's already running.` }));
      return true;
    }
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const cmd = isWindows ? 'start' : isMac ? 'open' : 'xdg-open';
    const args = isWindows ? ['', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: isWindows });
    child.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to open browser: ${err.message}\n` }));
    });
    child.unref();
    ws.send(JSON.stringify({ type: 'answer', data: `Opening **${url}** in your browser...` }));
  } else if (action === 'project.action.copy_path') {
    // Phase 3 (2026-08-03): emit copy_to_clipboard WS event — frontend handles clipboard write.
    ws.send(JSON.stringify({ type: 'copy_to_clipboard', data: project.path }));
    ws.send(JSON.stringify({ type: 'answer', data: `Copied **[${project.name}]** path to clipboard:\n\`${project.path}\`` }));
  } else if (action === 'git_remote_info') {
    return await gitHandlers.git_remote_info(ws, action, input, project, sessionContext);
  } else if (action === 'project.context.running_processes') {
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
  } else if (action === 'project.context.session_info') {
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
  } else {
    return false; // unrecognized intent
  }
  return true;
}
