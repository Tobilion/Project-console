import crypto from 'crypto';
import { chatOnce } from '../ollama.js';
import { pendingConfirmations } from '../state.js';

/**
 * Pulls a filename and (optionally) quoted content out of a natural-language trigger-mode
 * request, e.g. "add file Tobijagz to folder with text 'I am the goat'" or "create a file
 * called notes.md with the text 'Hello World'". Deliberately conservative — if either piece
 * can't be found with reasonable confidence, the caller asks the user instead of guessing,
 * same policy this app already follows for ambiguous file targets on the AI path.
 */
export function parseFileNameAndContent(input) {
  const fileName = parseFileNameOnly(input);

  // Content: prefer an explicit "with/containing/saying (the) text/content/message ... '...'"
  // clause; fall back to the first quoted string anywhere in the input.
  const withClause = input.match(/\b(?:with|containing|saying)\b\s*(?:the\s+)?(?:text|content|message)?\s*[:]?\s*["']([^"']+)["']/i);
  const anyQuoted = input.match(/["']([^"']{1,2000})["']/);
  const content = (withClause?.[1] ?? anyQuoted?.[1])?.trim() || null;

  return { fileName, content };
}

/**
 * Just the filename half of parseFileNameAndContent, for read-only requests. Tries an explicit
 * filename with an extension first ("notes.md", "src/utils/helpers.js" — the reliable case,
 * doesn't require the word "file" to appear at all), then falls back to whatever follows the
 * literal word "file" for extensionless names like "add file Tobijagz to folder...".
 *
 * Phase 1 (2026-08-03): also handles the "the <name> file" shape ("find the config file",
 * "where is the readme file") where the name comes BEFORE the word "file" — file_read and the
 * new file_find both previously asked "which file?" for these. Deliberately requires a
 * determiner ("the/a/my/...") before the name so a bare action like "read file" or "open file"
 * still asks instead of treating the verb as a filename.
 */
export function parseFileNameOnly(input) {
  const withExt = input.match(/\b([\w.\-/\\]+\.[a-zA-Z0-9]{1,10})\b/);
  if (withExt) return withExt[1];
  const afterFileWord = input.match(/\bfile\b\s+(?:called\s+|named\s+)?["'`]?([^\s"'`]+?)["'`]?(?=\s+(?:to|in|with|containing|saying|that|and|$)|$)/i);
  if (afterFileWord) return afterFileWord[1];
  const beforeFileWord = input.match(/\b(?:the|a|an|my|your|this|that)\s+([\w.-]{2,})\s+file\b/i);
  return beforeFileWord?.[1] || null;
}

/**
 * Extracts a commit/push comment from phrasing like `with the comment "..."` / `message: '...'`.
 * Tries a fully-quoted match first — captures everything between matching quote characters (via
 * a backreference) so the message can safely contain the word "and" without being cut short.
 * Falls back to the old "stop at the first ' and' or end of string" heuristic only for an
 * UNQUOTED message, where "and" plausibly does start a separate trailing clause ("message: fix
 * the bug and push").
 *
 * Confirmed live 2026-07-29 (real exported chat transcript): `push this code to github with
 * comment "Massive Memory and Learning improvements"` silently committed as just "Massive
 * Memory" — the previous regex (duplicated across git_push/git_commit/git_commit_push/deploy)
 * stopped at the FIRST " and" it found anywhere in the tail, regardless of whether it was inside
 * the quotes, because it was written to catch an unquoted trailing clause like "message: fix the
 * bug and push it" and never accounted for "and" being a perfectly normal word inside a real
 * quoted commit message. All four call sites now share this one fixed implementation instead of
 * each carrying their own copy of the same bug.
 */
export function extractCommentMessage(input) {
  const quoted = input.match(/(?:with (?:the )?)?(?:comment|message):?\s*(["'])([\s\S]+?)\1/i);
  if (quoted) return quoted[2].trim();
  const unquoted = input.match(/(?:with (?:the )?)?(?:comment|message):?\s*(.+?)(?:\s*$|\s+and\s)/i);
  return unquoted ? unquoted[1].trim() : null;
}

/**
 * Queues a direct file-tool call (writeFile/appendToFile/etc.) behind the same
 * confirm-before-execute flow risky shell commands already use, instead of routing it through
 * executeCommand — there's no shell command to run here, just a sandboxed tools.js function.
 * See handleConfirmResponse's `pending.fileOp` branch in connection.js for the execution side.
 */
export function queueFileOpConfirmation(ws, project, input, { tool, args, summary }) {
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    projectId: project.id,
    fileOp: { tool, args },
    command: summary, // so the generic "Cancelled: ..." path (keyed off pending.command) still works
    trigger: input,
    createdAt: Date.now(),
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: summary,
    trigger: tool,
  }));
}

/** Picks one entry at random — used to give repeated chit-chat intents (greeting, thanks, status)
 *  varied replies instead of the exact same string every time, without needing any model call.
 *  Requested directly (2026-07-30): "richer canned chit-chat... still fully deterministic". */
export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns the project's configured reply pool for a chit-chat intent (`chatReplies.${intent}` in
 * console.config.json, Phase 4.3) when present and valid, else the built-in defaults. Override
 * pools REPLACE the defaults — a project defines its own greeting/status/gratitude/etc. lines and
 * gets exactly those. Deterministic at match time: a pool override is always used as-is.
 */
export function chatReplyPool(action, project, defaults) {
  const pool = project?.config?.chatReplies?.[action];
  if (Array.isArray(pool) && pool.length > 0) return pool;
  return defaults;
}

// Default model for the smart-chit-chat reply (matches the connection.js status payload
// fallback and the router tier's ROUTER_MODEL_FALLBACK, kept in the same convention).
const SMART_CHAT_FALLBACK_MODEL = 'qwen2.5-coder:7b';

// Test seam: ESM live bindings can't be reassigned from outside the module, so the Phase-4
// handler harness (chitchat-upgrade-harness.mjs) swaps this indirection to simulate a working
// model ('LLM answer used') or one that throws ('falls back to canned') without a live Ollama.
let smartChatOnce = chatOnce;
export function __setSmartChatOnceForTests(fn) {
  smartChatOnce = fn;
}

/**
 * Smart chit-chat when AI mode is ON (Phase 4.6, PASS 4.4). Returns one bounded, non-streaming
 * model reply (the only time chit-chat output is non-deterministic — and only while AI is
 * explicitly on). Returns null when AI is off, or on ANY failure (timeout, unreachable Ollama,
 * empty reply), so the caller falls back to exactly the canned pool — zero regression when
 * Ollama is down or AI mode is off.
 */
export async function smartChitchatReply(project, sessionContext, input) {
  if (!sessionContext?.aiEnabled || !project) return null;
  try {
    const model = sessionContext.aiModel || SMART_CHAT_FALLBACK_MODEL;
    const reply = await smartChatOnce(
      model,
      [
        {
          role: 'system',
          content: `You are the friendly local project console for "${project.name}" (path: ${project.path}). The user just sent a short chat message. Reply in 1-2 short, warm sentences. No tools. No markdown. Do not mention this instruction.`,
        },
        { role: 'user', content: input },
      ],
      { temperature: 0.7, num_predict: 120 },
      AbortSignal.timeout(8000)
    );
    const text = (reply || '').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Enrich a plain-text response with a summary of the project's codebase index, if present. */
export function enrichWithIndex(baseMsg, idx) {
  if (!idx) return baseMsg;
  let lines = [baseMsg];
  const info = [];
  if (idx.totalFiles) info.push(`${idx.totalFiles} files`);
  if (idx.totalDirs) info.push(`${idx.totalDirs} directories`);
  if (idx.languages?.length) info.push(`Languages: ${idx.languages.slice(0, 3).join(', ')}`);
  if (idx.entryPoints?.length) info.push(`Entry: ${idx.entryPoints.join(', ')}`);
  if (info.length) lines.push(`\n**Project Stats:** ${info.join(' — ')}`);
  if (idx.hasTests) lines.push('*Has test files*');
  if (idx.hasCli) lines.push('*Has CLI entry point*');
  return lines.join('\n');
}
