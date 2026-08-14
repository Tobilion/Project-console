// Phase 2 catch-up (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the File Tools panel.
// Read-only endpoints (file listing/search, duplicate scan) so the panel can render its three
// sub-views without spamming the chat; mutations (tidy, duplicates_delete) go through the
// normal WS trigger-command path — confirm cards, journaling, and the terminal stay the single
// source of truth (same contract as every other panel in this roadmap).
import fs from 'fs';
import path from 'path';
import { resolveProject } from '../state.js';
import { walkDir, isTextFile } from '../toolScan.js';
import { createResolveSafe } from '../toolSandbox.js';
import { findDuplicates, planTidy } from '../wsHandlers/builtinGeneralFiles.js';
import { asyncHandler } from '../asyncHandler.js';

const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 20;
const MAX_CONTENT_FILE_BYTES = 20000;

function findProject(req) {
  return resolveProject(req.params.id) || null;
}

/** List directory entries with size + mod date; optional name substring filter. */
function listEntries(projectRoot, dirPath, search) {
  const resolve = createResolveSafe(projectRoot);
  let absDir;
  try {
    absDir = resolve(dirPath || '.');
  } catch {
    return { error: 'Path escapes the project root.' };
  }
  if (!fs.existsSync(absDir)) return { error: `Directory not found: ${dirPath || '.'}` };
  const entries = [];
  try {
    for (const name of fs.readdirSync(absDir)) {
      if (entries.length >= MAX_LIST_ENTRIES) break;
      if (name.startsWith('.') && name !== '.gitignore') continue; // skip dotfiles (and .console)
      const p = path.join(absDir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (search && !name.toLowerCase().includes(search.toLowerCase())) continue;
        entries.push({ name, path: path.join(dirPath || '.', name).replace(/\\/g, '/'), isDir: true, size: 0, modifiedAt: st.mtimeMs });
      } else {
        if (search && !name.toLowerCase().includes(search.toLowerCase())) continue;
        entries.push({ name, path: path.join(dirPath || '.', name).replace(/\\/g, '/'), isDir: false, size: st.size, modifiedAt: st.mtimeMs });
      }
    }
  } catch { return { error: 'Could not read the directory.' }; }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

/** Walk the project tree and return name + content hits in MAX_SEARCH_RESULTS flat results. */
async function searchFiles(projectRoot, needle) {
  const files = await walkDir(projectRoot);
  const results = [];
  const q = needle.toLowerCase();
  for (const file of files) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
    // name match
    const base = path.basename(file);
    if (base.toLowerCase().includes(q)) {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(file); size = st.size; mtime = st.mtimeMs; } catch {}
      results.push({ path: rel, match: 'name', size, modifiedAt: mtime });
      continue;
    }
    // content match
    if (!isTextFile(file)) continue;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_CONTENT_FILE_BYTES) continue;
    } catch { continue; }
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (content.toLowerCase().includes(q)) {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(file); size = st.size; mtime = st.mtimeMs; } catch {}
      results.push({ path: rel, match: 'content', size, modifiedAt: mtime });
    }
  }
  return results;
}

export function registerFileToolsRoutes(app) {
  // File listing — optionally scoped to a sub-directory (?path=) and name-filtered (?search=).
  app.get('/api/projects/:id/files', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const dirPath = typeof req.query.path === 'string' ? req.query.path : '.';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const result = listEntries(project.path, dirPath, search);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  }));

  // Content + name search across the full project tree (flat results, not dir-scoped).
  app.get('/api/projects/:id/search-files', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.status(400).json({ error: 'Missing ?q= parameter.' });
    const results = await searchFiles(project.path, q);
    res.json({ results });
  }));

  // Tidy plan for the panel's move-preview table (?by=type|date) — the same planTidy the
  // chat confirm flow uses, so the preview and the actual move can never diverge.
  app.get('/api/projects/:id/tidy-plan', (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const by = req.query.by === 'date' ? 'date' : 'type';
    const input = by === 'date' ? 'organize this folder by date' : 'tidy this folder';
    const result = planTidy(project.path, input);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ moves: result.moves });
  });

  // Duplicate scan — reuses the existing findDuplicates orchestrator, enriched per group
  // with the keep-newest selection (same rule as planDuplicateDeletes) for the panel's
  // checkbox conventions.
  app.get('/api/projects/:id/duplicates', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const result = await findDuplicates(project.path);
    const groups = result.groups.map((g) => {
      const newest = g.reduce((a, b) => (b.mtime > a.mtime ? b : a));
      return {
        files: g.map((f) => ({ path: f.path, size: f.size, modifiedAt: f.mtime })),
        waste: g[0].size * (g.length - 1),
        keepPath: newest.path,
      };
    });
    res.json({ groups, skippedBig: result.skippedBig, totalWasted: result.totalWasted });
  }));
}
