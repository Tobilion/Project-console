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
import { state } from './state.js';
import { LEGACY_STORE_DIR, legacyFilePath, projectSessionMetaFile, projectSessionLogFile, legacySessionLogFile, projectChatLog } from './sessionPaths.js';
import { ensureLegacyDir, readIndex, writeIndex, setIndexEntry, reconcileIndexFromDisk, serializePersistence } from './sessionIndex.js';
import { appendChatLogEntry } from './chatLog.js';
import { migrateLegacySession, ensureProjectConsoleDir } from './sessionMigration.js';
import { writeFileAtomic } from './atomicWrite.js';

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

  // Self-healing: merge any on-disk session metas missing from the index (an index wipe can
  // drop every entry while all the session files survive — see writeIndex's comment).
  await reconcileIndexFromDisk([
    state.currentScanDirectory,
    ...state.activeProjectsCache.map((p) => p.path),
  ]);

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
  return serializePersistence(async () => {
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
      await writeFileAtomic(projectSessionMetaFile(projectPath, session.id), JSON.stringify(session, null, 2));
    } else {
      await ensureLegacyDir();
      await writeFileAtomic(legacyFilePath(session.id), JSON.stringify(session, null, 2));
    }

    await setIndexEntry(session);
    return session;
  });
}

export async function deleteSession(id) {
  return serializePersistence(async () => {
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
  });
}

/** Renames a session (manual, from the sidebar). Non-empty trimmed title, capped at 80 chars;
 *  returns the updated session meta, or null when the session doesn't exist / title is invalid. */
export async function renameSession(id, title) {
  const t = (title || '').trim();
  if (!t || t.length > 80) return null;
  return serializePersistence(async () => {
    const idx = await readIndex();
    const meta = idx[id];
    if (!meta) return null;

    meta.title = t;
    meta.updatedAt = Date.now();
    try {
      if (meta.projectPath) {
        const sessionMeta = {
          id,
          title: t,
          projectId: meta.projectId,
          projectName: meta.projectName,
          projectPath: meta.projectPath,
          messageCount: meta.messageCount,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        };
        await writeFileAtomic(projectSessionMetaFile(meta.projectPath, id), JSON.stringify(sessionMeta, null, 2));
      } else {
        const sessionMeta = { ...meta, id };
        await writeFileAtomic(legacyFilePath(id), JSON.stringify(sessionMeta, null, 2));
      }
    } catch (err) {
      // A failed meta write must fail the rename (and skip the index update) — updating only
      // the index left the sidebar and the open chat disagreeing on the title until the next
      // message happened to rewrite the meta file (audit 2026-08-06, Phase 2).
      console.error('[conversationStore] renameSession: meta write failed:', err.message);
      return null;
    }
    await setIndexEntry(meta);
    return meta;
  });
}

export async function appendMessage(sessionId, message) {
  return serializePersistence(async () => {
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

    try {
      await fs.appendFile(logPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      // A failed append must not kill the response flow: the message still streams to the
      // client and the index meta still updates below; only the persisted record is lost,
      // and that is surfaced in the server log.
      console.error(`[conversationStore] appendMessage: failed to append to ${logPath}:`, err.message);
    }

    // Update index metadata
    meta.messageCount = (meta.messageCount || 0) + 1;
    meta.updatedAt = Date.now();

    // Auto-title from first user message
    if (meta.messageCount <= 2 && entry.role === 'user' && meta.title === (meta.projectName ? `${meta.projectName} Chat` : 'New Chat')) {
      meta.title = entry.content.substring(0, 60) + (entry.content.length > 60 ? '...' : '');
    }

    // Write updated meta file if project-scoped (atomic — a torn meta file used to make the
    // whole session unrecoverable from the sidebar; audit 2026-08-06, Phase 2)
    if (meta.projectPath) {
      const sessionMeta = { id: sessionId, title: meta.title, projectId: meta.projectId, projectName: meta.projectName, projectPath: meta.projectPath, messageCount: meta.messageCount, createdAt: meta.createdAt, updatedAt: meta.updatedAt };
      await writeFileAtomic(projectSessionMetaFile(meta.projectPath, sessionId), JSON.stringify(sessionMeta, null, 2)).catch((err) => {
        console.error('[conversationStore] appendMessage: meta write failed:', err.message);
      });
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
  });
}
