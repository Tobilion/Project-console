// Phase 7 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Spreadsheet panel � the
// read-only CSV listing + header endpoints. Queries run through the normal WS trigger-command
// path ("sum column X in Y" etc.) so the terminal stays the single source of truth.
import fs from 'fs';
import path from 'path';
import { resolveProject } from '../state.js';
import { parseCsv, loadCsv, findColumn, matchOp, aggregateColumn } from '../csvTools.js';
import { createResolveSafe } from '../toolSandbox.js';
import { appendAction } from '../actionHistory.js';
import { asyncHandler } from '../asyncHandler.js';

const MAX_CSV_FILES = 200;
const MAX_CSV_UPLOAD_BYTES = 2 * 1024 * 1024;

export function registerCsvRoutes(app) {
  // Project CSV files (project-relative paths), for the panel's file picker.
  app.get('/api/projects/:id/csv-files', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const out = [];
    try {
      const walk = (dir, relDir) => {
        let names = [];
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
          if (out.length >= MAX_CSV_FILES) return;
          if (name === 'node_modules' || name === '.git' || name === '.console') continue;
          const p = path.join(dir, name);
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (st.isDirectory()) walk(p, path.join(relDir, name));
          else if (/\.csv$/i.test(name)) {
            out.push({ path: path.join(relDir, name).replace(/\\/g, '/'), name, size: st.size });
          }
        }
      };
      walk(project.path, '.');
    } catch { /* empty list is fine */ }
    out.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ files: out });
  }));

  // Header row of one CSV, for the panel's column dropdown.
  app.get('/api/projects/:id/csv-headers', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const filePath = typeof req.query.file === 'string' ? req.query.file : '';
    if (!filePath || !/\.csv$/i.test(filePath)) return res.status(400).json({ error: 'Missing ?file= (a .csv path).' });
    // Security: resolve through the same sandbox boundary the upload endpoint and csvTools.loadCsv
    // use � an absolute path or `..` traversal must never read a file outside the project root.
    let abs;
    try {
      abs = createResolveSafe(project.path)(filePath);
    } catch {
      return res.status(400).json({ error: 'File must be inside the project.' });
    }
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'CSV file not found.' });
    try {
      const text = fs.readFileSync(abs, 'utf-8');
      const rows = parseCsv(text);
      if (rows.length === 0) return res.json({ headers: [] });
      res.json({ headers: rows[0].map((h) => h.trim()) });
    } catch {
      res.status(500).json({ error: 'Could not read the CSV file.' });
    }
  }));

  // First N rows of one CSV for the panel's preview — same read-only loadCsv path as the
  // filter/aggregate endpoints, so the preview table can never diverge from a chat answer.
  // Audit 2026-08-17: the panel previously showed nothing until a query ran; the preview
  // also returns the total row count so the UI can warn when it is truncated.
  app.get('/api/projects/:id/csv-preview', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const filePath = typeof req.query.file === 'string' ? req.query.file : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10) || 50, 1), 200);
    if (!filePath || !/\.csv$/i.test(filePath)) return res.status(400).json({ error: 'Missing ?file= (a .csv path).' });
    const csv = await loadCsv(project.path, filePath);
    if (!csv.ok) return res.status(400).json({ error: csv.error });
    const rows = csv.rows
      .slice(0, limit)
      .map((r) => csv.headers.map((h, i) => r[i] ?? ''));
    res.json({ headers: csv.headers, rows, total: csv.rows.length, truncated: csv.rows.length > limit });
  }));

  // Filtered rows for the panel's table view � same read-only path the chat filter uses
  // (csvTools.loadCsv + matchOp), so the panel table and the chat answer can never diverge.
  app.get('/api/projects/:id/csv-filter', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const filePath = typeof req.query.file === 'string' ? req.query.file : '';
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    const op = typeof req.query.op === 'string' ? req.query.op : '';
    const value = typeof req.query.value === 'string' ? req.query.value : '';
    if (!filePath || !column || !['equals', 'contains', 'greater than', 'less than'].includes(op)) {
      return res.status(400).json({ error: 'Missing/invalid ?file=&column=&op=&value= parameters.' });
    }
    const csv = await loadCsv(project.path, filePath);
    if (!csv.ok) return res.status(400).json({ error: csv.error });
    const idx = findColumn(csv.headers, column);
    if (idx === -1) return res.status(400).json({ error: `Column "${column}" not found.` });
    const rows = csv.rows
      .filter((r) => matchOp(op, r[idx], value))
      .slice(0, 500)
      .map((r) => csv.headers.map((h, i) => r[i] ?? ''));
    res.json({ headers: csv.headers, rows });
  }));

  // Aggregate result for the panel's Sum/Average/Count card � the SAME aggregateColumn /
  // matchOp paths the chat handlers use, so the panel result and the chat answer can never
  // diverge. Count follows the chat semantics: rows matching a where-clause (op + value),
  // not raw numeric cells.
  app.get('/api/projects/:id/csv-aggregate', asyncHandler(async (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const filePath = typeof req.query.file === 'string' ? req.query.file : '';
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    const op = typeof req.query.op === 'string' ? req.query.op : '';
    if (!filePath || !column || !['sum', 'average', 'count'].includes(op)) {
      return res.status(400).json({ error: 'Missing/invalid ?file=&column=&op= (sum|average|count) parameters.' });
    }
    const csv = await loadCsv(project.path, filePath);
    if (!csv.ok) return res.status(400).json({ error: csv.error });
    const colIdx = findColumn(csv.headers, column);
    if (colIdx === -1) return res.status(400).json({ error: `Column "${column}" not found.` });
    if (op === 'count') {
      const cmp = typeof req.query.cmp === 'string' ? req.query.cmp : '';
      const value = typeof req.query.value === 'string' ? req.query.value : '';
      if (!['equals', 'contains', 'greater than', 'less than'].includes(cmp)) {
        return res.status(400).json({ error: 'Count requires ?cmp= (equals|contains|greater than|less than) and ?value=.' });
      }
      const count = csv.rows.filter((r) => matchOp(cmp, r[colIdx], value)).length;
      return res.json({ op, value: count, count, column: csv.headers[colIdx], file: filePath });
    }
    const result = aggregateColumn(csv, column, op);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ op, value: result.value, count: result.count, column: csv.headers[colIdx], file: filePath });
  }));

  // Upload a CSV into the project folder � the Spreadsheet panel's drag-and-drop / file-picker
  // target (Stage C). An explicit user action with the file already in hand; the write is
  // journaled as file_write (existed:false) so `revert action <id>` deletes it. Caps match
  // parseCsv (2MB), name is basename-sanitized + project-scoped via createResolveSafe, and an
  // existing file is refused (never overwrite � mirrors the PDF tools' rule).
  app.post('/api/projects/:id/csv-upload', (req, res) => {
    const project = resolveProject(req.params.id, req.query.tab);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rawName = typeof req.query.file === 'string' ? req.query.file : '';
    if (!rawName || !/\.csv$/i.test(rawName)) return res.status(400).json({ error: 'Missing ?file= (a .csv name).' });
    const name = path.basename(rawName);
    let abs;
    try { abs = createResolveSafe(project.path)(name); } catch { return res.status(400).json({ error: 'Invalid file name.' }); }
    if (fs.existsSync(abs)) return res.status(409).json({ error: `${name} already exists in the project folder.` });
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (c) => {
      total += c.length;
      if (total <= MAX_CSV_UPLOAD_BYTES) chunks.push(c);
      else tooBig = true;
    });
    req.on('end', async () => {
      if (tooBig) return res.status(413).json({ error: 'CSV must be under 2 MB (matches the chat CSV reader).' });
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
}
