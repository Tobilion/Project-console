// Phase 7 (UPGRADE-ROADMAP.md, 2026-08-12): trigger handlers for deterministic CSV queries.
// The grammar is intentionally small and fixed; every column/file name is validated by
// isSafeParamValue() (paramCommand.js) before use. All handlers are read-only — no writes,
// no confirmation needed, nothing journaled.
import path from 'path';
import { isSafeParamValue } from '../paramCommand.js';
import { loadCsv, findColumn, cellToNumber, matchOp } from '../csvTools.js';

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
    const csv = loadCsv(project.path, file);
    if (!csv.ok) { answer(ws, csv.error); return; }
    const idx = findColumn(csv.headers, column);
    if (idx === -1) { answer(ws, columnError(file, column)); return; }
    let sum = 0, count = 0;
    for (const row of csv.rows) {
      const n = cellToNumber(row[idx]);
      if (!Number.isNaN(n)) { sum += n; count++; }
    }
    answer(ws, `**Sum** of ${csv.headers[idx]} in ${file}: **${sum.toLocaleString()}** (${count} numeric rows)`);
  },

  'csv.average': async (ws, action, input, project) => {
    const agg = parseAggregate(input, 'average');
    if (!agg) { answer(ws, 'Say it like: `average column price in data.csv`.'); return; }
    const { file, column } = agg;
    if (!isSafeParamValue(file) || !isSafeParamValue(column)) { answer(ws, 'Unsafe filename/column name.'); return; }
    const csv = loadCsv(project.path, file);
    if (!csv.ok) { answer(ws, csv.error); return; }
    const idx = findColumn(csv.headers, column);
    if (idx === -1) { answer(ws, columnError(file, column)); return; }
    let sum = 0, count = 0;
    for (const row of csv.rows) {
      const n = cellToNumber(row[idx]);
      if (!Number.isNaN(n)) { sum += n; count++; }
    }
    if (count === 0) { answer(ws, `No numeric values in ${csv.headers[idx]} of ${file}.`); return; }
    answer(ws, `**Average** of ${csv.headers[idx]} in ${file}: **${(sum / count).toFixed(2)}** (${count} numeric rows)`);
  },

  'csv.count': async (ws, action, input, project) => {
    const clause = parseFilterClause(input, true);
    if (!clause) { answer(ws, 'Say it like: `count rows in data.csv where status equals done`.'); return; }
    const { file, column, op, value } = clause;
    if (!isSafeParamValue(file) || !isSafeParamValue(column)) { answer(ws, 'Unsafe filename/column name.'); return; }
    const csv = loadCsv(project.path, file);
    if (!csv.ok) { answer(ws, csv.error); return; }
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
    const csv = loadCsv(project.path, file);
    if (!csv.ok) { answer(ws, csv.error); return; }
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
