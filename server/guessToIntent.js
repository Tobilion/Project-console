// Maps command-guess pattern descriptions / command shapes to intent names, used by
// learningEngine.js when promoting near-miss patterns into intent examples. Split out of
// learningEngine.js (Phase 2 modularization) as pure data — the matching loop below reads it.
//
// The keys on odd entries are regex-tested against `group.description` (the human-readable
// description from guessData.js's `build` output); the command-shape fallbacks live inline in
// learningEngine.js since they inspect the resolved command string, not this map.

export const GUESS_TO_INTENT = {
  'Remove .* from git tracking': 'git_rm_cached',
  'Add .* to .gitignore': 'git_ignore_add',
  'Create file': 'file_create',
  'Delete file': 'file_delete',
  'Install npm package': 'npm_install',
  'Uninstall npm package': 'npm_install',
  'Run npm script': 'npm_run',
  'Start the project': 'npm_run',
  'Stage .* for commit': 'git_add',
};
