// Phase 7 (UPGRADE-ROADMAP.md, 2026-08-12): REST surface for the Spreadsheet panel — the
// read-only CSV listing + header endpoints. Queries run through the normal WS trigger-command
// path ("sum column X in Y" etc.) so the terminal stays the single source of truth.
import fs from 'fs';
import path from 'path';
import { state } from '../state.js';
import { parseCsv, loadCsv, findColumn, matchOp } from '../csvTools.js';

const MAX_CSV_FILES = 200;

export function registerCsvRoutes(app) {
  // Project CSV files (project-relative paths), for the panel's file picker.
  app.get('/api/projects/:id/csv-files', async (req, res) => {
    const project = state.activeProjectsCache.find((p) => p.id === req.params.id);
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
  });

  // Header row of one CSV, for the panel's column dropdown.
  app.get('/api/projects/:id/csv-headers', async (req, res) => {
    const project = state.activeProjectsCache.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const filePath = typeof req.query.file === 'string' ? req.query.file : '';
    if (!filePath || !/\.csv$/i.test(filePath)) return res.status(400).json({ error: 'Missing ?file= (a .csv path).' });
    const abs = path.resolve(project.path, filePath);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'CSV file not found.' });
    try {
      const text = fs.readFileSync(abs, 'utf-8');
      const rows = parseCsv(text);
      if (rows.length === 0) return res.json({ headers: [] });
      res.json({ headers: rows[0].map((h) => h.trim()) });
    } catch {
      res.status(500).json({ error: 'Could not read the CSV file.' });
    }
  });

  // Filtered rows for the panel's table view — same read-only path the chat filter uses
  // (csvTools.loadCsv + matchOp), so the panel table and the chat answer can never diverge.
  app.get('/api/projects/:id/csv-filter', async (req, res) => {
    const project = state.activeProjectsCache.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const filePath = typeof req.query.file === 'string' ? req.query.file : '';
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    const op = typeof req.query.op === 'string' ? req.query.op : '';
    const value = typeof req.query.value === 'string' ? req.query.value : '';
    if (!filePath || !column || !['equals', 'contains', 'greater than', 'less than'].includes(op)) {
      return res.status(400).json({ error: 'Missing/invalid ?file=&column=&op=&value= parameters.' });
    }
    const csv = loadCsv(project.path, filePath);
    if (!csv.ok) return res.status(400).json({ error: csv.error });
    const idx = findColumn(csv.headers, column);
    if (idx === -1) return res.status(400).json({ error: `Column "${column}" not found.` });
    const rows = csv.rows
      .filter((r) => matchOp(op, r[idx], value))
      .slice(0, 500)
      .map((r) => csv.headers.map((h, i) => r[i] ?? ''));
    res.json({ headers: csv.headers, rows });
  });
}
