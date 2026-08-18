import { keywordRegex } from './regexUtils.js';
import { isReadOnlyIntent } from './schedules/scheduleIntents.js';

const PRONOUN_PATTERN = /\b(it|this|that|they|those|these|them)\b/i;

// Word-boundary matching, not `.includes()` — this is a last-resort fallback (only reached after
// semantic/NLP/router/fuzzy all fail to match anything, see connection.js's "no match — try
// conversation context carryover" call site), so a false-positive substring hit here is worse
// than the honest "no match" it would otherwise replace. Plain substring checks let short keywords
// like "main"/"run"/"test" fire inside unrelated words — "maintaining good habits" contains
// "main", "the crunch is real" contains "run" — which would silently misroute an unrelated message
// into a specific project-context answer instead of falling through to suggestion chips. Escaping
// each keyword and requiring a real word boundary on both sides (via regexUtils.keywordRegex)
// closes that off while still matching the intended phrasing ("what's the main file", "let's run
// this").

const CONTEXTUAL_MAP = {
  'main file':      'project.context.entry_point',
  'entry point':    'project.context.entry_point',
  'entry':          'project.context.entry_point',
  'main entry':     'project.context.entry_point',
  'main':           'project.context.entry_point',
  'test':           'project.context.tests',
  'testing':        'project.context.tests',
  'tests':          'project.context.tests',
  'depend':         'project.context.dependencies',
  'package':        'project.context.dependencies',
  'requirements':   'project.context.dependencies',
  'config':         'project.context.config',
  'configuration':  'project.context.config',
  'env':            'project.context.config',
  '.env':           'project.context.config',
  'file count':     'project.context.file_count',
  'how many':       'project.context.file_count',
  'language':       'project.context.languages',
  'programming':    'project.context.languages',
  'tech':           'project.context.tech_preview',
  'technology':     'project.context.tech_preview',
  'preview':        'project.context.tech_preview',
  'folder':         'project.context.structure',
  'director':       'project.context.structure',
  'tree':           'project.context.structure',
  'structure':      'project.context.structure',
  'run':            'run_project',
  'start':          'run_project',
  'launch':         'run_project',
};

const COMPILED_CONTEXTUAL_MAP = Object.entries(CONTEXTUAL_MAP).map(([keyword, intent]) => ({
  intent,
  re: keywordRegex(keyword),
}));

export function resolveContext(input, lastTurns) {
  if (!lastTurns || lastTurns.length === 0) return null;

  const last = lastTurns[lastTurns.length - 1];
  if (!last.matched) return null;

  const inputLower = input.toLowerCase().trim();

  // Check if input is vague (pronouns or very short)
  const hasPronouns = PRONOUN_PATTERN.test(inputLower);

  // If input has pronouns and last turn was a specific project context,
  // try to determine what they're asking about
  if (hasPronouns) {
    // "show it" / "tell me about it" → repeat last intent
    if (last.intent) {
      return { builtin: last.intent, source: 'context_resolver' };
    }
  }

  // Try to match a known contextual keyword in the input (word-boundary, not substring — see
  // the comment above CONTEXTUAL_MAP for why).
  for (const { intent, re } of COMPILED_CONTEXTUAL_MAP) {
    if (re.test(inputLower)) {
      return { builtin: intent, source: 'context_resolver' };
    }
  }

  // If input is very short (under 10 chars) and last had an intent, assume they want the same
  // thing — but ONLY when that intent is read-only (audit 2026-08-17): a bare "ok"/"yes" after
  // a mutating turn (deploy, git push, file delete) used to re-dispatch the mutation. Read-only
  // repeat is the intended carryover ("yes" after "show me the todos"); mutating repeat is a
  // footgun, and every mutating intent is confirm-gated precisely because it may not be what
  // the user wants re-run. Reuses the same allowlist as scheduled triggers (scheduleIntents.js)
  // so the two "what may run unattended" definitions can never drift apart.
  if (inputLower.length < 10 && last.intent && isReadOnlyIntent(last.intent)) {
    return { builtin: last.intent, source: 'context_resolver' };
  }

  return null;
}
