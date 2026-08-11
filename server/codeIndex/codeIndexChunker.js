// Pure chunking for the semantic code index (Phase 7, 2026-08-11). Splits a source file into
// overlapping searchable units: top-level symbol bodies where the AST parser can name them,
// fixed-size windows everywhere else. No IO, no embeddings — embeddable by the store directly.
import { AST_CAPABLE_EXTS } from '../codebaseData.js';
import { extractSymbols } from '../codebaseParsers.js';
import { CHUNK_LINES, CHUNK_OVERLAP, MAX_CHUNK_CHARS } from './codeIndexData.js';

/**
 * Symbol-anchored chunk boundaries: the AST extractor reports a 1-based start `line` per
 * top-level declaration (classes/functions/interfaces/consts...). A chunk spans from one
 * symbol's start line to the next symbol's start line minus one; the last chunk runs to the
 * end of the file. Where the AST path is unavailable (regex fallback reports line 0, or the
 * extension isn't parseable) we fall back to fixed windows. Sparse files — a single long
 * declaration like a generated table — are still chunked by the window fallback so huge
 * bodies stay embeddable.
 */
async function symbolChunks(content, ext, lines) {
  const symbols = await extractSymbols(content, ext);
  const starts = symbols.map((s) => s.line).filter((l) => l > 0);
  if (starts.length === 0) return null;
  const boundaries = [...new Set(starts)].sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : lines.length;
    chunks.push({ start, end });
  }
  return chunks;
}

function windowChunks(lines) {
  const chunks = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 1; start <= lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES - 1, lines.length);
    chunks.push({ start, end });
    if (end === lines.length) break;
  }
  return chunks;
}

function splitOversized(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts = [];
  const step = Math.floor(MAX_CHUNK_CHARS / 2);
  for (let i = 0; i < text.length; i += step) {
    parts.push(text.slice(i, i + MAX_CHUNK_CHARS));
    if (i + step >= text.length) break;
  }
  return parts;
}

/**
 * Returns [{ id, start, end, text }] for one file, or [] when the file is empty. `relPath`
 * is the project-relative forward-slash path — used as the chunk identity prefix.
 */
export async function chunkFile(content, ext, relPath) {
  const lines = content.split('\n');
  const ranges = lines.length > 0
    ? ((await symbolChunks(content, ext, lines)) || windowChunks(lines))
    : [];
  const chunks = [];
  for (const { start, end } of ranges) {
    const baseText = lines.slice(start - 1, end).join('\n').trim();
    if (!baseText) continue;
    for (const text of splitOversized(baseText)) {
      chunks.push({ id: `${relPath}:${start}`, start, end, text });
    }
  }
  return chunks;
}

// Exported for the chunking unit checks in check-indexer: a pure regression surface for
// "does this file produce stable, bounded chunks" without touching the embedding model.
export const _testHooks = { symbolChunks, windowChunks, splitOversized };
