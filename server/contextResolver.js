const PRONOUN_PATTERN = /\b(it|this|that|they|those|these|them)\b/i;

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

  // Try to match a known contextual keyword in the input
  for (const [keyword, intent] of Object.entries(CONTEXTUAL_MAP)) {
    if (inputLower.includes(keyword)) {
      return { builtin: intent, source: 'context_resolver' };
    }
  }

  // If input is very short (under 10 chars) and last had an intent,
  // assume they want the same thing
  if (inputLower.length < 10 && last.intent) {
    return { builtin: last.intent, source: 'context_resolver' };
  }

  return null;
}
