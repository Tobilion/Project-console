// Phase 3 (UPGRADE-ROADMAP.md, 2026-08-11): REST surface for the PDF Tools panel — the three
// file-level endpoints the interactive panel needs beyond the chat path. Everything stays
// project-scoped through the same createResolveSafe boundary the file tools use; the panel's
// actual operations run over the normal WS trigger-command path (never a parallel execution
// route — see the roadmap's step 8).
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { resolveProject } from '../state.js';
import { asyncHandler } from '../asyncHandler.js';
import { listPdfFiles } from '../pdfKit.js';
import { createResolveSafe } from '../toolSandbox.js';
import { appendAction } from '../actionHistory.js';
import { createCheckpoint } from '../gitSafety.js';
import {
  resolvePdfInput, MAX_MERGE_INPUTS, mergePdfs, splitPdf, extractPages, watermarkPdf, extractText,
} from '../pdfKit.js';

const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;

function findProject(req) {
  // Phase T (2026-08-14): resolve inside the requesting tab's workspace when ?tab= is given.
  return resolveProject(req.params.id, req.query.tab) || null;
}

export function registerPdfRoutes(app) {
  // The panel's file picker — project-relative .pdf list, capped and sorted (pdfKit caps it).
  app.get('/api/projects/:id/pdf-files', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ files: listPdfFiles(project.path) });
  }));

  // Inline download/view of a project-relative file — used by the panel's result card "open"
  // action (the chat answer's markdown download link uses the same route). Never serves a
  // path that resolves outside the project root.
  app.get('/api/projects/:id/file', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rel = req.query.path;
    if (typeof rel !== 'string' || !rel.trim()) {
      return res.status(400).json({ error: 'Missing ?path= parameter.' });
    }
    let abs;
    try {
      abs = createResolveSafe(project.path)(rel);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return res.status(400).json({ error: 'Not a file.' });
    } catch {
      return res.status(404).json({ error: `File not found: ${rel}` });
    }
    res.sendFile(abs);
  }));

  // "Reveal in folder" for the panel's result card — opens the OS file explorer with the
  // file selected (explorer /select on Windows, open -R on macOS, xdg-open fallback).
  app.post('/api/projects/:id/reveal', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rel = req.body?.path;
    if (typeof rel !== 'string' || !rel.trim()) {
      return res.status(400).json({ error: 'Missing path.' });
    }
    let abs;
    try {
      abs = createResolveSafe(project.path)(rel);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!fs.existsSync(abs)) return res.status(404).json({ error: `File not found: ${rel}` });
    try {
      if (process.platform === 'win32') {
        // explorer.exe always exits with code 1 even on success; detached so it outlives us.
        spawn('explorer.exe', [`/select,${abs}`], { detached: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', ['-R', abs], { detached: true }).unref();
      } else {
        spawn('xdg-open', [path.dirname(abs)], { detached: true }).unref();
      }
    } catch (err) {
      return res.status(500).json({ error: `Could not open the folder: ${err.message}` });
    }
    res.json({ success: true });
  }));

  // Upload a PDF into the project folder — the PDF Tools panel's drag-and-drop / file-picker
  // target (Stage D). Explicit user action with the file already in hand; the write is
  // journaled as file_write (existed:false) so `revert action <id>` deletes it. Name is
  // basename-sanitized + project-scoped via createResolveSafe; an existing file is refused
  // (never overwrite — same rule as the PDF operations themselves). Cap 50 MB.
  app.post('/api/projects/:id/pdf-upload', (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rawName = typeof req.query.file === 'string' ? req.query.file : '';
    if (!rawName || !/\.pdf$/i.test(rawName)) return res.status(400).json({ error: 'Missing ?file= (a .pdf name).' });
    const name = path.basename(rawName);
    let abs;
    try { abs = createResolveSafe(project.path)(name); } catch { return res.status(400).json({ error: 'Invalid file name.' }); }
    if (fs.existsSync(abs)) return res.status(409).json({ error: `${name} already exists in the project folder.` });
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (c) => {
      total += c.length;
      if (total <= MAX_PDF_UPLOAD_BYTES) chunks.push(c);
      else tooBig = true;
    });
    req.on('end', async () => {
      if (tooBig) return res.status(413).json({ error: 'PDF must be under 50 MB.' });
      try {
        await fs.promises.writeFile(abs, Buffer.concat(chunks));
        await appendAction(project.path, { type: 'file_write', path: name, existed: false, preContent: null });
        res.json({ path: name, name, size: total });
      } catch {
        res.status(500).json({ error: 'Could not write the file.' });
      }
    });
    req.on('error', () => { res.status(500).json({ error: 'Upload failed.' }); });
  });

  // D-7 (2026-09-08): direct-REST equivalents of the pdf.merge/split/extract_pages/watermark
  // chat intents (builtinPdfTools.js). The panel already has structured params from its own
  // pickers (file dropdowns, page-range inputs) — no chat-phrase composing or parsing needed
  // on either side. Each endpoint replicates the exact pre-checks the chat handler does
  // (missing-file / duplicate-input / MAX_MERGE_INPUTS / output-collides-with-input) before
  // creating a git checkpoint and calling the same pdfKit.js operation the confirm branch in
  // connectionConfirm.js calls — mergePdfs/splitPdf/extractPages/watermarkPdf already
  // self-journal via appendAction and refuse to overwrite an existing output, so the safety
  // contract (createResolveSafe containment, never-overwrite, 'revert action <id>') is
  // identical either way. extract_text stays read-only (no checkpoint, matches the chat
  // handler's own read-only behavior).
  app.post('/api/projects/:id/pdf/merge', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const names = Array.isArray(req.body?.inputs) ? req.body.inputs : [];
    const output = typeof req.body?.output === 'string' ? req.body.output.trim() : '';
    if (names.length < 2 || !output) return res.status(400).json({ error: 'Need at least two inputs and an output name.' });
    const inputs = [];
    const missing = [];
    for (const n of names) {
      const hit = resolvePdfInput(project.path, n);
      if (hit) inputs.push(hit.path);
      else missing.push(n);
    }
    if (missing.length > 0) return res.json({ ok: false, error: `Could not find: ${missing.join(', ')}` });
    if (inputs.length > MAX_MERGE_INPUTS) return res.json({ ok: false, error: `Merge is capped at ${MAX_MERGE_INPUTS} PDFs per run.` });
    if (new Set(inputs).size !== inputs.length) return res.json({ ok: false, error: 'The same PDF appears twice in your merge.' });
    if (inputs.includes(output)) return res.json({ ok: false, error: 'The output name is also one of the inputs.' });
    await createCheckpoint(project.path, `merge ${inputs.join(' and ')} into ${output}`);
    const result = await mergePdfs(project.path, inputs, output);
    if (!result.ok) return res.json(result);
    res.json(result);
  }));

  app.post('/api/projects/:id/pdf/split', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const name = typeof req.body?.input === 'string' ? req.body.input : '';
    const mode = req.body?.mode === 'at' ? 'at' : 'perPage';
    const hit = resolvePdfInput(project.path, name);
    if (!hit) return res.json({ ok: false, error: `Could not find "${name}".` });
    let spec;
    if (mode === 'perPage') {
      spec = { kind: 'perPage' };
    } else {
      const page = Number(req.body?.at);
      if (!Number.isFinite(page) || page < 1) return res.status(400).json({ error: 'Missing or invalid page number.' });
      spec = { kind: 'at', page };
    }
    await createCheckpoint(project.path, `split ${hit.path}`);
    const result = await splitPdf(project.path, hit.path, spec);
    if (!result.ok) return res.json(result);
    res.json(result);
  }));

  app.get('/api/projects/:id/pdf/extract-text', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const name = typeof req.query.input === 'string' ? req.query.input : '';
    const hit = resolvePdfInput(project.path, name);
    if (!hit) return res.json({ ok: false, error: `Could not find "${name}".` });
    const result = await extractText(project.path, hit.path);
    if (!result.ok) return res.json(result);
    res.json(result);
  }));

  app.post('/api/projects/:id/pdf/extract-pages', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const name = typeof req.body?.input === 'string' ? req.body.input : '';
    const from = Number(req.body?.from);
    const to = Number(req.body?.to);
    const hit = resolvePdfInput(project.path, name);
    if (!hit) return res.json({ ok: false, error: `Could not find "${name}".` });
    if (!Number.isFinite(from) || !Number.isFinite(to)) return res.status(400).json({ error: 'Missing or invalid page range.' });
    const output = (typeof req.body?.output === 'string' && req.body.output.trim())
      || `${hit.path.replace(/\.pdf$/i, '')}-pages-${from}-${to}.pdf`;
    await createCheckpoint(project.path, `extract pages ${from}-${to} from ${hit.path} into ${output}`);
    const result = await extractPages(project.path, hit.path, from, to, output);
    if (!result.ok) return res.json(result);
    res.json(result);
  }));

  app.post('/api/projects/:id/pdf/watermark', asyncHandler(async (req, res) => {
    const project = findProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const name = typeof req.body?.input === 'string' ? req.body.input : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const hit = resolvePdfInput(project.path, name);
    if (!hit) return res.json({ ok: false, error: `Could not find "${name}".` });
    if (!text) return res.status(400).json({ error: 'Missing watermark text.' });
    const output = (typeof req.body?.output === 'string' && req.body.output.trim())
      || `${hit.path.replace(/\.pdf$/i, '')}-watermarked.pdf`;
    await createCheckpoint(project.path, `watermark ${hit.path} with ${text}`);
    const result = await watermarkPdf(project.path, hit.path, text, output);
    if (!result.ok) return res.json(result);
    res.json(result);
  }));
}
