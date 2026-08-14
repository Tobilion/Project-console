// Build orchestration for the semantic code index (Phase 7, 2026-08-11). Full project builds
// and single-file incremental updates both run inside taskQueue (never on a WS turn) and embed
// through the SAME extractor semanticMatcher.js already loads for intent matching — no second
// embedding model. The per-project watcher attaches lazily (only projects with an index get
// one), matching the scheduler's "only watch what needs watching" precedent.
import fs from 'fs/promises';
import path from 'path';
import { readProjectTree } from '../codebaseScans.js';
import { semanticMatcher } from '../semanticMatcher.js';
import { chunkFile, chunkProse } from './codeIndexChunker.js';
import * as store from './codeIndexStore.js';
import { MAX_FILE_BYTES, INDEX_EXTS, INDEX_IGNORE_DIRS, INDEX_VERSION, INDEX_DOC_EXTS, MAX_DOC_BYTES } from './codeIndexData.js';
import { extractPdfTextBytes } from '../pdfKit.js';
import { createRequire } from 'module';
import { watchProjectCodeFiles } from '../fileWatcher.js';
import { enqueueTask } from '../taskQueue.js';

const require = createRequire(import.meta.url);
// mammoth is CommonJS — same createRequire pattern as archiver.
const mammoth = require('mammoth');

const watchedProjects = new Map(); // projectId -> chokidar watcher

async function embed(text) {
  const result = await semanticMatcher.extractor(text, { pooling: 'mean', normalize: true });
  // The extractor returns a typed (Float32) array — JSON.stringify would serialize that as
  // {"0":...,"1":...}, and the store's load-side validation only accepts real arrays. Convert
  // to a plain array here so persisted vectors round-trip correctly (the matcher's intent
  // vectors never persisted, which is why only this path hit it).
  return Array.from(result.data);
}

function relPathOf(entryPath) {
  return entryPath.split(path.sep).join('/');
}

function shouldIndexFile(relPath) {
  if (relPath.startsWith('.')) return false;
  const parts = relPath.split('/');
  if (parts.some((p) => INDEX_IGNORE_DIRS.has(p))) return false;
  const ext = path.extname(relPath).toLowerCase();
  return INDEX_EXTS.has(ext) || INDEX_DOC_EXTS.has(ext);
}

/** Read one document's plain text: PDF via pdfKit, docx via mammoth, md/txt as-is. Returns
 *  { ok, text } or { ok:false }. Text length is capped so a huge doc can't blow the embed
 *  budget (the chunker caps per-chunk, but the extraction itself is bounded here). */
async function readDocumentText(fullPath, ext) {
  try {
    if (ext === '.pdf') {
      const bytes = await fs.readFile(fullPath);
      if (bytes.length > MAX_DOC_BYTES) return { ok: false };
      const r = await extractPdfTextBytes(bytes);
      return r.ok ? { ok: true, text: r.text.slice(0, 2_000_000) } : { ok: false };
    }
    if (ext === '.docx') {
      const bytes = await fs.readFile(fullPath);
      if (bytes.length > MAX_DOC_BYTES) return { ok: false };
      const r = await mammoth.extractRawText({ buffer: bytes });
      return { ok: true, text: (r.value || '').slice(0, 2_000_000) };
    }
    const text = await fs.readFile(fullPath, 'utf-8');
    return { ok: true, text: text.slice(0, 2_000_000) };
  } catch {
    return { ok: false };
  }
}

/** Re-chunk and re-embed one file, dropping its old chunks first. */
export async function updateFileInProjectIndex(project, relPath) {
  if (!semanticMatcher.ready || !semanticMatcher.extractor) return;
  const fullPath = path.join(project.path, relPath.split('/').join(path.sep));
  let content;
  const ext = path.extname(fullPath).toLowerCase();
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      await store.dropFile(project.id, project.path, relPath);
      return;
    }
    if (INDEX_DOC_EXTS.has(ext)) {
      const doc = await readDocumentText(fullPath, ext);
      if (!doc.ok) { await store.dropFile(project.id, project.path, relPath); return; }
      content = doc.text;
    } else {
      content = await fs.readFile(fullPath, 'utf-8');
    }
  } catch {
    // File vanished between the watcher event and the update — drop its chunks.
    await store.dropFile(project.id, project.path, relPath);
    return;
  }
  const chunks = INDEX_DOC_EXTS.has(ext)
    ? chunkProse(content, relPath, ext === '.pdf' ? 'page' : 'paragraph')
    : await chunkFile(content, ext, relPath);
  const vectors = [];
  for (const chunk of chunks) {
    try {
      vectors.push(await embed(chunk.text));
    } catch (err) {
      console.error(`[codeIndex] embed failed for ${relPath}:`, err.message);
      return;
    }
  }
  // The file was verified at the guarded stat above, but it can vanish between there and here
  // (editor save/delete race) — an unguarded stat would reject the whole indexing task and
  // leave stale chunks behind. Drop them instead, same as the watcher unlink path.
  let mtimeMs;
  try {
    mtimeMs = (await fs.stat(fullPath)).mtimeMs;
  } catch {
    await store.dropFile(project.id, project.path, relPath);
    return;
  }
  await store.upsertChunks(project.id, project.path, relPath, mtimeMs, chunks, vectors);
}

/**
 * Full index build: walk the project tree, chunk + embed every indexable file whose recorded
 * mtime is unchanged is skipped (incremental — a rebuild after a single edit re-embeds only
 * that file), and attach the lazy watcher for future single-file updates.
 */
export async function buildProjectIndex(project) {
  if (!semanticMatcher.ready || !semanticMatcher.extractor) return;
  await store.loadStore(project.id, project.path);
  const tree = await readProjectTree(project.path);
  const candidates = tree
    .filter((e) => e.type === 'file')
    .map((e) => relPathOf(e.path))
    .filter(shouldIndexFile);
  for (const relPath of candidates) {
    if (!store.projectIsUnderCaps(project.id, project.path)) break;
    const fullPath = path.join(project.path, relPath.split('/').join(path.sep));
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    if (store.isFileIndexed(project.id, project.path, relPath, stat.mtimeMs)) continue;
    const ext = path.extname(fullPath).toLowerCase();
    let chunks = [];
    if (INDEX_DOC_EXTS.has(ext)) {
      const doc = await readDocumentText(fullPath, ext);
      if (!doc.ok) continue;
      chunks = chunkProse(doc.text, relPath, ext === '.pdf' ? 'page' : 'paragraph');
    } else {
      let content;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      chunks = await chunkFile(content, ext, relPath);
    }
    const vectors = [];
    for (const chunk of chunks) {
      try {
        vectors.push(await embed(chunk.text));
      } catch (err) {
        console.error(`[codeIndex] embed failed for ${relPath}:`, err.message);
        vectors.length = 0;
        break;
      }
    }
    if (vectors.length === 0 && chunks.length > 0) continue;
    await store.upsertChunks(project.id, project.path, relPath, stat.mtimeMs, chunks, vectors);
  }
  attachProjectWatcher(project);
}

function attachProjectWatcher(project) {
  if (watchedProjects.has(project.id)) return;
  // Single-file edits re-index through the same task queue as full builds, so an editor save
  // burst on a big project can never stall a chat turn. Unlink events drop the file's chunks
  // outright (the file no longer exists to search).
  const watcher = watchProjectCodeFiles(project, (relPath, event) => {
    const norm = relPath.split('\\').join('/');
    if (!shouldIndexFile(norm)) return;
    if (event === 'unlink') {
      store.dropFile(project.id, project.path, norm);
      return;
    }
    enqueueTask(project.id, 'code index update', () => updateFileInProjectIndex(project, norm));
  });
  watchedProjects.set(project.id, watcher);
}

/** Close watchers for projects that left the active scan set (rescan removed them, or the
 *  config watcher filtered a folder out). Same lifecycle pattern as scheduler.js's
 *  syncEventTriggerWatchers and watchEngine.js's syncWatchRules — call after every
 *  activeProjectsCache replacement. */
export function syncProjectWatchers(projects) {
  const ids = new Set(projects.map((p) => p.id));
  for (const [projectId, watcher] of watchedProjects) {
    if (!ids.has(projectId)) {
      watcher.close().catch(() => {});
      watchedProjects.delete(projectId);
    }
  }
}

/**
 * True when this project's store is missing or from an older schema — the search handler uses
 * this to decide between "indexing in the background" and a direct store query.
 */
export async function indexNeedsFullBuild(project) {
  const data = await store.loadStore(project.id, project.path);
  return data.version !== INDEX_VERSION || Object.keys(data.files).length === 0;
}
