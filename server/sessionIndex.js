/**
 * Fast lookup index CRUD over data/conversations/index.json (Phase 6 split, 2026-08-04 —
 * extracted from conversationStore.js, logic unchanged). The index holds only
 * id -> { projectId, projectName, projectPath, title, createdAt, updatedAt, messageCount }
 * metadata — no message content — so listSessions() never has to scan every project on disk.
 */
import fs from 'fs/promises';
import path from 'path';
import { LEGACY_STORE_DIR, INDEX_PATH, projectSessionsDir } from './sessionPaths.js';

// Global persistence serialization chain: every read→mutate→write cycle over the index (and
// the session meta files appended alongside it) runs through this so only one is in flight at
// a time. Without it, two concurrent appendMessage calls each read the same stale index
// snapshot and write `staleCount + 1`, permanently drifting messageCount — and the chat-log
// header / .gitignore blocks get written twice by racing first-messages (audit 2026-08-06,
// Phase 2). Global, not per-session, because the index is shared.
let persistenceChain = Promise.resolve();
let persistenceHeld = false;
export function serializePersistence(fn) {
  // Reentrant call from inside the lock holder: run directly instead of queuing. Safe because
  // everything else is queued behind the holder, so a bypassed call cannot run concurrently
  // with anyone — and it avoids the self-deadlock of a chain item awaiting its own chain
  // (e.g. migrateLegacySession -> ensureProjectConsoleDir -> ensureGitignored).
  if (persistenceHeld) return fn();
  const next = persistenceChain.then(async () => {
    persistenceHeld = true;
    try {
      return await fn();
    } finally {
      persistenceHeld = false;
    }
  });
  persistenceChain = next.catch(() => {});
  return next;
}

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
  const tmp = `${INDEX_PATH}.${process.pid}.${Date.now()}.tmp`;
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

    // NDJSON-only recovery: a session whose meta file is corrupt or missing but whose message
    // log survives is still indexable from the log itself (title from the first user message,
    // count from the line count) — previously such a session vanished from the sidebar forever
    // with all its messages orphaned on disk (audit 2026-08-06, Phase 2).
    for (const f of files) {
      if (!f.endsWith('.ndjson')) continue;
      const id = f.replace(/\.ndjson$/, '');
      if (idx[id]) continue;
      try {
        const raw = await fs.readFile(path.join(projectSessionsDir(dir), f), 'utf-8');
        const lines = raw.split('\n').filter((l) => l.trim());
        if (lines.length === 0) continue;
        let firstUser = null;
        for (const l of lines) {
          const m = JSON.parse(l);
          if (m?.role === 'user') { firstUser = m; break; }
        }
        const first = JSON.parse(lines[0]);
        idx[id] = {
          projectId: null,
          projectName: null,
          projectPath: dir,
          title: firstUser?.content?.substring(0, 60) || 'Untitled',
          createdAt: first.timestamp || Date.now(),
          updatedAt: Date.now(),
          messageCount: lines.length,
        };
        changed = true;
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
