/**
 * Fast lookup index CRUD over data/conversations/index.json (Phase 6 split, 2026-08-04 —
 * extracted from conversationStore.js, logic unchanged). The index holds only
 * id -> { projectId, projectName, projectPath, title, createdAt, updatedAt, messageCount }
 * metadata — no message content — so listSessions() never has to scan every project on disk.
 */
import fs from 'fs/promises';
import path from 'path';
import { LEGACY_STORE_DIR, INDEX_PATH, projectSessionsDir } from './sessionPaths.js';

export async function ensureLegacyDir() {
  await fs.mkdir(LEGACY_STORE_DIR, { recursive: true });
}

export async function readIndex() {
  await ensureLegacyDir();
  try {
    return JSON.parse(await fs.readFile(INDEX_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export async function writeIndex(idx) {
  await ensureLegacyDir();
  // Atomic write (temp + rename) so an interrupted write can never leave index.json half-written
  // and unparseable. readIndex() swallows a corrupt file and returns {} — which used to mean the
  // NEXT setIndexEntry() persisted an index containing only the one new session, silently wiping
  // every other session from the sidebar even though all their files were still on disk.
  const tmp = `${INDEX_PATH}.tmp`;
  const data = JSON.stringify(idx, null, 2);
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, INDEX_PATH);
  } catch {
    // Rename over an existing file can fail on some platforms if the target is briefly locked —
    // fall back to a direct write so the index is still persisted either way.
    await fs.writeFile(INDEX_PATH, data).catch(() => {});
  }
}

/**
 * Self-healing consistency check: merge session meta files found on disk (per-project
 * `.console/sessions/*.json` under the given roots, plus any legacy `data/conversations/*.json`
 * leftovers) into the index. Only ever ADDS entries that are missing — existing index entries
 * are never overwritten, so this restores history lost to an index wipe without clobbering live
 * metadata. Callers pass the scan directory + known project paths as roots.
 */
export async function reconcileIndexFromDisk(roots = []) {
  const idx = await readIndex();
  let changed = false;

  const dirs = new Set(roots.filter(Boolean));
  for (const root of roots) {
    if (!root) continue;
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.add(path.join(root, entry.name));
      }
    } catch {}
  }

  const absorb = (id, meta, fallbackPath) => {
    if (idx[id]) return false;
    idx[id] = {
      projectId: meta.projectId ?? null,
      projectName: meta.projectName ?? null,
      projectPath: meta.projectPath || fallbackPath || null,
      title: meta.title || 'Untitled',
      createdAt: meta.createdAt || Date.now(),
      updatedAt: meta.updatedAt || Date.now(),
      messageCount: meta.messageCount || 0,
    };
    return true;
  };

  for (const dir of dirs) {
    let files;
    try {
      files = await fs.readdir(projectSessionsDir(dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/, '');
      if (idx[id]) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(projectSessionsDir(dir), f), 'utf-8'));
        changed = absorb(id, meta, dir) || changed;
      } catch {}
    }
  }

  let legacyFiles = [];
  try {
    legacyFiles = await fs.readdir(LEGACY_STORE_DIR);
  } catch {}
  for (const f of legacyFiles) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const id = f.replace(/\.json$/, '');
    if (idx[id]) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(LEGACY_STORE_DIR, f), 'utf-8'));
      changed = absorb(id, meta, null) || changed;
    } catch {}
  }

  if (changed) await writeIndex(idx);
  return changed;
}

export async function setIndexEntry(session) {
  const idx = await readIndex();
  idx[session.id] = {
    projectId: session.projectId,
    projectName: session.projectName,
    projectPath: session.projectPath || null,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount || 0,
  };
  await writeIndex(idx);
}
