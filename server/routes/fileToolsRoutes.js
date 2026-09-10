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
import { findDuplicates, planTidy, performTidy, performDuplicateDeletes, planDuplicateDeletes, performRename, performMove, performCreate, performDelete, performCopy } from '../wsHandlers/builtinGeneralFiles.js';
import { createCheckpoint } from '../gitSafety.js';
import { asyncHandler } from '../asyncHandler.js';

const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 20;
const MAX_CONTENT_FILE_BYTES = 20000;

function findProject(req) {
  // Phase T (2026-08-14): resolve inside the requesting tab's workspace when ?tab= is given.
  return resolveProject(req.params.id, req.query.tab) || null;
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
  const q = needle.toLowerCase();

  // Phase 6: per-file stat + read were serial sync calls — a large tree paid the whole walk
  // then a stat per file through the event loop. The content pass now runs with bounded
  // concurrency (fs/promises); results are tagged with their walk index and re-ordered at
  // the end, so the returned set stays deterministic (first matches in walk order) instead
  // of being racer-dependent.
  const statFile = async (file) => {
    try { return await fs.promises.stat(file); } catch { return null; }
  };

  const scanOne = async (file) => {
    const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
    const base = path.basename(file);
    const st = await statFile(file);
    if (base.toLowerCase().includes(q)) {
      return { path: rel, match: 'name', size: st?.size ?? 0, modifiedAt: st?.mtimeMs ?? 0 };
    }
    if (!isTextFile(file)) return null;
    if (!st || st.size > MAX_CONTENT_FILE_BYTES) return null;
    let content;
    try { content = await fs.promises.readFile(file, 'utf-8'); } catch { return null; }
    if (content.toLowerCase().includes(q)) {
      return { path: rel, match: 'content', size: st.size, modifiedAt: st.mtimeMs };
    }
    return null;
  };

  const tagged = [];
  const POOL = 8;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const idx = next++;
      const hit = await scanOne(files[idx]);
      if (hit) tagged.push({ idx, hit });
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, () => worker()));
  return tagged
    .sort((a, b) => a.idx - b.idx)
    .map((t) => t.hit)
    .slice(0, MAX_SEARCH_RESULTS);
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

  // Phase T (2026-08-14): static-file mount for in-console HTML preview. Serves any file
  // relative to the project root under /static/* so a previewed .html's relative assets
  // (./style.css, ./app.js, images) resolve to sibling URLs on the same mount — navigating
  // to /api/projects/:id/static/index.html renders the page inline (res.sendFile sets the
  // content-type from the extension, no Content-Disposition) and its relative links keep
  // working. Same createResolveSafe escape rejection as every other project-scoped route.
  app.get('/api/projects/:id/static/*', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rel = req.params[0];
    if (!rel || typeof rel !== 'string') return res.status(400).json({ error: 'Missing file path.' });
    let abs;
    try {
      abs = createResolveSafe(project.path)(rel);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    // The static mount exists for previewing project files — it must never serve the console's
    // private bookkeeping (.console/ holds full chat transcripts and memory.md) or dotfiles such
    // as .env, which would otherwise be readable by URL. Reject any segment that is .console or
    // a dotfile before sendFile.
    if (rel.split(/[\\/]/).some((seg) => seg === '.console' || (seg.startsWith('.') && seg.length > 1))) {
      return res.status(403).json({ error: 'That path is not publicly readable.' });
    }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return res.status(400).json({ error: 'Not a file.' });
    } catch {
      return res.status(404).json({ error: `File not found: ${rel}` });
    }
    res.sendFile(abs);
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

  // Tidy execution — same checkpoint + performTidy + appendAction journal sequence as
  // connectionConfirm.js's generalFileOp branch (kind: 'tidy'), so 'revert action <id>' and
  // the undo toast behave identically to the old chat-confirm path. Body: { moves: [{from,to}] }
  // — the panel always sends back exactly the (possibly filtered) plan it fetched from
  // /tidy-plan, never a client-invented move list, but every from/to still passes through
  // createResolveSafe inside performTidy regardless.
  app.post('/api/projects/:id/tidy', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const moves = Array.isArray(req.body?.moves) ? req.body.moves : null;
    if (!moves || moves.length === 0) return res.status(400).json({ error: 'Missing moves[].' });
    await createCheckpoint(project.path, 'tidy this folder');
    const result = await performTidy(project.path, moves);
    if (!result.ok) return res.json({ ok: false, error: result.error, moved: result.moved, actionIds: result.actionIds });
    res.json({ ok: true, moved: result.moved, actionIds: result.actionIds });
  }));

  // Duplicate deletion — same checkpoint + performDuplicateDeletes + appendAction journal
  // sequence as connectionConfirm.js's generalFileOp branch (kind: 'duplicates_delete').
  // Body: { files: ['relative/path', ...] } — when omitted, deletes the full keep-newest plan
  // (planDuplicateDeletes), matching the chat handler's bare 'delete duplicates, keep newest'.
  app.post('/api/projects/:id/duplicates', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const requested = Array.isArray(req.body?.files) ? req.body.files : null;
    const files = requested && requested.length > 0 ? requested : await planDuplicateDeletes(project.path);
    if (!files || files.length === 0) return res.status(400).json({ error: 'No duplicate files to delete.' });
    await createCheckpoint(project.path, 'delete duplicates, keep newest');
    const result = await performDuplicateDeletes(project.path, files);
    if (!result.ok) return res.json({ ok: false, error: result.error, deleted: result.deleted, actionIds: result.actionIds });
    res.json({ ok: true, deleted: result.deleted, skippedJournal: result.skippedJournal, actionIds: result.actionIds });
  }));

  // D-7 (2026-09-08): direct-REST equivalents of the general.files.rename/move chat intents
  // (builtinGeneralFiles.js) -- the FolderExplorerPanel's inline-rename and drag-and-drop-move
  // gestures composed `rename <from> to <to>` / `move <file> into <dir>` chat phrases purely to
  // reach these two operations; the panel already computed the exact from/to relative paths
  // itself (via its own relOf() containment check), so there was never any free-text parsing
  // to preserve. Same checkpoint + perform + appendAction journal sequence as the tidy/
  // duplicates endpoints above (and as connectionConfirm.js's generalFileOp branch for these
  // two kinds), so 'revert action <id>' keeps working identically.
  app.post('/api/projects/:id/files/rename', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const from = typeof req.body?.from === 'string' ? req.body.from : '';
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    if (!from || !to) return res.status(400).json({ error: 'Missing from/to.' });
    await createCheckpoint(project.path, `rename ${from} to ${to}`);
    const result = await performRename(project.path, from, to);
    res.json(result);
  }));

  app.post('/api/projects/:id/files/move', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const file = typeof req.body?.file === 'string' ? req.body.file : '';
    const targetDir = typeof req.body?.targetDir === 'string' ? req.body.targetDir : '';
    if (!file || !targetDir) return res.status(400).json({ error: 'Missing file/targetDir.' });
    await createCheckpoint(project.path, `move ${file} into ${targetDir}`);
    const result = await performMove(project.path, file, targetDir);
    res.json(result);
  }));

  // J (explorer file ops, 2026-09-10): create-file/folder, delete, and copy/duplicate —
  // the Folder Explorer's missing half (it could only rename/move). Project-scoped like
  // rename/move above (the panel's relOf() containment check gates the buttons), same
  // checkpoint + perform + appendAction journal sequence, same never-overwrite rule, so
  // `revert action <id>` undoes every op here. Panel REST only, never chat.
  app.post('/api/projects/:id/files/create', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const dir = typeof req.body?.dir === 'string' ? req.body.dir : '';
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const isDir = req.body?.isDir === true;
    if (!name) return res.status(400).json({ error: 'Missing name.' });
    await createCheckpoint(project.path, `create ${isDir ? 'folder' : 'file'} ${name}`);
    const result = await performCreate(project.path, dir, name, isDir);
    res.json(result);
  }));

  app.post('/api/projects/:id/files/delete', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    if (paths.length === 0) return res.status(400).json({ error: 'Missing paths[].' });
    await createCheckpoint(project.path, `delete ${paths.length} item(s)`);
    const result = await performDelete(project.path, paths);
    res.json(result);
  }));

  app.post('/api/projects/:id/files/copy', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const from = typeof req.body?.from === 'string' ? req.body.from : '';
    const toDir = typeof req.body?.toDir === 'string' ? req.body.toDir : '';
    if (!from) return res.status(400).json({ error: 'Missing from.' });
    await createCheckpoint(project.path, `copy ${from}`);
    const result = await performCopy(project.path, from, toDir);
    res.json(result);
  }));
}
