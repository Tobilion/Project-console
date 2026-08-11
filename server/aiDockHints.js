// Phase 7 (2026-08-11): AI-dock bootstrap hints. Every message processed in trigger mode
// with AI off skips the AI dock entirely; when a request is genuinely open-ended the matcher
// lands on needs_ai_mode, whose canned replies could only point at the toggle. This module
// turns that dead-end into an instruction: it names the AI dock and hands back a concrete
// phrasing to use there (echoing the user's own request when no better wording exists).
//
// Single consumer today: builtinChitChat's needs_ai_mode handler.

/** An AI-dock phrasing suggestion for a few well-known open-ended shapes; falls back to
 *  echoing the user's own words (the safest usable instruction — it's their request). */
export function aiDockInstruction(input) {
  const lower = input.toLowerCase();
  if (/\b(create|build|write|make|add)\b.*\b(file|function|component|script|module|page)\b/.test(lower)) {
    return 'describe what the new file should do — with AI mode on I can write it for you';
  }
  if (/\b(fix|debug|broken|error|bug|crash|issue)\b/.test(lower)) {
    return 'tell me what is broken and what you expect; with AI mode on I can investigate the code myself';
  }
  if (/\b(explain|summarize|understand|what does|how does|review)\b/.test(lower)) {
    return 'ask it the same way in the AI dock; with AI mode on I can read the code and answer with specifics';
  }
  return `say "${input}" — with AI mode on I can read and edit files in the project and handle open-ended requests`;
}