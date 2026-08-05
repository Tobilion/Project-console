/**
 * Session resolution, project-linking and legacy migration (Phase 6 split, 2026-08-04 —
 * extracted from conversationStore.js, logic unchanged). Sessions created before a project
 * was resolvable live in data/conversations/<id>.json + <id>.ndjson; once the project
 * becomes known, they move into that project's .console/sessions/ and the legacy files are
 * unlinked. The migration bug history lives in migrateLegacySession's own comment below.
 *
 * getSession() lives here (not in conversationStore.js) because linkSessionToProject needs
 * it, and importing it back from conversationStore.js would create a module cycle.
 */
import fs from 'fs/promises';
import path from 'path';
import { state } from './state.js';
import {
  legacyFilePath,
  legacySessionLogFile,
  projectSessionMetaFile,
  projectSessionLogFile,
  projectSessionsDir,
} from './sessionPaths.js';
import { readIndex, writeIndex, setIndexEntry } from './sessionIndex.js';
import { readMessageLog } from './messageLog.js';

// Exported so memoryStore.js can reuse the same .gitignore-add logic for .console/memory.md —
// a project that's never created a chat session yet (so this was never called) can still get
// its first memory entry saved before any session exists. conversationStore.js re-exports this
// so memoryStore's existing import keeps working unchanged.
export async function ensureGitignored(projectPath) {
  const gitignorePath = path.join(projectPath, '.gitignore');
  try {
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {}
    const alreadyIgnored = content.split(/\r?\n/).some((l) => {
      const t = l.trim();
      return t === '.console/' || t === '.console' || t === '/.console/' || t === '/.console';
    });
    if (alreadyIgnored) return;
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const addition = `${sep}${content.length > 0 ? '\n' : ''}# Local Project Console chat memory (not for git)\n.console/\n`;
    await fs.writeFile(gitignorePath, content + addition);
  } catch {}
}

export async function ensureProjectConsoleDir(projectPath) {
  await fs.mkdir(projectSessionsDir(projectPath), { recursive: true });
  await ensureGitignored(projectPath);
}

async function moveLegacyLog(oldLog, newLog) {
  try {
    const data = await fs.readFile(oldLog, 'utf-8').catch(() => null);
    if (data) {
      await fs.writeFile(newLog, data);
      await fs.unlink(oldLog).catch(() => {});
    }
  } catch {}
}

export async function getSession(id) {
  const idx = await readIndex();
  const meta = idx[id];

  let session = null;

  if (meta?.projectPath) {
    try {
      const metaData = await fs.readFile(projectSessionMetaFile(meta.projectPath, id), 'utf-8');
      session = JSON.parse(metaData);
      // Read messages from append-only NDJSON log
      const messages = await readMessageLog(projectSessionLogFile(meta.projectPath, id), 200);
      session.messages = messages;
    } catch {
      // Fall through to legacy
    }
  }

  if (!session) {
    try {
      const data = await fs.readFile(legacyFilePath(id), 'utf-8');
      session = JSON.parse(data);
      return await migrateLegacySession(session);
    } catch {
      // Both the project-scoped meta and the legacy file are gone, yet the index still lists
      // this session — drop the stale entry so it stops appearing in the sidebar (self-heal;
      // listSessions' reconcileIndexFromDisk re-adds it if real files ever come back).
      if (idx[id]) {
        delete idx[id];
        await writeIndex(idx).catch(() => {});
      }
      return null;
    }
  }

  return session;
}

export async function migrateLegacySession(session) {
  const project = state.activeProjectsCache?.find((p) => p.id === session.projectId);
  if (!project?.path) {
    // Not linked to a resolvable project yet — still attach messages from the legacy NDJSON
    // log so the caller sees full history instead of an undefined `.messages` (see below for
    // why that mattered: it used to silently blank out the whole chat on reload).
    session.messages = await readMessageLog(legacySessionLogFile(session.id), 200);
    await setIndexEntry(session);
    return session;
  }
  await ensureProjectConsoleDir(project.path);
  session.projectPath = project.path;
  // Migrate NDJSON message log if it exists
  await moveLegacyLog(legacySessionLogFile(session.id), projectSessionLogFile(project.path, session.id));
  // BUG (fixed): this function used to return `session` without ever attaching `.messages`,
  // unlike the project-scoped read path in getSession() which explicitly does
  // `session.messages = await readMessageLog(...)`. Any session that went through this legacy
  // migration path (created before a project was resolvable, or read before a later message
  // triggered project-linking) would come back with `session.messages === undefined`.
  // `useSessions.ts`'s switchSession() does `s.messages.map(...)` inside a try/catch that
  // silently swallows the resulting TypeError — so reopening one of these chats looked exactly
  // like "my messages disappeared": the fetch succeeded, but the UI silently kept whatever was
  // on screen before because the state update never happened.
  session.messages = await readMessageLog(projectSessionLogFile(project.path, session.id), 200);
  // Write meta file
  await fs.writeFile(projectSessionMetaFile(project.path, session.id), JSON.stringify(session, null, 2));
  await fs.unlink(legacyFilePath(session.id)).catch(() => {});
  await setIndexEntry(session);
  return session;
}

export async function linkSessionToProject(sessionId, projectId, projectPath) {
  const session = await getSession(sessionId);
  if (!session) return null;
  if (session.projectId) return session;

  const project = state.activeProjectsCache?.find(p => p.id === projectId);
  if (!project?.path) return session;

  session.projectId = project.id;
  session.projectName = project.name;
  session.projectPath = project.path;
  session.title = project.name ? `${project.name} Chat` : session.title;

  await ensureProjectConsoleDir(project.path);
  // Move NDJSON log
  await moveLegacyLog(legacySessionLogFile(sessionId), projectSessionLogFile(project.path, sessionId));
  await fs.writeFile(projectSessionMetaFile(project.path, sessionId), JSON.stringify(session, null, 2));
  await fs.unlink(legacyFilePath(sessionId)).catch(() => {});
  await setIndexEntry(session);
  return session;
}
