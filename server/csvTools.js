// Phase 7 (UPGRADE-ROADMAP.md, 2026-08-12): deterministic CSV query engine — no AI, no
// dependencies, a small fixed grammar (sum/average/count/filter). Read-only by design: the
// filter intent renders matching rows but never writes a file; a future filter-to-file write
// would need the standard confirm + action-history path.
import fs from 'fs';
import path from 'path';

const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2MB cap — a spreadsheet panel should never read a dump file
const MAX_ROWS = 20000;

/** Minimal dependency-free CSV reader: comma-separated, quoted-field aware, \r\n tolerant. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  // Drop fully-empty trailing rows (common at file end)
  while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop();
  return rows;
}

/** Load a project CSV file, capped. Returns { ok, headers, rows } or { ok:false, error }. */
export function loadCsv(projectRoot, filePath) {
  let abs;
  try {
    abs = path.resolve(projectRoot, filePath);
  } catch { return { ok: false, error: 'Invalid file path.' }; }
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'File must be inside the project.' };
  let text;
  try {
    if (!fs.existsSync(abs)) return { ok: false, error: `CSV file not found: ${filePath}` };
    const st = fs.statSync(abs);
    if (st.size > MAX_CSV_BYTES) return { ok: false, error: 'CSV file is over the 2MB cap.' };
    text = fs.readFileSync(abs, 'utf-8');
  } catch {
    return { ok: false, error: 'Could not read the CSV file.' };
  }
  const rows = parseCsv(text);
  if (rows.length < 1) return { ok: false, error: 'The CSV file is empty (no header row).' };
  const headers = rows[0].map((h) => h.trim());
  const data = rows.slice(1, 1 + MAX_ROWS);
  return { ok: true, headers, rows: data };
}

/** Column lookup by name (case-insensitive, trimmed). Returns index or -1. */
export function findColumn(headers, name) {
  const n = (name || '').trim().toLowerCase();
  return headers.findIndex((h) => h.toLowerCase() === n);
}

/** Parse a numeric cell ("12.50", "1,234" with commas stripped, "$5"). NaN for non-numeric. */
export function cellToNumber(raw) {
  const s = String(raw ?? '').trim().replace(/[$,%\s]/g, '');
  if (!s) return NaN;
  return Number(s);
}

export const CSV_OPS = ['equals', 'contains', 'greater than', 'less than'];

/** Apply one filter op to a cell value. `value` is the raw cell string. */
export function matchOp(op, cell, value) {
  const v = (value || '').trim();
  switch (op) {
    case 'equals': return String(cell ?? '').trim().toLowerCase() === v.toLowerCase();
    case 'contains': return String(cell ?? '').toLowerCase().includes(v.toLowerCase());
    case 'greater than': return cellToNumber(cell) > Number(v);
    case 'less than': return cellToNumber(cell) < Number(v);
    default: return false;
  }
}
