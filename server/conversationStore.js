/**
 * Session persistence facade (Phase 6 split, 2026-08-04 — pure orchestration now, logic
 * moved to leaf modules, behavior unchanged). Public API:
 *   listSessions / createSession / deleteSession / appendMessage  (defined here)
 *   getSession / linkSessionToProject / ensureGitignored          (re-exported from
 *   sessionMigration.js so all existing external importers — sessionRoutes.js,
 *   aiQuery.js, connection.js, builtinIntents.js, memoryStore.js — keep working unchanged)
 *
 * Storage layout: per-session NDJSON message log + meta JSON live inside the project it's
 * about (<project>/.console/sessions/<id>.{json,ndjson}); data/conversations/index.json is
 * only a fast lookup index. Sessions created before a project is resolvable fall back to
 * data/conversations/<id>.json until a project is known, then migrate (sessionMigration.js).
 */
import fs from 'fs/promises';
import crypto from 'crypto';
import { LEGACY_STORE_DIR, legacyFilePath, projectSessionMetaFile, projectSessionLogFile, legacySessionLogFile, projectChatLog } from './sessionPaths.js';
import { ensureLegacyDir, readIndex, writeIndex, setIndexEntry } from './sessionIndex.js';
import { appendChatLogEntry } from './chatLog.js';
import { migrateLegacySession, ensureProjectConsoleDir } from './sessionMigration.js';

export { getSession, linkSessionToProject, ensureGitignored } from './sessionMigration.js';

export async function listSessions() {
  await ensureLegacyDir();
  const idx = await readIndex();

  const files = await fs.readdir(LEGACY_STORE_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const id = f.replace(/\.json$/, '');
    if (idx[id]) continue;
    try {
      const session = JSON.parse(await fs.readFile(legacyFilePath(id), 'utf-8'));
      await migrateLegacySession(session);
    } catch {}
  }

  const fresh = await readIndex();
  const sessions = Object.entries(fresh).map(([id, meta]) => ({
    id,
    title: meta.title,
    projectId: meta.projectId,
    projectName: meta.projectName,
    messageCount: meta.messageCount || 0,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }));
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions;
}

export async function createSession(projectId, projectName, projectPath) {
  const session = {
    id: crypto.randomUUID(),
    title: projectName ? `${projectName} Chat` : 'New Chat',
    projectId: projectId || null,
    projectName: projectName || null,
    projectPath: projectPath || null,
    messageCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (projectPath) {
    await ensureProjectConsoleDir(projectPath);
    await fs.writeFile(projectSessionMetaFile(projectPath, session.id), JSON.stringify(session, null, 2));
  } else {
    await ensureLegacyDir();
    await fs.writeFile(legacyFilePath(session.id), JSON.stringify(session, null, 2));
  }

  await setIndexEntry(session);
  return session;
}

export async function deleteSession(id) {
  const idx = await readIndex();
  const meta = idx[id];
  let deleted = false;

  if (meta?.projectPath) {
    deleted = await fs.unlink(projectSessionMetaFile(meta.projectPath, id)).then(() => true).catch(() => false);
    await fs.unlink(projectSessionLogFile(meta.projectPath, id)).catch(() => {});
  }
  const legacyDeleted = await fs.unlink(legacyFilePath(id)).then(() => true).catch(() => false);
  await fs.unlink(legacySessionLogFile(id)).catch(() => {});

  if (meta) {
    delete idx[id];
    await writeIndex(idx);
  }

  return deleted || legacyDeleted || !!meta;
}

export async function appendMessage(sessionId, message) {
  const idx = await readIndex();
  const meta = idx[sessionId];
  if (!meta) return null;

  const entry = {
    id: message.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: message.role,
    content: message.content,
    timestamp: Date.now(),
    // Persisted so a reloaded session can restore markdown rendering (and plain output)
    // exactly as it appeared live. Omitted (not false) when the caller doesn't say —
    // storedToTerminalMessages then falls back to role-based defaults for legacy records.
    ...(message.isMarkdown !== undefined ? { isMarkdown: message.isMarkdown } : {}),
  };

  // Append to NDJSON log (append-only — safe, fast)
  const logPath = meta.projectPath
    ? projectSessionLogFile(meta.projectPath, sessionId)
    : legacySessionLogFile(sessionId);

  await fs.appendFile(logPath, JSON.stringify(entry) + '\n');

  // Update index metadata
  meta.messageCount = (meta.messageCount || 0) + 1;
  meta.updatedAt = Date.now();

  // Auto-title from first user message
  if (meta.messageCount <= 2 && entry.role === 'user' && meta.title === (meta.projectName ? `${meta.projectName} Chat` : 'New Chat')) {
    meta.title = entry.content.substring(0, 60) + (entry.content.length > 60 ? '...' : '');
  }

  // Write updated meta file if project-scoped
  if (meta.projectPath) {
    const sessionMeta = { id: sessionId, title: meta.title, projectId: meta.projectId, projectName: meta.projectName, projectPath: meta.projectPath, messageCount: meta.messageCount, createdAt: meta.createdAt, updatedAt: meta.updatedAt };
    await fs.writeFile(projectSessionMetaFile(meta.projectPath, sessionId), JSON.stringify(sessionMeta, null, 2)).catch(() => {});
    // Append to human-readable chat log
    await appendChatLogEntry({
      logPath: projectChatLog(meta.projectPath),
      entry,
      messageCount: meta.messageCount,
      createdAt: meta.createdAt,
      title: meta.title,
    });
  }

  await setIndexEntry({
    id: sessionId,
    projectId: meta.projectId,
    projectName: meta.projectName,
    projectPath: meta.projectPath,
    title: meta.title,
    messageCount: meta.messageCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  });

  return { id: sessionId, title: meta.title, messageCount: meta.messageCount, messages: [entry] };
}
