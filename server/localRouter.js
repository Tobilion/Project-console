import { chatOnce } from './ollama.js';
import { INTENT_DESCRIPTIONS } from './routerData.js';

// Fallback model if the caller doesn't have one selected yet (matches the default shown in
// connection.js's status payload — see `model: sessionContext.aiModel || 'qwen2.5-coder:7b'`).
const ROUTER_MODEL_FALLBACK = 'qwen2.5-coder:7b';

// Keep this bounded and well under a full AI-mode turn — this is a classification call, not a
// conversation. See LOCAL_ROUTER_UPGRADE_PROMPT.md's hard constraints: CPU-only, 16GB RAM, must
// stay "fast tier" fast.
// Nudged from 7s to 8s (still inside the plan's stated 5-8s bound) now that the prompt can
// optionally include a repo-map slice, which adds prompt-processing time on CPU-only hardware.
const ROUTER_TIMEOUT_MS = 8000;
const ROUTER_NUM_PREDICT = 200;

/**
 * Strip a ```json ... ``` / ``` ... ``` fence if the model wrapped its answer in one, then find
 * the first balanced {...} block in what's left and JSON.parse it. Small local models routinely
 * add commentary before/after the JSON despite being told not to (the same failure mode
 * `aiStream.js`'s `<tool_call>` extraction has to tolerate) — this is deliberately forgiving
 * rather than assuming the whole response is a clean JSON string.
 */
function extractJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function buildPrompt(input, allowedIntents, repoMapSlice) {
  const lines = allowedIntents.map((name) => `- ${name}: ${INTENT_DESCRIPTIONS[name] || '(no description)'}`);
  // Repo-map context is optional and only included when the caller has one (matcher.js passes a
  // capped slice of project.codebaseIndex.repoMap — see LOCAL_ROUTER_UPGRADE_PROMPT.md piece 2).
  // It's here so a loose reference like "the config file" or "that component" can be resolved
  // against real project file names instead of guessed at blind — this router still only picks
  // an *intent*, it never returns a resolved file path as fact; handlers still call
  // findFiles/readFile themselves before acting on a filename.
  const repoMapSection = repoMapSlice
    ? `\n\nProject files (for resolving loose references like "the config file" — for context only, verify with findFiles/readFile before acting):\n${repoMapSlice}`
    : '';
  return `You are a strict intent classifier for a local developer-tools console. Given the user's
message, pick the single best-matching intent from the list below, or null if none genuinely fit
(don't force a weak match).

Available intents:
${lines.join('\n')}${repoMapSection}

Respond with ONLY strict JSON — no commentary, no markdown code fences, nothing before or after it:
{"intent": "<one of the exact names above, or null>", "args": {}, "confidence": "high"|"medium"|"low"}

Use "low" confidence (or intent: null) whenever you are genuinely unsure — a wrong guess is worse
than admitting uncertainty. "args" may stay an empty object; it exists only for future use and is
not required for a valid answer.

User message: "${input}"`;
}

/**
 * The router tier: one bounded local-model call to classify a user message into one of this
 * app's existing builtin intents, for phrasings the embedding/NLP/fuzzy pipeline in matcher.js
 * didn't confidently resolve. Returns null (never throws) on any failure — timeout, unreachable
 * Ollama, malformed JSON, an intent name outside the allowed set, or low confidence — so callers
 * can simply fall through to today's exact existing behavior (commandGuesser -> suggestions).
 *
 * This function only *decides* which intent fired. Dispatch still goes through the same
 * `handleBuiltinIntent()` used by every other matching stage — see matcher.js's stage 4.
 */
export async function routeViaLocalModel(input, { model, allowedIntents, repoMapSlice, host } = {}) {
  const intents = allowedIntents && allowedIntents.length ? allowedIntents : Object.keys(INTENT_DESCRIPTIONS);
  const prompt = buildPrompt(input, intents, repoMapSlice);

  let raw;
  try {
    raw = await chatOnce(
      model || ROUTER_MODEL_FALLBACK,
      [{ role: 'user', content: prompt }],
      { temperature: 0, num_predict: ROUTER_NUM_PREDICT },
      AbortSignal.timeout(ROUTER_TIMEOUT_MS),
      host
    );
  } catch {
    // Ollama not running, model not pulled, timed out, or a transport error — this is the
    // "additive only" guarantee: the caller falls through to exactly today's behavior.
    return null;
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const { intent, args, confidence } = parsed;
  if (!intent || intent === 'null' || !intents.includes(intent)) return null;
  if (confidence === 'low') return null;

  return {
    intent,
    args: args && typeof args === 'object' ? args : {},
    confidence: confidence === 'high' || confidence === 'medium' ? confidence : 'medium',
  };
}
