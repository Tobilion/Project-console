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

const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;

function findProject(req) {
  return resolveProject(req.params.id) || null;
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
        fs.writeFileSync(abs, Buffer.concat(chunks));
        await appendAction(project.path, { type: 'file_write', path: name, existed: false, preContent: null });
        res.json({ path: name, name, size: total });
      } catch {
        res.status(500).json({ error: 'Could not write the file.' });
      }
    });
    req.on('error', () => { res.status(500).json({ error: 'Upload failed.' }); });
  });
}
