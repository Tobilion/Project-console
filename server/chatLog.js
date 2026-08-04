/**
 * Human-readable chat log writer (Phase 6 split, 2026-08-04 — extracted from
 * conversationStore.js, logic unchanged). <project>/.console/chat-log.md is a parallel,
 * append-only markdown transcript of every session in that project — one `## Title (date)`
 * block per session, with a `---` separator before the first entry of each new session.
 * The role labels intentionally mirror the inline writer that used to live in appendMessage.
 */
import fs from 'fs/promises';

export async function appendChatLogEntry({ logPath, entry, messageCount, createdAt, title }) {
  try {
    let chunk = '';
    if (messageCount === 1) {
      const date = new Date(createdAt).toISOString().slice(0, 19).replace('T', ' ');
      chunk += `\n---\n\n## ${title} (${date})\n\n`;
    }
    const roleLabel = { user: '**You:**', bot: '**Console:**', error: '**Error:**', system: '**System:**' }[entry.role] || `**${entry.role}:**`;
    chunk += `${roleLabel} ${entry.content}\n\n`;
    await fs.appendFile(logPath, chunk);
  } catch {}
}
