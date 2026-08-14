// Phase 16 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Documents panel — the
// knowledge-base search endpoint (same persisted index + retrieval path as the chat answer).
// Read-only; the panel's search box calls this directly instead of spamming the terminal.
import { resolveProject } from '../state.js';
import { performSearch, searchProjectCode } from '../codeIndex/codeIndexSearch.js';
import { buildProjectIndex } from '../codeIndex/codeIndexBuilder.js';
import { enqueueTask } from '../taskQueue.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerKnowledgeRoutes(app) {
  app.get('/api/projects/:id/documents', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.status(400).json({ error: 'Missing ?q= parameter.' });
    const result = await searchProjectCode(project, q);
    if (result.status === 'indexing') {
      // Kick off the background build (same as the chat handler) and report indexing.
      enqueueTask(project.id, 'document index build', () => buildProjectIndex(project));
    }
    res.json({ status: result.status, results: result.results });
  }));

  // Phase 16 audit: AI-mode "ask" — the panel's free-text ask box (only visible when AI mode
  // is on client-side) posts here; the server retrieves the top chunks and hands them to the
  // model for a synthesized answer. The raw chunk list is ALWAYS returned alongside so the
  // panel can render the citations under the synthesis (retrieval is never dependent on the
  // model — a failed/unavailable model call yields { synthesis: null } and the panel falls
  // back to the chunk list, never an error).
  app.get('/api/projects/:id/documents/ask', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.status(400).json({ error: 'Missing ?q= parameter.' });
    const result = await searchProjectCode(project, q);
    if (result.status === 'indexing') {
      enqueueTask(project.id, 'document index build', () => buildProjectIndex(project));
    }
    let synthesis = null;
    if (result.status === 'ready' && result.results.length > 0) {
      const { chatOnce, listModels } = await import('../ollama.js');
      const models = (await listModels().catch(() => [])).map((m) => m.name);
      const contextText = result.results.map((r) => `[${r.filePath}:${r.startLine}]\n${r.snippet}`).join('\n\n---\n\n');
      try {
        const out = await chatOnce(models[0] || null, [
          { role: 'system', content: "Answer the user's question using ONLY the retrieved document excerpts below. If the excerpts don't answer it, say so plainly — do not invent content." },
          { role: 'user', content: `EXCERPTS:\n${contextText}\n\nQUESTION: ${q}` },
        ]);
        if (out && out.trim()) synthesis = out.trim();
      } catch {
        // model unreachable — synthesis stays null, chunk list is the fallback
      }
    }
    res.json({ status: result.status, results: result.results, synthesis });
  }));
}
