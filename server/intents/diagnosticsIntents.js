// project.diagnostics.* — read-only codebase health checks built on infrastructure that already
// existed for other purposes (Phase 1's symbol/import graph, the Phase 1.4 background type
// checker, per-process log ring buffers). Phase 5 intent taxonomy expansion (audit 2026-08-10).
export const DIAGNOSTICS_INTENTS = {
  'project.diagnostics.dead_code': {
    examples: [
      'find dead code', 'find unused exports', 'any dead code', 'find unused code',
      'what exports are unused', 'check for dead code', 'find code that is never used',
      'unused exports', 'find unreferenced exports', 'is there any dead code',
      'find code nobody uses', 'check for unused exports', 'find exports nothing imports',
      'scan for dead code', 'find orphaned code', 'what functions are never called',
    ],
  },
  'project.diagnostics.circular_imports': {
    examples: [
      'check for circular imports', 'find circular dependencies', 'any circular imports',
      'check for import cycles', 'find circular requires', 'do i have circular imports',
      'check for dependency cycles', 'find import loops', 'are there circular imports',
      'scan for circular dependencies', 'check my imports for cycles',
      'find files that import each other', 'check for circular references',
    ],
  },
  'project.diagnostics.type_check': {
    examples: [
      'run a type check', 'check my types', 'run tsc', 'type check the project',
      'check for type errors', 'run typescript check', 'any type errors',
      'check types', 'run the type checker', 'validate my types',
      'do i have type errors', 'check for typescript errors', 'run tsc --noemit',
      'typecheck this project', 'check the project for type errors',
    ],
  },
  'project.diagnostics.env_check': {
    examples: [
      'check my env variables', 'check for missing env vars', 'validate my env file',
      'check .env against .env.example', 'am i missing any env variables',
      'check environment variables', 'compare env to env example', 'check my .env setup',
      'is my env file complete', 'validate environment variables',
      'check for missing environment variables', 'diff env and env example',
      'what env vars am i missing',
    ],
  },
  // Infrastructure expansion (2026-08-10) — not project-scoped like the rest of this file, but
  // grouped here rather than creating a one-entry file: it's another read-only "ask the console
  // something about your work" intent, just spanning every scanned project instead of one.
  'system.knowledge.cross_project_search': {
    examples: [
      'which project did i set up stripe in', 'which project has the auth code',
      'search all projects for', 'search across my projects',
      'which project did i do this in', 'find this across all my projects',
      'what project was this in', 'search every project for',
      'which project has redis', 'where did i set up webhooks',
      'search all my projects', 'find which project i did this in',
      'which of my projects has this', 'search across all projects for',
      'what project did i configure this in', 'find across projects',
    ],
  },
  'project.diagnostics.log_errors': {
    examples: [
      'check the logs for errors', 'any errors in the logs', 'show recent errors',
      'check process logs for errors', 'scan the logs for errors', 'find errors in the log',
      'are there errors in the server log', 'check for recent errors',
      'show errors from the running process', 'any recent error output',
      'check the running process for errors', 'look for errors in the logs',
    ],
  },
  // Phase 8 (2026-08-11): the two diagnostics long-deferred in the intent-taxonomy pass — now
  // that the codebase-infra exists, both are read-only artifact analyzers (no linter/bundler
  // ever runs): coverage parses existing lcov/summary reports, bundle size walks existing build
  // output. Both answer "no artifact found" cleanly instead of implying the data exists.
  'project.diagnostics.test_coverage_report': {
    examples: [
      'what is my test coverage', 'check test coverage', 'show test coverage',
      'how covered are my tests', 'test coverage report', 'coverage report',
      'do i have good test coverage', 'how much of my code is covered by tests',
      'how well are my tests covering the code', 'are my tests covering everything',
      'test coverage percentage', 'check my coverage numbers',
    ],
  },
  'project.diagnostics.bundle_size_analysis': {
    examples: [
      'analyze bundle size', 'bundle size report', 'how big is my bundle',
      'check the bundle size', 'bundle analysis', 'how large is the production bundle',
      'what is my bundle size', 'bundle size check', 'analyze the production build',
      'how big is the built output', 'analyze the build output',
      'is my bundle too big',
    ],
  },
};
