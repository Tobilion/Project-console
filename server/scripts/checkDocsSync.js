/**
 * checkDocsSync.js — committed sync harness between the how_do_i command catalog
 * (consoleCommandDocs.js's COMMAND_DOCS) and the README "Chat commands (reference)" table.
 *
 * Run: npm run check-docs
 *
 * The catalog's header comment promises every entry mirrors the README reference tables.
 * That promise silently rotted once (2026-08-11, Phase 9): catalog entries for schedule/
 * notify/export/health/theme/... had no README row, and README rows drifted out of the
 * catalog's keyword vocabulary. This harness enforces the contract in both directions:
 *
 *  1. Catalog -> README (FAIL): every entry's `command` string OR at least one of its
 *     `keywords` must appear in the README table. Catches features documented for the AI
 *     catalog but never written into the README.
 *  2. README -> catalog (WARN only): table rows whose command cell matches no catalog
 *     command/keyword are listed. Warnings, not failures: the README also covers
 *     intent-level commands (e.g. "is the server running") that legitimately have no
 *     how-do-I catalog entry.
 *
 * Matching is substring-based on normalized text (lowercase, whitespace-collapsed) — the
 * README cells use the same trigger phrasings as the catalog by design.
 */
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..') + path.sep;

const { COMMAND_DOCS } = await import(pathToFileURL(base + 'server/consoleCommandDocs.js').href);
const { buildCommandCatalog, CANNED_CHITCHAT_INTENTS } = await import(pathToFileURL(base + 'server/commandCatalog.js').href);
const { BUILTIN_INTENTS } = await import(pathToFileURL(base + 'server/intentRegistry.js').href);

const README = readFileSync(base + 'README.md', 'utf8');

function normalize(text) {
  return text
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const tableStart = README.indexOf('## Chat commands (reference)');
if (tableStart === -1) {
  console.error('FAIL: README.md has no "## Chat commands (reference)" section');
  process.exit(1);
}
const tableEnd = README.indexOf('\n## ', tableStart + 2);
const table = README.slice(tableStart, tableEnd === -1 ? README.length : tableEnd);

const rows = table
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.includes('| Command |'));
const rowCells = rows.map((line) => {
  const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
  return cells[0] ? normalize(cells[0]) : null;
}).filter(Boolean);

const tableText = normalize(rows.join(' '));

let failures = 0;
let warnings = 0;

for (const entry of COMMAND_DOCS) {
  const candidates = [normalize(entry.command), ...entry.keywords.map(normalize)];
  const hit = candidates.some((c) => c.length > 0 && tableText.includes(c));
  if (!hit) {
    failures += 1;
    console.error(`  FAIL catalog entry "${entry.command}" has no README row (checked command + ${entry.keywords.length} keyword(s))`);
  }
}

for (const cell of rowCells) {
  const hit = COMMAND_DOCS.some(
    (entry) =>
      normalize(entry.command).split(' ').some((w) => w.length >= 4 && cell.includes(w)) ||
      entry.keywords.some((k) => cell.includes(normalize(k))),
  );
  if (!hit) {
    warnings += 1;
    console.warn(`  warn README row "${cell}" matches no catalog command/keyword (ok if it is intent-level)`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} catalog entries missing from README — update the reference table (see consoleCommandDocs.js).`);
  process.exit(1);
}

// 2026-08-13: the generated intent layer must cover every dispatchable intent — a new intent
// added to BUILTIN_INTENTS without an INTENTS example (or left out of the catalog for any
// other reason) would silently vanish from the Ctrl+K deck and the Command Reference tab.
const { intents: catalogIntents } = buildCommandCatalog();
const catalogIntentIds = new Set(catalogIntents.map((i) => i.intentId));
const missing = [...BUILTIN_INTENTS].filter((id) => !CANNED_CHITCHAT_INTENTS.has(id) && !catalogIntentIds.has(id));
if (missing.length > 0) {
  console.error(`\n${missing.length} intent(s) missing from the generated command catalog: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`check-docs: ${COMMAND_DOCS.length} catalog entries covered, ${catalogIntents.length} generated intent entries, ${warnings} unmapped README row(s) (intent-level, tolerated).`);
