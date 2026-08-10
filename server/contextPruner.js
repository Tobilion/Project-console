// Adaptive history pruning for AI-mode queries (Phase 1, Part 1.3 — dynamic prompt caching
// & context pruning). The assembled message list is structured as a static prefix (system
// prompt, unchanged between turns of a session) and a dynamic suffix (session history +
// current input). When the dynamic suffix grows toward the model's context budget, the
// middle turns are compressed into a short bullet state instead of being dropped — system
// instructions and the last turns stay verbatim so the model never loses either the rules
// or the immediate conversation state.
//
// Budgets are character-based (no tokenizer available offline), matching the repo-wide
// convention of char caps (ollamaContext's 6000-char doc cap, promptRenderers' caps).
export const HISTORY_MAX_CHARS = 16000;
/** Budget for the compressed middle block once pruning kicks in. */
export const MIDDLE_SUMMARY_CHARS = 1200;
/** Trailing user/assistant turns preserved verbatim (a "turn" is one user + one assistant). */
export const LAST_TURNS_KEPT = 3;
const SNIPPET_CHARS = 120;
const MAX_BULLETS = 3;

function charCount(text) {
  return typeof text === 'string' ? text.length : 0;
}

/** One bullet line for a compressed message; null for empty/unusable content. */
function bulletFor(msg) {
  const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : String(msg.role);
  const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Tool-result payloads are noisy JSON dumps; keep only which tools ran and the outcome
  // shape, since the final answer already carries the actual content.
  if (text.startsWith('Tool results:')) {
    const tools = [...text.matchAll(/Tool (\w+) returned/g)].map((m) => m[1]);
    return `- tool round: ${tools.join(', ') || 'no tools'}`;
  }
  const snippet = text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}...` : text;
  return `- ${role}: ${snippet}`;
}

/**
 * Prunes `messages` (system first, current user input last) when the middle history exceeds
 * the budget. Returns a new array; returns the input unchanged when nothing needs pruning.
 */
export function pruneHistory(messages) {
  if (!messages || messages.length <= 2) return messages;

  const current = messages[messages.length - 1];
  const system = messages[0];
  const history = messages.slice(1, -1);

  const tailStart = Math.max(0, history.length - LAST_TURNS_KEPT * 2);
  const tail = history.slice(tailStart);
  const middle = history.slice(0, tailStart);

  const middleChars = middle.reduce((s, m) => s + charCount(m.content), 0);
  const keptChars = charCount(system.content) + tail.reduce((s, m) => s + charCount(m.content), 0) + charCount(current.content);

  if (middleChars <= MIDDLE_SUMMARY_CHARS && keptChars + middleChars <= HISTORY_MAX_CHARS) {
    return messages;
  }

  const out = [system];

  // Compress the middle into a 3-bullet state: first / middle / last candidate, so both the
  // oldest context and the most recent pre-tail turns survive.
  const candidates = middle.map(bulletFor).filter(Boolean);
  if (candidates.length > 0) {
    let picked;
    if (candidates.length <= MAX_BULLETS) {
      picked = candidates;
    } else {
      const mid = candidates[Math.floor((candidates.length - 1) / 2)];
      picked = [candidates[0], mid, candidates[candidates.length - 1]];
    }
    out.push({
      role: 'system',
      content: `## Earlier in this conversation (compressed)\n${picked.join('\n')}`,
    });
  }

  out.push(...tail, current);

  // Hard guard: even the verbatim suffix can outgrow the budget on its own (very long turns) —
  // drop the oldest tail messages rather than emitting an over-budget request.
  let total = out.reduce((s, m) => s + charCount(m.content), 0);
  while (total > HISTORY_MAX_CHARS && out.length > 2) {
    const dropped = out.splice(1, 1)[0];
    total -= charCount(dropped.content);
  }
  return out;
}
