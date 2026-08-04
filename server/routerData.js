// One-line description of every intent the local router is allowed to pick from, keyed by the
// exact name matcher.js's `handleBuiltinIntent()` dispatch switch expects. Split out of
// localRouter.js (Phase 2 modularization) as pure data.
//
// Deliberately separate from intentsData.js's example-phrase lists (those are large, meant for
// embedding similarity, and would bloat the router prompt beyond what a small CPU-bound local
// model can reliably attend to) — this is *meaning*, not phrasing. Intentionally NOT auto-derived
// from BUILTIN_INTENTS in matcher.js so a name added there without a description here fails loud
// (falls through to "(no description)" and is easy to spot in testing) rather than silently
// confusing the model.

export const INTENT_DESCRIPTIONS = {
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
