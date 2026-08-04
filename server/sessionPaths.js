/**
 * Session file-path helpers (Phase 6 split, 2026-08-04 — extracted from conversationStore.js,
 * logic unchanged). Pure path computation: legacy central store under data/conversations and
 * the per-project .console/sessions layout that replaced it.
 */
import path from 'path';

export const LEGACY_STORE_DIR = path.resolve('data/conversations');
export const INDEX_PATH = path.join(LEGACY_STORE_DIR, 'index.json');

export function legacyFilePath(id) {
  return path.join(LEGACY_STORE_DIR, `${id}.json`);
}

export function projectConsoleDir(projectPath) {
  return path.join(projectPath, '.console');
}

export function projectSessionsDir(projectPath) {
  return path.join(projectConsoleDir(projectPath), 'sessions');
}

export function projectSessionMetaFile(projectPath, id) {
  return path.join(projectSessionsDir(projectPath), `${id}.json`);
}

export function projectSessionLogFile(projectPath, id) {
  return path.join(projectSessionsDir(projectPath), `${id}.ndjson`);
}

export function legacySessionLogFile(id) {
  return path.join(LEGACY_STORE_DIR, `${id}.ndjson`);
}

export function projectChatLog(projectPath) {
  return path.join(projectConsoleDir(projectPath), 'chat-log.md');
}
