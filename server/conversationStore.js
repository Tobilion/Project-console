import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { state } from './state.js';

const LEGACY_STORE_DIR = path.resolve('data/conversations');
const INDEX_PATH = path.join(LEGACY_STORE_DIR, 'index.json');

async function ensureLegacyDir() {
  await fs.mkdir(LEGACY_STORE_DIR, { recursive: true });
}

function legacyFilePath(id) {
  return path.join(LEGACY_STORE_DIR, `${id}.json`);
}

function projectConsoleDir(projectPath) {
  return path.join(projectPath, '.console');
}

function projectSessionsDir(projectPath) {
  return path.join(projectConsoleDir(projectPath), 'sessions');
}

function projectSessionMetaFile(projectPath, id) {
  return path.join(projectSessionsDir(projectPath), `${id}.json`);
}

function projectSessionLogFile(projectPath, id) {
  return path.join(projectSessionsDir(projectPath), `${id}.ndjson`);
}

function legacySessionLogFile(id) {
  return path.join(LEGACY_STORE_DIR, `${id}.ndjson`);
}

function projectChatLog(projectPath) {
  return path.join(projectConsoleDir(projectPath), 'chat-log.md');
}

async function readIndex() {
  await ensureLegacyDir();
  try {
    return JSON.parse(await fs.readFile(INDEX_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeIndex(idx) {
  await ensureLegacyDir();
  await fs.writeFile(INDEX_PATH, JSON.stringify(idx, null, 2));
}

async function setIndexEntry(session) {
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

// Exported so memoryStore.js can reuse the same .gitignore-add logic for .console/memory.md —
// a project that's never created a chat session yet (so this was never called) can still get its
// first memory entry saved before any session exists.
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

async function ensureProjectConsoleDir(projectPath) {
  await fs.mkdir(projectSessionsDir(projectPath), { recursive: true });
  await ensureGitignored(projectPath);
}

async function appendToChatLog(session, entry) {
  if (!session.projectPath) return;
  try {
    const logPath = projectChatLog(session.projectPath);
    let chunk = '';
    if (session.messageCount === 1) {
      const date = new Date(session.createdAt).toISOString().slice(0, 19).replace('T', ' ');
      chunk += `\n---\n\n## ${session.title} (${date})\n\n`;
    }
    const roleLabel = { user: '**You:**', bot: '**Console:**', error: '**Error:**', system: '**System:**' }[entry.role] || `**${entry.role}:**`;
    chunk += `${roleLabel} ${entry.content}\n\n`;
    await fs.appendFile(logPath, chunk);
  } catch {}
}

async function migrateLegacySession(session) {
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
  const oldLog = legacySessionLogFile(session.id);
  const newLog = projectSessionLogFile(project.path, session.id);
  try {
    const data = await fs.readFile(oldLog, 'utf-8').catch(() => null);
    if (data) {
      await fs.writeFile(newLog, data);
      await fs.unlink(oldLog).catch(() => {});
    }
  } catch {}
  // BUG (fixed): this function used to return `session` without ever attaching `.messages`,
  // unlike the project-scoped read path in getSession() which explicitly does
  // `session.messages = await readMessageLog(...)`. Any session that went through this legacy
  // migration path (created before a project was resolvable, or read before a later message
  // triggered project-linking) would come back with `session.messages === undefined`.
  // `useSessions.ts`'s switchSession() does `s.messages.map(...)` inside a try/catch that
  // silently swallows the resulting TypeError — so reopening one of these chats looked exactly
  // like "my messages disappeared": the fetch succeeded, but the UI silently kept whatever was
  // on screen before because the state update never happened.
  session.messages = await readMessageLog(newLog, 200);
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
  try {
    const oldLog = legacySessionLogFile(sessionId);
    const newLog = projectSessionLogFile(project.path, sessionId);
    const data = await fs.readFile(oldLog, 'utf-8').catch(() => null);
    if (data) {
      await fs.writeFile(newLog, data);
      await fs.unlink(oldLog).catch(() => {});
    }
  } catch {}
  await fs.writeFile(projectSessionMetaFile(project.path, sessionId), JSON.stringify(session, null, 2));
  await fs.unlink(legacyFilePath(sessionId)).catch(() => {});
  await setIndexEntry(session);
  return session;
}

export async function listSessions() {
  await ensureLegacyDir();
  const idx = await readIndex();

  const files = await fs.readdir(LEGACY_STORE_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const id = f.replace(/\.json$/, '');
    if (idx[id]) continue;
    try {
      const session = JSON.parse(await fs.readFile(path.join(LEGACY_STORE_DIR, f), 'utf-8'));
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

/** Read messages from NDJSON log — last N lines for recent context, or full file. */
async function readMessageLog(logPath, limit) {
  try {
    const data = await fs.readFile(logPath, 'utf-8');
    const lines = data.split('\n').filter(l => l.trim());
    const messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (limit && messages.length > limit) return messages.slice(-limit);
    return messages;
  } catch {
    return [];
  }
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
      return null;
    }
  }

  return session;
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
    try {
      const logPath2 = projectChatLog(meta.projectPath);
      let chunk = '';
      if (meta.messageCount === 1) {
        const date = new Date(meta.createdAt).toISOString().slice(0, 19).replace('T', ' ');
        chunk += `\n---\n\n## ${meta.title} (${date})\n\n`;
      }
      const roleLabel = { user: '**You:**', bot: '**Console:**', error: '**Error:**', system: '**System:**' }[entry.role] || `**${entry.role}:**`;
      chunk += `${roleLabel} ${entry.content}\n\n`;
      await fs.appendFile(logPath2, chunk);
    } catch {}
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
