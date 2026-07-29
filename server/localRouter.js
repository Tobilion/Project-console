import { chatOnce } from './ollama.js';

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

// One-line description of every intent the router is allowed to pick from, keyed by the exact
// name matcher.js's `handleBuiltinIntent()` dispatch switch expects. Deliberately separate from
// intentsData.js's example-phrase lists (those are large, meant for embedding similarity, and
// would bloat this prompt beyond what a small CPU-bound local model can reliably attend to) —
// this is *meaning*, not phrasing. Intentionally NOT auto-derived from BUILTIN_INTENTS in
// matcher.js so a name added there without a description here fails loud (falls through to
// "(no description)" and is easy to spot in testing) rather than silently confusing the model.
const INTENT_DESCRIPTIONS = {
  'system.chit_chat.greeting': 'A greeting (hi/hello) with no other request — no action needed.',
  'system.chit_chat.status': 'Asking how the assistant is doing / if it is alive — no action needed.',
  'system.chit_chat.gratitude': 'Saying thanks — no action needed.',
  'system.chit_chat.clear': 'Clear/reset/wipe this chat window.',
  'system.chit_chat.help': 'Asking what the assistant can do / list available commands.',
  'system.chit_chat.git_status': 'Check git status / uncommitted changes (read-only).',
  'system.chit_chat.explain_followup': 'Asking for more detail on whatever was just discussed.',
  'system.chit_chat.undo': 'Undo/revert the last risky change via git.',
  'system.chit_chat.deploy': 'Deploy / push the site live (commits everything and pushes).',
  'project.knowledge.overview': 'Asking what this project is / a general description.',
  'project.knowledge.stack': 'Asking about the tech stack / languages / frameworks used.',
  'project.knowledge.commands': 'Asking how to run/build/use this project.',
  'project.knowledge.gotchas': "Asking about known issues / gotchas from the project's docs.",
  'project.knowledge.architecture': 'Asking how the project is built / architected.',
  'project.context.structure': 'Asking to see the directory/folder structure.',
  'project.context.languages': 'Asking which programming languages are used.',
  'project.context.file_count': 'Asking how many files/directories the project has.',
  'project.context.entry_point': 'Asking where the app starts / entry point file.',
  'project.context.tech_preview': 'Asking for a general tech snapshot of the project.',
  'project.context.tests': 'Asking whether/where there are tests.',
  'project.context.dependencies': 'Asking to see dependencies (package.json, requirements.txt, etc).',
  'project.context.config': 'Asking to see config files (.env, config.json, etc).',
  run_project: 'Run/start/serve this project (dev server, main script, etc).',
  git_push: 'Push local git commits to the remote (optionally with a commit comment first).',
  git_commit: 'Stage and commit changes to git (optionally with a given commit message).',
  git_commit_push: 'Stage, commit, and push in one step.',
  git_add: 'Stage all changes with git add (no commit).',
  git_init: 'Initialize a new git repository here.',
  git_ignore_add: 'Add a file/folder pattern to .gitignore.',
  git_rm_cached: 'Untrack a file/folder from git while keeping it on disk.',
  git_remote_add: 'Set/attach the git remote origin to a given GitHub URL.',
  npm_install: 'Run npm install.',
  npm_build: 'Run the npm build script.',
  npm_run: 'Run a specific named npm script, or start the dev/start server.',
  file_create: 'Create a brand-new file with specific, explicitly-given text content.',
  file_append: 'Append specific, explicitly-given text to the end of an existing file.',
  file_read: "Read/show an existing file's contents.",
  file_delete: 'Delete a file.',
  project_scan: 'Re-scan/re-index the current project.',
  project_list: 'List available projects, or switch/change to a different project.',
  git_log: 'Show recent git commit history.',
  git_branch: 'List git branches.',
  git_checkout: 'Switch to a different git branch.',
  git_pull: 'Pull/fetch and merge remote git changes.',
  'system.monitoring.metrics': 'Asking for console health/metrics/latency stats.',
};

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
