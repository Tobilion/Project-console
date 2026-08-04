/**
 * Fast lookup index CRUD over data/conversations/index.json (Phase 6 split, 2026-08-04 —
 * extracted from conversationStore.js, logic unchanged). The index holds only
 * id -> { projectId, projectName, projectPath, title, createdAt, updatedAt, messageCount }
 * metadata — no message content — so listSessions() never has to scan every project on disk.
 */
import fs from 'fs/promises';
import { LEGACY_STORE_DIR, INDEX_PATH } from './sessionPaths.js';

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
  await fs.writeFile(INDEX_PATH, JSON.stringify(idx, null, 2));
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
