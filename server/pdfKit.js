// Phase 3 (UPGRADE-ROADMAP.md, 2026-08-11): the PDF toolkit core — the pure operations behind
// the five pdf.* trigger intents (builtinPdfTools.js) and the interactive PDF Tools panel.
// Two real dependencies (both added 2026-08-11): pdf-lib for building/splitting/watermarking
// PDFs, and pdf-parse (v2, class API) for text extraction — pdf-lib cannot extract text.
//
// Safety model (mirrors Phase 2's file tools): every path resolves through createResolveSafe
// (symlink-aware escape rejection), writes never overwrite an existing file (binary pre-images
// can't be journaled, so an overwritten PDF would be unrevertable), and every created output
// is journaled through appendAction as a `file_write` with existed:false, so `revert action
// <id>` deletes it. Operations are in-memory (pdf-lib) — the input byte cap bounds the damage
// a single oversized file can do.
//
// Parse helpers (parsePdfOutput/parsePageSpec/extractWatermarkText/parsePdfNames) are pure and
// exported for the committed harness (checkHandlerCoverage.js unit rows).

import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { walkDir } from './toolScan.js';
import { createResolveSafe } from './toolSandbox.js';
import { appendAction } from './actionHistory.js';

const MAX_PDF_FILES = 200;            // list cap — a folder of PDFs is bounded, never a scan storm
export const MAX_MERGE_INPUTS = 10;    // one merge run is bounded; the user re-runs for the rest
const MAX_PDF_BYTES = 150 * 1024 * 1024; // in-memory ops — refuse larger files with a clear error
const MAX_TOTAL_PAGES = 2000;         // page-count cap for any op, so a giant doc can't stall
const MAX_TEXT_PREVIEW_CHARS = 4000;  // extract_text answer preview cap

/** Project-relative .pdf files (forward slashes, sorted), capped. */
export function listPdfFiles(root) {
  let files;
  try {
    files = walkDirSync(root);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .slice(0, MAX_PDF_FILES)
    .sort()
    .map((f) => {
      const rel = path.relative(root, f).replace(/\\/g, '/');
      let size = 0;
      try { size = fs.statSync(f).size; } catch {}
      return { path: rel, name: path.basename(rel), size };
    });
}

// walkDir (toolScan.js) is async; a sync variant keeps listPdfFiles sync for the REST route
// and the matcher of loose names. Same ignore rules, same max depth.
function walkDirSync(dirPath, maxDepth = 6) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory() && maxDepth > 0) {
      results.push(...walkDirSync(fullPath, maxDepth - 1));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Resolves a loose file name ("report.pdf" or "report") against the project's PDFs.
 *  Exact basename match wins; otherwise a stem match with stem length >= 4 (a one-letter
 *  request like "a.pdf" must never match every file). Returns the matched entry or null. */
export function resolvePdfInput(root, name) {
  const files = listPdfFiles(root);
  const requested = name.trim().toLowerCase();
  const requestedStem = requested.replace(/\.pdf$/i, '');
  const exact = files.find((f) => f.name.toLowerCase() === requested);
  if (exact) return exact;
  if (requestedStem.length >= 4) {
    return files.find((f) => {
      const stem = f.name.toLowerCase().replace(/\.pdf$/i, '');
      return stem === requestedStem || stem.includes(requestedStem) || requestedStem.includes(stem);
    }) || null;
  }
  return null;
}

/** All .pdf names mentioned in the input, excluding the output clause ("into X.pdf").
 *  Names are word-chars/dots/dashes only — a space-separated match would swallow the whole
 *  clause ("merge a.pdf and b.pdf into c.pdf" must yield exactly a.pdf and b.pdf). */
export function parsePdfNames(input) {
  const withoutOutput = input.replace(/\b(?:into|as|to)\s+["']?[A-Za-z0-9_\-. ()]+\.pdf["']?$/i, '');
  const matches = withoutOutput.match(/[\w.-]+\.pdf/gi) || [];
  return matches.map((m) => m.trim());
}

/** The output name from an "into X.pdf" / "as X.pdf" / "to X.pdf" clause, or null. */
export function parsePdfOutput(input) {
  const m = input.match(/\b(?:into|as|to)\s+["']?([A-Za-z0-9_\-. ()]+\.pdf)["']?$/i);
  return m ? m[1].trim() : null;
}

/** The watermark text after "with ...", with any output clause stripped first. */
export function extractWatermarkText(input) {
  const withoutOutput = input.replace(/\b(?:into|as|to)\s+["']?[A-Za-z0-9_\-. ()]+\.pdf["']?$/i, '');
  const m = withoutOutput.match(/\bwith\s+(.+?)\s*$/i);
  if (!m || !m[1].trim()) return null;
  return m[1].trim().replace(/[.!?]+$/, '');
}

/** Page spec from "one file per page" / "at page N" / "pages N-M" (or "pages N to M"). */
export function parsePageSpec(input) {
  if (/\b(?:one\s+file\s+)?per\s+page\b|\bseparate\s+pages\b|\beach\s+page\b/i.test(input)) {
    return { kind: 'perPage' };
  }
  const range = input.match(/\bpages?\s+(\d+)\s*(?:-|to|–)\s*(\d+)\b/i);
  if (range) return { kind: 'range', from: parseInt(range[1], 10), to: parseInt(range[2], 10) };
  const at = input.match(/\bat\s+page\s+(\d+)\b/i);
  if (at) return { kind: 'at', page: parseInt(at[1], 10) };
  return null;
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'MB';
  if (n >= 1024) return Math.round(n / 1024) + 'KB';
  return n + 'B';
}

async function readPdfBytes(root, rel) {
  const abs = createResolveSafe(root)(rel);
  if (!fs.existsSync(abs)) return { error: `${rel} does not exist.` };
  let st;
  try { st = fs.statSync(abs); } catch (err) { return { error: `Could not read ${rel}: ${err.message}` }; }
  if (!st.isFile()) return { error: `${rel} is not a file.` };
  if (st.size === 0) return { error: `${rel} is empty.` };
  if (st.size > MAX_PDF_BYTES) {
    return { error: `${rel} is ${formatBytes(st.size)} — the PDF tools cap input files at ${formatBytes(MAX_PDF_BYTES)}.` };
  }
  try {
    // Phase 6: async read — files can reach 150MB and a sync read pinned the event loop.
    return { bytes: await fs.promises.readFile(abs) };
  } catch (err) {
    return { error: `Could not read ${rel}: ${err.message}` };
  }
}

async function loadDocument(bytes, rel) {
  try {
    return { doc: await PDFDocument.load(bytes) };
  } catch (err) {
    return { error: `Could not open ${rel} (corrupt or password-protected).` };
  }
}

/** Refuses to create an output that already exists — an overwrite would be unrevertable
 *  (no journalable pre-image for a binary file). Returns {error} or null. */
function refuseExistingOutput(root, rel) {
  const abs = createResolveSafe(root)(rel);
  if (fs.existsSync(abs)) {
    return { error: `${rel} already exists — delete it or pick another output name.` };
  }
  return null;
}

function journalCreated(root, rel) {
  return appendAction(root, {
    type: 'file_write',
    description: `Created ${rel} (PDF toolkit)`,
    path: rel,
    existed: false,
  });
}

/** Writes one output file (never overwriting) and journals it. Returns `{ error }` on
 *  refusal/failure, else `{ actionId }` — the journal id rides the op result so the
 *  confirm-branch answer can offer an undo toast (`revert action <id>` deletes the file). */
async function writeOutput(root, rel, bytes) {
  const abs = createResolveSafe(root)(rel);
  const guard = refuseExistingOutput(root, rel);
  if (guard) return guard;
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, bytes);
  const actionId = journalCreated(root, rel);
  return actionId ? { actionId } : {};
}

/** Merge N PDFs into one. Returns { ok, output, pages, bytes } or { ok:false, error }. */
export async function mergePdfs(root, inputs, output) {
  const target = await PDFDocument.create();
  let pages = 0;
  for (const rel of inputs) {
    const read = await readPdfBytes(root, rel);
    if (read.error) return { ok: false, error: read.error };
    const loaded = await loadDocument(read.bytes, rel);
    if (loaded.error) return { ok: false, error: loaded.error };
    if (loaded.doc.getPageCount() > MAX_TOTAL_PAGES - pages) {
      return { ok: false, error: `Merging these PDFs would exceed the ${MAX_TOTAL_PAGES}-page cap.` };
    }
    try {
      // pdf-lib contract: copyPages is called ON the target document with the source as the
      // first argument (calling it on the source silently copies zero pages — verified live
      // 2026-08-11 while porting the merge operation).
      const copied = await target.copyPages(loaded.doc, loaded.doc.getPageIndices());
      copied.forEach((p) => target.addPage(p));
      pages += copied.length;
    } catch (err) {
      return { ok: false, error: `Could not merge pages from ${rel}: ${err.message}` };
    }
  }
  const bytes = await target.save();
  const out = await writeOutput(root, output, bytes);
  if (out.error) return { ok: false, error: out.error };
  return { ok: true, output, pages, bytes: bytes.length, actionIds: out.actionId ? [out.actionId] : [] };
}

/** Split one PDF. spec.kind 'perPage' -> one file per page; 'at' -> two parts around page N.
 *  Returns { ok, outputs: [{path, pages}], totalPages } or { ok:false, error }. */
export async function splitPdf(root, input, spec) {
  const read = await readPdfBytes(root, input);
  if (read.error) return { ok: false, error: read.error };
  const loaded = await loadDocument(read.bytes, input);
  if (loaded.error) return { ok: false, error: loaded.error };
  const total = loaded.doc.getPageCount();
  if (total > MAX_TOTAL_PAGES) {
    return { ok: false, error: `${input} has ${total} pages — over the ${MAX_TOTAL_PAGES}-page cap.` };
  }
  const stem = input.replace(/\.pdf$/i, '');
  const ranges = [];
  if (spec.kind === 'perPage') {
    for (let i = 0; i < total; i++) {
      ranges.push({ label: `${stem}-page-${i + 1}.pdf`, pages: [i] });
    }
  } else {
    const n = spec.page;
    if (n < 1 || n >= total) {
      return { ok: false, error: `Page ${n} is out of range — ${input} has ${total} page${total === 1 ? '' : 's'}.` };
    }
    const first = [];
    for (let i = 0; i < n; i++) first.push(i);
    const rest = [];
    for (let i = n; i < total; i++) rest.push(i);
    ranges.push({ label: `${stem}-part-1.pdf`, pages: first });
    ranges.push({ label: `${stem}-part-2.pdf`, pages: rest });
  }
  const outputs = [];
  const actionIds = [];
  for (const range of ranges) {
    const guard = refuseExistingOutput(root, range.label);
    if (guard) return { ok: false, error: guard.error };
    const part = await PDFDocument.create();
    const copied = await part.copyPages(loaded.doc, range.pages);
    copied.forEach((p) => part.addPage(p));
    const bytes = await part.save();
    const out = await writeOutput(root, range.label, bytes);
    if (out.error) return { ok: false, error: out.error };
    if (out.actionId) actionIds.push(out.actionId);
    outputs.push({ path: range.label, pages: range.pages.length });
  }
  return { ok: true, outputs, totalPages: total, actionIds };
}

/** Extract plain text (pdf-parse). Returns { ok, text, preview, pages } or { ok:false, error }. */
export async function extractText(root, input) {
  const read = await readPdfBytes(root, input);
  if (read.error) return { ok: false, error: read.error };
  try {
    const parser = new PDFParse({ data: read.bytes });
    await parser.load();
    const { text, pages } = await parser.getText({ pageJoiner: '' });
    const trimmed = (text || '').trim();
    const preview = trimmed.slice(0, MAX_TEXT_PREVIEW_CHARS);
    return { ok: true, text: trimmed, preview, pages: (pages || []).length };
  } catch (err) {
    return { ok: false, error: `Text extraction failed on ${input}: ${err.message}` };
  }
}

/** Phase 16 (2026-08-12): raw-bytes PDF text extraction for the document indexer (the
 *  chat-facing extractText takes a project-relative filename; the indexer has a path + bytes
 *  already). Same pdf-parse path — one extraction implementation. */
export async function extractPdfTextBytes(bytes) {
  try {
    const parser = new PDFParse({ data: bytes });
    await parser.load();
    const { text, pages } = await parser.getText({ pageJoiner: '\n' });
    return { ok: true, text: (text || '').trim(), pages: (pages || []).length };
  } catch (err) {
    return { ok: false, error: `PDF text extraction failed: ${err.message}` };
  }
}

/** Extract a page range into one new PDF. Returns { ok, output, pages } or { ok:false, error }. */
export async function extractPages(root, input, from, to, output) {
  const read = await readPdfBytes(root, input);
  if (read.error) return { ok: false, error: read.error };
  const loaded = await loadDocument(read.bytes, input);
  if (loaded.error) return { ok: false, error: loaded.error };
  const total = loaded.doc.getPageCount();
  if (from < 1 || to > total || from > to) {
    return { ok: false, error: `Pages ${from}-${to} are out of range — ${input} has ${total} page${total === 1 ? '' : 's'}.` };
  }
  if (to - from + 1 > MAX_TOTAL_PAGES) {
    return { ok: false, error: `That range is over the ${MAX_TOTAL_PAGES}-page cap.` };
  }
  const out = await PDFDocument.create();
  const indices = [];
  for (let i = from - 1; i < to; i++) indices.push(i);
  const copied = await out.copyPages(loaded.doc, indices);
  copied.forEach((p) => out.addPage(p));
  const bytes = await out.save();
  const written = await writeOutput(root, output, bytes);
  if (written.error) return { ok: false, error: written.error };
  return { ok: true, output, pages: copied.length, actionIds: written.actionId ? [written.actionId] : [] };
}

/** Draw a centered diagonal-ish watermark word across every page. Returns
 *  { ok, output, pages } or { ok:false, error }. */
export async function watermarkPdf(root, input, text, output) {
  const read = await readPdfBytes(root, input);
  if (read.error) return { ok: false, error: read.error };
  const loaded = await loadDocument(read.bytes, input);
  if (loaded.error) return { ok: false, error: loaded.error };
  if (loaded.doc.getPageCount() > MAX_TOTAL_PAGES) {
    return { ok: false, error: `${input} has ${loaded.doc.getPageCount()} pages — over the ${MAX_TOTAL_PAGES}-page cap.` };
  }
  const font = await loaded.doc.embedFont(StandardFonts.Helvetica);
  for (const page of loaded.doc.getPages()) {
    const size = 48;
    const width = font.widthOfTextAtSize(text, size);
    // Centered, slightly above the middle, translucent gray — readable but never content-crushing.
    page.drawText(text, {
      x: Math.max(0, (page.getWidth() - width) / 2),
      y: page.getHeight() / 2 + size / 2,
      size,
      font,
      color: rgb(0.45, 0.45, 0.45),
      opacity: 0.3,
    });
  }
  const bytes = await loaded.doc.save();
  const written = await writeOutput(root, output, bytes);
  if (written.error) return { ok: false, error: written.error };
  return { ok: true, output, pages: loaded.doc.getPageCount(), actionIds: written.actionId ? [written.actionId] : [] };
}
