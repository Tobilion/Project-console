/**
 * NDJSON message-log reader (Phase 6 split, 2026-08-04 — extracted from conversationStore.js,
 * logic unchanged). Sessions store their append-only message stream as one JSON object per
 * line; readers take the last `limit` lines for recent context, or the full file.
 */
import fs from 'fs/promises';

/** Read messages from NDJSON log — last N lines for recent context, or full file. */
export async function readMessageLog(logPath, limit) {
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
