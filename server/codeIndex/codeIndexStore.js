// Persisted flat-file vector store for the semantic code index (Phase 7, 2026-08-11). One JSON
// file per project (.console/code-index.json): a per-file mtime manifest plus chunk records
// { id, file, start, end, text, vector }. Brute-force cosine search is the entire query path —
// a single user's local codebases are orders of magnitude below what would justify a real
// vector store. Loaded lazily per project and cached in memory; writes are atomic and debounced
// so watcher-driven single-file updates don't hammer the disk.
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { cosineSimilarity } from '../intentVectorScan.js';
import { INDEX_FILENAME, MAX_FILES_PER_PROJECT, MAX_CHUNKS_PER_PROJECT, INDEX_VERSION } from './codeIndexData.js';
import { log } from '../logger.js';

const stores = new Map(); // projectId -> { file, dirty, timer, data }

let storeWrite = Promise.resolve();

function storePath(projectPath) {
  return path.join(projectPath, '.console', INDEX_FILENAME);
}

function emptyStore() {
  return { version: INDEX_VERSION, files: {}, chunks: [] };
}

// Loads the store file from disk into the in-memory cache (or starts an empty store when the
// file is missing/unparseable/from an older schema). Exported — the builder warms the cache
// before every build so the synchronous file checks below read current state.
export async function loadStore(projectId, projectPath) {
  const entry = stores.get(projectId);
  const data = entry?.data || emptyStore();
  if (entry) return data;
  const pathToFile = storePath(projectPath);
  try {
    const raw = JSON.parse(await fs.readFile(pathToFile, 'utf-8'));
    if (raw && raw.version === INDEX_VERSION && Array.isArray(raw.chunks) && raw.files) {
      // Corrupt chunk records must not break the whole store — but dropping any chunk while
      // keeping the mtime manifest would leave a permanently empty searchable index that never
      // rebuilds (files > 0 means "not stale"). Any dropped record resets the store entirely so
      // indexNeedsFullBuild triggers a rebuild; a pre-fix store with typed-array-as-object
      // vectors hits exactly this path.
      const validChunks = raw.chunks.filter(
        (c) => c && typeof c.id === 'string' && Array.isArray(c.vector) && typeof c.file === 'string'
      );
      if (validChunks.length !== raw.chunks.length) {
        const fresh = emptyStore();
        stores.set(projectId, { file: pathToFile, dirty: false, timer: null, data: fresh });
        return fresh;
      }
      stores.set(projectId, { file: pathToFile, dirty: false, timer: null, data: raw });
      return raw;
    }
  } catch {
    // Missing file or unparseable content — start empty, the builder repopulates.
  }
  stores.set(projectId, { file: pathToFile, dirty: false, timer: null, data });
  return data;
}

const DEBOUNCE_MS = 500;

function scheduleSave(projectId) {
  const entry = stores.get(projectId);
  if (!entry || entry.dirty) return;
  entry.dirty = true;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (!entry.dirty) return;
    entry.dirty = false;
    storeWrite = storeWrite.then(async () => {
      try {
        // .console/ is created lazily by session storage — an index-only project (no chat
        // sessions yet) may not have it. Never assume it exists (live-found in check-indexer).
        await fs.mkdir(path.dirname(entry.file), { recursive: true });
        const json = JSON.stringify(entry.data);
        const tmp = entry.file + '.tmp';
        await fs.writeFile(tmp, json, 'utf-8');
        await fs.rename(tmp, entry.file);
      } catch (err) {
        log.error(`[codeIndex] save failed for ${entry.file}:`, err.message);
      }
    });
  }, DEBOUNCE_MS);
}

export async function upsertChunks(projectId, projectPath, relPath, mtimeMs, chunks, vectors) {
  const data = await loadStore(projectId, projectPath);
  data.chunks = data.chunks.filter((c) => c.file !== relPath);
  for (let i = 0; i < chunks.length; i++) {
    data.chunks.push({ ...chunks[i], file: relPath, vector: vectors[i] });
  }
  data.files[relPath] = mtimeMs;
  scheduleSave(projectId);
}

export async function dropFile(projectId, projectPath, relPath) {
  const data = await loadStore(projectId, projectPath);
  const before = data.chunks.length;
  data.chunks = data.chunks.filter((c) => c.file !== relPath);
  delete data.files[relPath];
  if (data.chunks.length !== before) scheduleSave(projectId);
}

/** Record the file as indexed (content unchanged since last scan) without re-embedding. */
export async function touchFile(projectId, projectPath, relPath, mtimeMs) {
  const data = await loadStore(projectId, projectPath);
  data.files[relPath] = mtimeMs;
  scheduleSave(projectId);
}

export function isFileIndexed(projectId, projectPath, relPath, mtimeMs) {
  const data = stores.get(projectId)?.data;
  if (!data) return false;
  return data.files[relPath] === mtimeMs;
}

export function hasChunks(projectId, projectPath, relPath) {
  const data = stores.get(projectId)?.data;
  if (!data) return false;
  return data.chunks.some((c) => c.file === relPath);
}

export function projectChunkCount(projectId, projectPath) {
  const data = stores.get(projectId)?.data;
  if (!data) return 0;
  return data.chunks.length;
}

export function projectFileCount(projectId, projectPath) {
  const data = stores.get(projectId)?.data;
  if (!data) return 0;
  return Object.keys(data.files).length;
}

export function projectIndexedPaths(projectId, projectPath) {
  const data = stores.get(projectId)?.data;
  if (!data) return [];
  return Object.keys(data.files);
}

export function projectIsUnderCaps(projectId, projectPath) {
  const data = stores.get(projectId)?.data;
  if (!data) return true;
  return Object.keys(data.files).length < MAX_FILES_PER_PROJECT && data.chunks.length < MAX_CHUNKS_PER_PROJECT;
}

export function getFileMtime(projectId, projectPath, relPath) {
  return stores.get(projectId)?.data?.files[relPath];
}

/**
 * Brute-force cosine search over the loaded chunks. Returns the top-k most similar chunks
 * with their similarity scores, most-relevant first — this is the only query path.
 */
export async function searchChunks(projectId, projectPath, queryVector, topK) {
  const data = await loadStore(projectId, projectPath);
  if (data.chunks.length === 0) return [];
  const scored = [];
  for (const chunk of data.chunks) {
    const sim = cosineSimilarity(queryVector, chunk.vector);
    if (sim > 0.05) scored.push({ sim, chunk });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, topK).map(({ sim, chunk }) => ({ ...chunk, sim }));
}

// Only exported for the check-indexer store-level checks; the server never evicts stores.
export const _testHooks = { emptyStore, storePath, loadStore, stores };
