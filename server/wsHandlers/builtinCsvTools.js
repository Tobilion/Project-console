// Phase 7 (UPGRADE-ROADMAP.md, 2026-08-12): trigger handlers for deterministic CSV queries.
// The grammar is intentionally small and fixed; every column/file name is validated by
// isSafeParamValue() (paramCommand.js) before use. All handlers are read-only — no writes,
// no confirmation needed, nothing journaled.
import fs from 'fs';
import path from 'path';
import { isSafeParamValue } from '../paramCommand';
import { loadCsv, findColumn, matchOp, aggregateColumn } from '../csvTools.js';

function csvNotFoundHint(projectPath) {
  try {
    const out = [];
    const walk = (dir, relDir) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (out.length >= 5) return;
        if (name === 'node_modules' || name === '.git' || name === '.console') continue;
        const p = path.join(dir, name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, path.join(relDir, name));
        else if (/\.csv$/i.test(name)) out.push(path.join(relDir, name).replace(/\\/g, '/'));
      }
    };
    walk(projectPath, '.');
    if (out.length === 0) return ' No CSVs in this project — upload one via the Spreadsheet panel (Tools > Spreadsheet) or POST /api/projects/:id/csv-upload.';
    return ` Available CSVs: ${out.slice(0,5).join(', ')}. Use one of those, or upload via the Spreadsheet panel.`;
  } catch { return ''; }
}

const answer = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data }));

const MAX_FILTER_ROWS = 25;

/** Parses "filter data.csv where price greater than 50" -> { file, column, op, value } or null. */
function parseFilterClause(input, anchored = false) {
  const re = new RegExp(
    (anchored ? '^' : '') +
    '(?:filter|show rows in|show rows from|count rows in|count rows from)\\s+([\\w.-]+(?:\\.csv)?)\\s+where\\s+([\\w ]+?)\\s+(equals|contains|greater than|less than)\\s+(.+?)\\s*$',
    'i',
  );
  const m = input.match(re);
  if (!m) return null;
  return { file: m[1], column: m[2].trim(), op: m[3].toLowerCase(), value: m[4].trim().replace(/[.?!]+$/, '') };
}

/** Parses "sum column price in data.csv" -> { file, column } or null. */
function parseAggregate(input, kind) {
  const re = new RegExp(
    `^(?:${kind}|the ${kind}|compute ${kind})\\s+(?:column\\s+)?([\\w ]+?)\\s+(?:in|from|of)\\s+([\\w.-]+(?:\\.csv)?)\\s*$`,
    'i',
  );
  const m = input.match(re);
  if (!m) return null;
  return { file: m[2], column: m[1].trim() };
}

function columnError(file, column) {
  return `Column "${column}" not found in ${file} — try a column from the header row.`;
}

export const csvHandlers = {
  'csv.sum': async (ws, action, input, project) => {
    const agg = parseAggregate(input, 'sum');
    if (!agg) { answer(ws, 'Say it like: `sum column sales in data.csv`.'); return; }
    const { file, column } = agg;
    if (!isSafeParamValue(file) || !isSafeParamValue(column)) { answer(ws, 'Unsafe filename/column name.'); return; }
    const csv = await loadCsv(project.path, file);
    if (!csv.ok) {
      const hint = csv.error.includes('not found') ? csvNotFoundHint(project.path) : '';
      answer(ws, csv.error + hint);
      return;
    }
    const idx = findColumn(csv.headers, column);
    if (idx === -1) { answer(ws, columnError(file, column)); return; }
    const result = aggregateColumn(csv, csv.headers[idx], 'sum');
    if (!result.ok) { answer(ws, result.error); return; }
    answer(ws, `**Sum** of ${csv.headers[idx]} in ${file}: **${result.value.toLocaleString()}** (${result.count} numeric rows)`);
  },

  'csv.average': async (ws, action, input, project) => {
    const agg = parseAggregate(input, 'average');
    if (!agg) { answer(ws, 'Say it like: `average column price in data.csv`.'); return; }
    const { file, column } = agg;
    if (!isSafeParamValue(file) || !isSafeParamValue(column)) { answer(ws, 'Unsafe filename/column name.'); return; }
    const csv = await loadCsv(project.path, file);
    if (!csv.ok) {
      const hint = csv.error.includes('not found') ? csvNotFoundHint(project.path) : '';
      answer(ws, csv.error + hint);
      return;
    }
    const idx = findColumn(csv.headers, column);
    if (idx === -1) { answer(ws, columnError(file, column)); return; }
    const result = aggregateColumn(csv, csv.headers[idx], 'average');
    if (!result.ok) { answer(ws, result.error); return; }
    answer(ws, `**Average** of ${csv.headers[idx]} in ${file}: **${result.value.toFixed(2)}** (${result.count} numeric rows)`);
  },

  'csv.count': async (ws, action, input, project) => {
    const clause = parseFilterClause(input, true);
    if (!clause) { answer(ws, 'Say it like: `count rows in data.csv where status equals done`.'); return; }
    const { file, column, op, value } = clause;
    if (!isSafeParamValue(file) || !isSafeParamValue(column)) { answer(ws, 'Unsafe filename/column name.'); return; }
    const csv = await loadCsv(project.path, file);
    if (!csv.ok) {
      const hint = csv.error.includes('not found') ? csvNotFoundHint(project.path) : '';
      answer(ws, csv.error + hint);
      return;
    }
    const idx = findColumn(csv.headers, column);
    if (idx === -1) { answer(ws, columnError(file, column)); return; }
    let count = 0;
    for (const row of csv.rows) if (matchOp(op, row[idx], value)) count++;
    answer(ws, `**${count}** row${count === 1 ? '' : 's'} in ${file} where ${csv.headers[idx]} ${op} "${value}"`);
  },

  'csv.filter': async (ws, action, input, project) => {
    const clause = parseFilterClause(input, false);
    if (!clause) { answer(ws, 'Say it like: `filter data.csv where price greater than 50`.'); return; }
    const { file, column, op, value } = clause;
    if (!isSafeParamValue(file) || !isSafeParamValue(column)) { answer(ws, 'Unsafe filename/column name.'); return; }
    const csv = await loadCsv(project.path, file);
    if (!csv.ok) {
      const hint = csv.error.includes('not found') ? csvNotFoundHint(project.path) : '';
      answer(ws, csv.error + hint);
      return;
    }
    const idx = findColumn(csv.headers, column);
    if (idx === -1) { answer(ws, columnError(file, column)); return; }
    const matched = csv.rows.filter((row) => matchOp(op, row[idx], value));
    if (matched.length === 0) { answer(ws, `No rows in ${file} match ${csv.headers[idx]} ${op} "${value}".`); return; }
    const shown = matched.slice(0, MAX_FILTER_ROWS);
    const headerLine = csv.headers.map((h) => `**${h}**`).join(' | ');
    const lines = shown.map((row) => row.map((c) => (c || '').trim()).join(' | '));
    const more = matched.length > MAX_FILTER_ROWS ? `\n…and ${matched.length - MAX_FILTER_ROWS} more matching rows.` : '';
    answer(ws, `**${matched.length}** matching row${matched.length === 1 ? '' : 's'} in ${file} (${csv.headers[idx]} ${op} "${value}"):\n\n${headerLine}\n${lines.join('\n')}${more}`);
  },
};
