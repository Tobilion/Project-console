/**
 * NDJSON message-log reader (Phase 6 split, 2026-08-04 — extracted from conversationStore.js,
 * logic unchanged). Sessions store their append-only message stream as one JSON object per
 * line; readers take the last `limit` lines for recent context, or the full file.
 *
 * Phase 6 (2026-08-17): an optional `before` skips that many of the LATEST messages — the
 * "load earlier" page the client already holds. With before=0 (the default for every existing
 * caller) behavior is byte-identical to the original last-N slice.
 */
import fs from 'fs/promises';

/** Read messages from NDJSON log — last N lines (or the window ending `before` lines before
 *  the end) for recent context, or full file when limit is falsy. */
export async function readMessageLog(logPath, limit, before = 0) {
  try {
    const data = await fs.readFile(logPath, 'utf-8');
    const lines = data.split('\n').filter(l => l.trim());
    const messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const end = before > 0 ? Math.max(0, messages.length - before) : messages.length;
    const start = limit ? Math.max(0, end - limit) : 0;
    if (start === 0 && end === messages.length) return messages;
    return messages.slice(start, end);
  } catch {
    return [];
  }
}
