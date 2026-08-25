import { createCheckpoint } from '../gitSafety.js';
import { state } from '../state.js';
import { findDocumentedRunCommands } from '../readmeRunParser.js';
import { enrichWithIndex } from './builtinHelpers.js';
import { injectContext } from '../contextInjector.js';
import { searchProjectCode, performSearch } from '../codeIndex/codeIndexSearch.js';
import { buildProjectIndex } from '../codeIndex/codeIndexBuilder.js';
import { enqueueTask } from '../taskQueue.js';

/**
 * project.knowledge.* / project_scan / project_list / project.workflow.* — the knowledge and
 * project-management branch bodies extracted verbatim from builtinIntents.js (Phase 10 step 5).
 */
export const projectKnowledgeHandlers = {
  async 'project.knowledge.overview'(ws, action, input, project) {
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
  },

  'project.knowledge.stack'(ws, _action, _input, project) {
    ws.send(JSON.stringify({ type: 'answer', data: `### Tech Stack\n\n${project.parsedKnowledge?.stack || 'No stack information parsed from markdown.'}` }));
  },

  'project.knowledge.commands'(ws, _action, _input, project) {
    ws.send(JSON.stringify({ type: 'answer', data: `### Commands\n\n${project.parsedKnowledge?.commands || 'No commands parsed from markdown.'}` }));
  },

  'project.knowledge.gotchas'(ws, _action, _input, project) {
    ws.send(JSON.stringify({ type: 'answer', data: `### Gotchas / Known Issues\n\n${project.parsedKnowledge?.gotchas || 'No known issues parsed from markdown.'}` }));
  },

  'project.knowledge.architecture'(ws, _action, _input, project) {
    ws.send(JSON.stringify({ type: 'answer', data: `### Architecture\n\n${project.parsedKnowledge?.architecture || 'No architecture information parsed from markdown.'}` }));
  },

  async 'project.knowledge.how_to_run'(ws, _action, _input, project) {
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
    // Phase 9 (2026-08-11, requested directly): show how to ASK as well as what to RUN — the
    // example phrasings teach the chat side, and a suggestion chip offers the best runnable
    // command (config entries first — they're authored for this exact console — then the first
    // documented command). Chip is a click, nothing auto-runs.
    msg += `\n\n**Try saying:** "run the site", "start the server", "run the project"`;
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
    const bestChip = configured[0]?.action || documented[0]?.command;
    if (bestChip) {
      ws.send(JSON.stringify({ type: 'suggestions', data: [bestChip] }));
    }
  },

  'project_scan'(ws) {
    ws.send(JSON.stringify({ type: 'answer', data: `To reindex this project, select it again in the project list (web UI) or type "projects" (CLI chat) — either one triggers a fresh index.` }));
  },

  'project_list'(ws) {
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
  },

  async 'project.workflow.checkpoint'(ws, _action, input, project) {
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
  },

  async 'project.code.search'(ws, _action, input, project) {
    // Phase 7 (2026-08-11): semantic code search over the persisted per-project code index
    // (codeIndexSearch.js). Read-only retrieval — answers with real file:line citations, never
    // fabricated code. A missing index kicks off a background build through taskQueue (never
    // blocks the chat turn) and posts the results out of band, same shape as type_check.
    const formatResults = (results, query) => {
      if (results.length === 0) {
        return `### Code search — [${project.name}]\n\nNo matching code found for "${query}". The index covers code files up to the per-project cap (${project.name}'s changes update automatically on save).`;
      }
      const lines = results.map((r, i) => {
        const loc = `${r.filePath}:${r.startLine}${r.endLine && r.endLine !== r.startLine ? `-${r.endLine}` : ''}`;
        return `${i + 1}. **${loc}**\n\n\`\`\`\n${r.snippet}\n\`\`\``;
      });
      return `### Code search — [${project.name}]\n\nFound ${results.length} match(es) for "${query}" (semantic search results retrieved from the code index, not generated):\n\n${lines.join('\n\n')}`;
    };
    const result = await searchProjectCode(project, input);
    if (result.status === 'unavailable') {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Semantic code search needs the embedding model, which failed to load this session — try again after a restart, or use "find code ..." name-based file search instead.`,
      }));
      return true;
    }
    if (result.status === 'indexing') {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Indexing **[${project.name}]**'s code in the background (first search builds the index) — I'll post the file:line results here when ready.`,
      }));
      enqueueTask(project.id, 'code index build', async () => {
        await buildProjectIndex(project);
        const results = await performSearch(project, input);
        // toast: true — out-of-band background result (the user asked, then kept working).
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'answer', data: formatResults(results, input), toast: true }));
      });
      return true;
    }
    ws.send(JSON.stringify({ type: 'answer', data: formatResults(result.results, input) }));
    return true;
  },

  async 'project.knowledge.ask_documents'(ws, _action, input, project, sessionContext) {
    // Phase 16 (2026-08-12): knowledge-base search over documents (PDFs/docx/notes) — the
    // SAME persisted code-index store (the builder now chunks doc files too), so search and
    // status handling mirror project.code.search exactly. Retrieval-only by default: real
    // file citations, no generated prose. When AI mode is ON and a model is reachable, the
    // retrieved chunks are handed to the model for a synthesized natural-language answer —
    // the raw chunk list stays the fallback, never an error state.
    const formatResults = (results, query) => {
      if (results.length === 0) {
        return `### Documents — [${project.name}]\n\nNo documents match "${query}". The knowledge base covers PDFs, .docx and .md/.txt files up to the per-project cap.`;
      }
      const lines = results.map((r, i) => {
        const loc = `${r.filePath}:${r.startLine}${r.endLine && r.endLine !== r.startLine ? `-${r.endLine}` : ''}`;
        return `${i + 1}. **${loc}**\n\n\`\`\`\n${r.snippet}\n\`\`\``;
      });
      return `### Documents — [${project.name}]\n\nFound ${results.length} match(es) for "${query}" (retrieved from the document index, not generated):\n\n${lines.join('\n\n')}`;
    };
    const result = await searchProjectCode(project, input);
    if (result.status === 'unavailable') {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Document search needs the embedding model, which failed to load this session — try again after a restart.`,
      }));
      return true;
    }
    if (result.status === 'indexing') {
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Indexing **[${project.name}]**'s documents in the background (first search builds the index) — I'll post the results here when ready.`,
      }));
      enqueueTask(project.id, 'document index build', async () => {
        await buildProjectIndex(project);
        const results = await performSearch(project, input);
        // toast: true — out-of-band background result, same contract as code.search.
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'answer', data: formatResults(results, input), toast: true }));
      });
      return true;
    }
    // Retrieval done. AI-mode synthesis (optional, additive): only when AI is on AND a model
    // answered — otherwise the raw chunk list is the answer, never an error.
    if (sessionContext?.aiEnabled) {
      const { chatOnce, listModels } = await import('../ollama.js');
      const model = sessionContext.aiModel || null;
      const models = model ? [model] : (await listModels().catch(() => [])).map((m) => m.name);
      const contextText = result.results.map((r) => `[${r.filePath}:${r.startLine}]\n${r.snippet}`).join('\n\n---\n\n');
      try {
        const synthesized = await chatOnce(models[0] || null, [
          { role: 'system', content: "Answer the user's question using ONLY the retrieved document excerpts below. If the excerpts don't answer it, say so plainly — do not invent content." },
          { role: 'user', content: `EXCERPTS:\n${contextText}\n\nQUESTION: ${input}` },
        ]);
        if (synthesized && synthesized.trim()) {
          ws.send(JSON.stringify({
            type: 'answer',
            data: `### Documents — [${project.name}]\n\n${synthesized.trim()}\n\n---\n\n${formatResults(result.results, input)}`,
          }));
          return true;
        }
      } catch {
        // synthesis failed — fall through to the raw chunk list
      }
    }
    ws.send(JSON.stringify({ type: 'answer', data: formatResults(result.results, input) }));
    return true;
  },
};
