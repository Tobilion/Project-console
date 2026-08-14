import { formatApiRoutes } from '../codebaseIndexer.js';
import { parseFileNameOnly } from './builtinHelpers.js';
import { resolveTargetFile } from '../codebaseGraph.js';
import path from 'path';

/**
 * Repo-map handlers (Phase 14 split of builtinProjectContext.js, 2026-08-05 — bodies moved
 * verbatim). All leverage data already attached to the cached index (apiRoutes, repoMap
 * entries with imports/importedBy, subPackages) — no fresh scans.
 */
export const contextRepoMapHandlers = {
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

  'project.context.file_relations'(ws, _action, input, project, sessionContext) {
    // New (2026-07-30, requested directly): "which files import X" / "who uses this file" —
    // leverages the reverse-import index already attached to each repoMap entry
    // (buildReverseImportIndex() in codebaseIndexer.js) instead of scanning anything fresh.
    const idx = project.codebaseIndex;
    const fileName = parseFileNameOnly(input);
    if (!fileName) {
      // Stage the follow-up so a bare "app.tsx" reply resolves this question instead of
      // dead-ending in the fallback (see handlePendingFileQuestionReply — Matchday-Exchange
      // live session, 2026-08-14).
      if (sessionContext) {
        sessionContext.pendingFileQuestion = { projectId: project.id, intent: 'project.context.file_relations' };
      }
      ws.send(JSON.stringify({ type: 'answer', data: `Which file? Try "which files import utils.js" or "what does state.js import".` }));
    } else {
      // Exact-match first, then the shared typo-tolerant resolver ("app.tx" -> App.tsx —
      // Matchday-Exchange live session, 2026-08-14; same resolver the AI context slice uses).
      let entry = (idx?.repoMap || []).find((e) => e.path === fileName || e.path.endsWith('/' + fileName) || e.path.endsWith('\\' + fileName));
      let fuzzyNote = '';
      if (!entry) {
        const resolved = resolveTargetFile(idx, fileName);
        if (resolved) {
          entry = (idx?.repoMap || []).find((e) => e.path === resolved) || null;
          if (entry && path.basename(resolved).toLowerCase() !== fileName.toLowerCase()) {
            fuzzyNote = `\n\n_(matched \`${resolved}\` — did you mean this file?)_`;
          }
        }
      }
      if (!entry) {
        ws.send(JSON.stringify({ type: 'answer', data: `Couldn't find "${fileName}" in the indexed repo map. Try "read file ${fileName}" to check the exact path, or re-scan the project.` }));
      } else {
        const parts = [`### ${entry.path}`];
        parts.push(entry.imports?.length ? `**Imports:** ${entry.imports.join(', ')}` : '**Imports:** (none detected)');
        parts.push(entry.importedBy?.length ? `**Imported by:** ${entry.importedBy.join(', ')}` : '**Imported by:** (no other indexed file imports this — or it\'s not a local import)');
        if (fuzzyNote) parts.push(fuzzyNote);
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
};
