// consoleCommandDocs.js — reference catalog for the system.chit_chat.how_do_i intent (Phase 1,
// 2026-08-10). "how do i X" questions used to fall through to the generic fallback because the
// matcher has no intent per feature; this catalog turns the question into a targeted answer:
// subject keywords are matched against COMMAND_DOCS entries (longest matching keyword wins) and
// up to three best entries are rendered by builtinChitChat.js's how_do_i handler.
//
// Entries mirror the README "Chat commands (reference)" table plus console features with no
// typed command (theme toggle, model picker, exports). `command` is the thing to type or the UI
// control to reach; `explain` is one line describing what it does. Keywords are substrings of the
// question's subject ("check git status" contains "git status"), so keep them narrow — a keyword
// like "push" alone would hijack every "how do i push ..." question that belongs to git docs.
export const COMMAND_DOCS = [
  { keywords: ['run the site', 'run the project', 'run this project', 'launch the site'], command: 'run the site', explain: 'starts the project\'s dev server via its detected entry point and prints the link when it is up.' },
  { keywords: ['run the tests', 'run tests', 'test suite'], command: 'run the tests', explain: 'finds and runs the project\'s test command (pytest, vitest, ...).' },
  { keywords: ['run the build', 'npm run', 'run the dev server'], command: 'run the dev server', explain: 'matches package.json scripts — "run the build" runs the build script.' },
  { keywords: ['stop the server', 'stop server', 'kill the server'], command: 'stop the server', explain: 'stops the running dev server and anything else the console started for this project.' },
  { keywords: ['the link', 'url', 'site url'], command: 'what is the link', explain: 'prints the project\'s current dev-server URL (or that no server is responding).' },
  { keywords: ['push to github', 'push my changes', 'commit and push', 'push this', 'deploy'], command: 'deploy', explain: 'checkpoint-commits all changes then pushes — deploy-on-push targets go live automatically.' },
  { keywords: ['commit my changes', 'commit with', 'commit the changes'], command: 'commit "fix the login bug"', explain: 'commits without pushing — add your message in quotes.' },
  { keywords: ['git status', 'what changed', 'pending changes', 'working tree'], command: 'check git status', explain: 'shows uncommitted/unpushed changes.' },
  { keywords: ['git log', 'recent commits', 'commit history'], command: 'git log', explain: 'shows recent commit history.' },
  { keywords: ['git diff', 'what did i change'], command: 'git diff', explain: 'shows the diff of modified files.' },
  { keywords: ['checkpoint', 'backup my work', 'save my work'], command: 'make a checkpoint', explain: 'git add-all plus a checkpoint commit before risky moves.' },
  { keywords: ['export', 'pdf', 'markdown', 'chat log', 'download this conversation', 'json'], command: 'chat header download icon', explain: 'exports the current session as Markdown, JSON, or PDF; the project chat log downloads from the session list.' },
  { keywords: ['schedule', 'scheduled', 'every 5 minutes', 'daily at', 'on file save', 'on git commit', 'timer'], command: 'schedule every 10 minutes "git status"', explain: 'runs a command on a timer or trigger; automated actions go through the normal confirm flow first.' },
  { keywords: ['list schedules', 'my schedules'], command: 'list schedules', explain: 'shows the project\'s scheduled/triggered commands.' },
  { keywords: ['delete schedule', 'remove schedule'], command: 'delete schedule 2', explain: 'removes a scheduled command by its list number.' },
  { keywords: ['schedule log'], command: 'schedule log', explain: 'shows the run history of scheduled commands.' },
  { keywords: ['theme', 'dark mode', 'light mode'], command: 'the theme toggle in the top bar (sun/moon)', explain: 'switches dark/light; the choice persists per browser.' },
  { keywords: ['model', 'ollama', 'cloud model', 'llama'], command: 'the model picker in the AI popover', explain: 'lists local Ollama and cloud models; pull new ones with the Ollama app (ollama pull llama3).' },
  { keywords: ['pack', 'custom tools', 'install a tool'], command: 'install pack <path-to-console.tools.json>', explain: 'adds custom tools from a local manifest — preview first, confirm to install.' },
  { keywords: ['learning', 'near miss', 'suggestions'], command: 'review learning', explain: 'shows near-miss phrases the console learned from your corrections.' },
  { keywords: ['approve suggestions', 'promote suggestions'], command: 'approve suggestions 1 3', explain: 'promotes selected learned phrases into intent examples.' },
  { keywords: ['telemetry', 'stats', 'threshold'], command: 'telemetry review', explain: 'shows intent match statistics and threshold tuning.' },
  { keywords: ['collisions'], command: 'check collisions', explain: 'finds intents that overlap in embedding space (cosine >= 0.9).' },
  { keywords: ['distillations', 'distillation'], command: 'review distillations', explain: 'shows AI-exchange observations distilled into trigger-style config suggestions.' },
  { keywords: ['review memory', 'memory patterns'], command: 'review memory', explain: 'shows the project\'s command/file/question usage patterns.' },
  { keywords: ['switch projects', 'change projects', 'which project'], command: 'the project list in the left sidebar', explain: 'each project card opens a fresh chat session scoped to that project.' },
  { keywords: ['dashboard', 'live sites'], command: 'the Dashboard tab in the left sidebar', explain: 'project overview plus live-site status with per-project actions.' },
  { keywords: ['running processes', 'processes'], command: 'show running processes', explain: 'lists commands the console is tracking for this project.' },
  { keywords: ['vs code', 'vscode', 'cursor', 'explorer', 'terminal'], command: 'open the project in vs code', explain: 'opens the project folder in your editor/explorer/terminal.' },
  { keywords: ['github page'], command: 'open the github page', explain: 'opens the project\'s GitHub repo page in the browser.' },
  { keywords: ['create a file', 'new file', 'make a file'], command: 'create file notes.txt "hello"', explain: 'creates a file with quoted content (confirm-gated).' },
  { keywords: ['find the', 'find a file', 'locate', 'where is the file'], command: 'find the config file', explain: 'locates a file by name inside the project.' },
  { keywords: ['remember', 'memory.md', 'save a memory'], command: 'AI mode: "remember that ..."', explain: 'saves a durable cross-session fact to .console/memory.md (AI mode only).' },
  { keywords: ['init', 'console.config.json', 'config file'], command: 'npx local-project-console init', explain: 'bootstraps a console.config.json for a project.' },
  { keywords: ['help', 'commands', 'what can you do'], command: 'help', explain: 'prints the full command reference.' },
  { keywords: ['what port', 'port number', 'port are you'], command: 'what port are you running on', explain: 'tells you the console\'s own port.' },
  { keywords: ['undo', 'revert that', 'made a mistake'], command: 'undo', explain: 'restores the last change (git checkpoint or file journal).' },
  { keywords: ['run a command', 'execute a command', 'type a command'], command: 'type the command directly', explain: 'allowlisted command lines (git push, npm run ...) run as-is without the matcher.' },
];

/**
 * Best COMMAND_DOCS entries for a "how do I ..." question. Strips the how-do-i prefix, matches
 * keywords as substrings of the remaining subject, and returns up to three entries ordered by
 * longest matching keyword (more specific wins). Empty subject or no hits -> [].
 */
export function lookupCommandDocs(input) {
  const subject = input
    .replace(/^how\s+(?:do|can|would|does|did|should|could|to)\s+(?:i|we|you|me)?\s*/i, '')
    .replace(/[?!.\s]+$/g, '')
    .toLowerCase();
  if (!subject) return [];
  const scored = [];
  for (const entry of COMMAND_DOCS) {
    let best = 0;
    for (const keyword of entry.keywords) {
      if (subject.includes(keyword) && keyword.length > best) best = keyword.length;
    }
    if (best > 0) scored.push({ entry, best });
  }
  scored.sort((a, b) => b.best - a.best);
  return scored.slice(0, 3).map((s) => s.entry);
}