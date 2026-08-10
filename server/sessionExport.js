/**
 * Session export formatter (Phase 0, 2026-08-10). The single implementation for session
 * export — the GET /api/sessions/:id/export endpoint formats here and the frontend downloads
 * from that endpoint, so there is exactly one place where persisted roles map to export output,
 * instead of forking into a client-side replica that drifts (the old client formatter remapped
 * every non-user/error/warning role onto a generic "Assistant" label and had no timestamps).
 */
import fs from 'fs/promises';
import { readIndex } from './sessionIndex.js';
import { projectSessionLogFile, legacySessionLogFile, projectChatLog } from './sessionPaths.js';
import { readMessageLog } from './messageLog.js';

// Distinct markdown headers per persisted role — system/tool-trace messages and command output
// must not masquerade as AI answers once exported. Unknown roles fall back to their raw name
// so a future role still exports rather than silently merging.
const ROLE_HEADER = {
  user: 'User',
  bot: 'Assistant',
  system: 'System',
  output: 'Output',
  error: 'Error',
  warning: 'Notice',
};

function roleHeader(role) {
  return ROLE_HEADER[role] || role;
}

/** Human-readable local timestamp for a persisted entry; empty for legacy records that
 *  predate the timestamp field (appendMessage has always written one, so this is defensive). */
function stamp(entry) {
  return entry.timestamp ? `_${new Date(entry.timestamp).toLocaleString()}_` : '';
}

/**
 * Resolve a session id to its FULL (uncapped) NDJSON log path. getSession() caps at 200 for
 * chat reload — an export must include everything the server has on disk, so this reads the
 * index directly and picks project-scoped vs legacy storage the same way getSession does.
 */
async function fullLogPath(sessionId) {
  const idx = await readIndex();
  const meta = idx[sessionId];
  if (!meta) return null;
  return meta.projectPath
    ? projectSessionLogFile(meta.projectPath, sessionId)
    : legacySessionLogFile(sessionId);
}

/** Read every persisted message for a session, oldest first (verbatim file order). Returns
 *  null when the session id is unknown; [] for a session with no messages yet. */
export async function readFullSessionHistory(sessionId) {
  const logPath = await fullLogPath(sessionId);
  if (!logPath) return null;
  return readMessageLog(logPath);
}

export function formatExportMarkdown(entries, meta) {
  const title = meta.title || 'session';
  const lines = [`# ${meta.projectName || meta.projectId || title} — ${title}`, `Exported: ${new Date().toISOString()}`, ''];
  for (const entry of entries) {
    lines.push(`## ${roleHeader(entry.role)}`, stamp(entry), '');
    // Bot answers are markdown content and export as-is; everything else (output/system
    // traces, raw errors) is fenced so it can't be interpreted as formatting.
    lines.push(entry.role === 'bot' ? entry.content : '```\n' + entry.content + '\n```');
    lines.push('');
  }
  return lines.join('\n');
}

export function formatExportJson(entries, meta) {
  return {
    project: meta.projectName || meta.projectId || null,
    sessionId: meta.id,
    title: meta.title || null,
    exportedAt: new Date().toISOString(),
    messages: entries.map((e) => ({
      id: e.id,
      role: e.role,
      content: e.content,
      timestamp: e.timestamp ?? null,
      ...(e.isMarkdown !== undefined ? { isMarkdown: e.isMarkdown } : {}),
    })),
  };
}

/** Absolute path of a project's human-readable chat log, or null when none exists yet. */
export async function projectChatLogPath(projectPath) {
  const logPath = projectChatLog(projectPath);
  try {
    await fs.access(logPath);
    return logPath;
  } catch {
    return null;
  }
}