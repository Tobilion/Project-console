// Phase 16 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Documents panel — the
// knowledge-base search endpoint (same persisted index + retrieval path as the chat answer).
// Read-only; the panel's search box calls this directly instead of spamming the terminal.
import { resolveProject } from '../state.js';
import { performSearch, searchProjectCode } from '../codeIndex/codeIndexSearch.js';
import { buildProjectIndex } from '../codeIndex/codeIndexBuilder.js';
import { enqueueTask } from '../taskQueue.js';

export function registerKnowledgeRoutes(app) {
  app.get('/api/projects/:id/documents', async (req, res) => {
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
  });
}
