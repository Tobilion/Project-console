import { chatOnce } from './ollama.js';
import { INTENT_DESCRIPTIONS } from './routerData.js';

// Fallback model if the caller doesn't have one selected yet (matches the default shown in
// connection.js's status payload — see `model: sessionContext.aiModel || 'qwen2.5-coder:7b'`).
const ROUTER_MODEL_FALLBACK = 'qwen2.5-coder:7b';

// Keep this bounded and well under a full AI-mode turn — this is a classification call, not a
// conversation. Hard constraints: CPU-only, 16GB RAM, must
// stay "fast tier" fast.
// Nudged from 7s to 8s (still inside the plan's stated 5-8s bound) now that the prompt can
// optionally include a repo-map slice, which adds prompt-processing time on CPU-only hardware.
const ROUTER_TIMEOUT_MS = 8000;
// 2026-09-11: 200 -> 600. Reasoning models (gpt-oss:120b-cloud measured 256 thinking chars
// before any content on a trivial ping) burn the whole budget thinking and return empty
// content — the router then nulls cleanly but never rescues. 600 covers thinking + the short
// JSON payload with headroom; non-thinking models stop at EOS and never touch the extra
// budget, and the 8s timeout above still bounds wall-clock. Only the last-resort path pays.
const ROUTER_NUM_PREDICT = 600;

/**
 * JSON schema for Ollama's constrained decoding (Step 5 — replaces the free-text "respond
 * with ONLY strict JSON" plea). The intent enum carries the exact allowed list, so the
 * sampler CANNOT emit an unknown intent, a code fence, or commentary by construction; the
 * old extractJson salvage below stays as defense-in-depth for daemons that half-support
 * `format` (it degrades to exactly today's free-text behavior). `entities` is a free-form
 * object for Step-4 slot keys (script/message/port/filter) — constrained shape, open content.
 * Exported pure for unit tests (no daemon needed).
 */
export function buildRouterSchema(intents) {
  return {
    type: 'object',
    properties: {
      intent: { type: ['string', 'null'], enum: [...intents, null] },
      entities: { type: 'object' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['intent', 'confidence'],
  };
}

/**
 * Validate a decoded router payload against the allowed set. Returns
 * { intent, entities, confidence } or null (→ caller falls through to today's behavior).
 * Confidence is numeric 0-1; below 0.5 (no better than a coin flip) or a null/absent intent
 * is a refusal, mirroring the old 'low'/null rejections. Exported pure for unit tests.
 */
export function validateRouterPayload(parsed, intents) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { intent, entities, confidence } = parsed;
  if (intent === null || intent === undefined || intent === 'null') return null;
  if (typeof intent !== 'string' || !intents.includes(intent)) return null;
  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0.5 || confidence > 1) return null;
  return {
    intent,
    entities: entities && typeof entities === 'object' && !Array.isArray(entities) ? entities : {},
    confidence,
  };
}
/**
 * Salvage fallback for daemons that half-support `format` (or none at all): strip a
 * ```json ... ``` / ``` ... ``` fence if the model wrapped its answer in one, then find the
 * first balanced {...} block and JSON.parse it. Small local models routinely add commentary
 * before/after the JSON despite being told not to (the same failure mode `aiStream.js`'s
 * `<tool_call>` extraction has to tolerate) — deliberately forgiving. With constrained
 * decoding active this path should never fire; when it does, output degrades to exactly the
 * old free-text behavior, never an error.
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
  // capped slice of project.codebaseIndex.repoMap).
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

Respond with a JSON object matching this shape (the decoding is schema-constrained, so stay
inside it): {"intent": "<one of the exact names above, or null>", "entities": {}, "confidence": <0-1 number>}
"entities" carries Step-4 slot keys when the message states them (script/message/port/filter),
else {}. Use confidence below 0.5 (or intent: null) whenever you are genuinely unsure — a
wrong guess is worse than admitting uncertainty.

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
      // Step 5: schema-constrained decoding — the sampler can only emit {intent, entities,
      // confidence} inside the allowed enum, so unknown-intent and non-JSON outputs are
      // impossible by construction (not by plea). Trigger mode is untouched and still tried
      // first for everything; this remains the last-resort path only.
      { temperature: 0, num_predict: ROUTER_NUM_PREDICT, format: buildRouterSchema(intents) },
      AbortSignal.timeout(ROUTER_TIMEOUT_MS),
      host
    );
  } catch {
    // Ollama not running, model not pulled, timed out, or a transport error — this is the
    // "additive only" guarantee: the caller falls through to exactly today's behavior.
    return null;
  }

  // Constrained output should JSON.parse directly; the salvage path covers daemons that
  // half-support `format` (degrades to the old free-text behavior, never an error).
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw || '').trim());
  } catch {
    parsed = extractJson(raw);
  }
  const valid = validateRouterPayload(parsed, intents);
  if (!valid) return null;

  return {
    intent: valid.intent,
    entities: valid.entities,
    confidence: valid.confidence,
  };
}
