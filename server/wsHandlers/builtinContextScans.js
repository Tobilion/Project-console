import { findTodos, findBiggestFiles, findRecentActivity } from '../codebaseIndexer.js';

/**
 * On-demand scan handlers (Phase 14 split of builtinProjectContext.js, 2026-08-05 — bodies
 * moved verbatim). All three pay a fresh scan cost only when asked (rarely-asked questions,
 * deliberately NOT part of the cached index).
 */
export const contextScanHandlers = {
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
};
