/**
 * Literal pre-checks for phrases confirmed (via live user testing, not just theory) to get
 * misclassified by pure embedding similarity to a superficially-similar but wrong intent —
 * e.g. "initialize git" / "deploy to my git" both landed on git_status ("check git") instead
 * of git_init / system.chit_chat.deploy, and "add X to gitignore" landed on a generic tech
 * preview response instead of git_ignore_add. These tokens are unambiguous enough in this
 * app's domain that a literal match should always win outright, before the embedding stage
 * ever gets a vote. Keep this list short and deliberately narrow — it's a targeted fix for
 * confirmed traps, not a replacement for the semantic/fuzzy/keyword pipeline below.
 *
 * Extracted from semanticMatcher.js's match() (Phase 5, 2026-08-04) — pure data move, the
 * pattern.test loop and telemetry shape are unchanged.
 */
export const PRE_SEMANTIC_OVERRIDES = [
  // Phase 9 (2026-08-11, probe-verified with real embeddings): question shapes are now known to
  // misfire onto EXECUTING intents — "how to push my changes" landed on deploy (checkpoint +
  // push), "command to stop the server" and "how to open in vs code" landed on run_project, and
  // "how do you build the project" on npm_build. The "how to"/"command to" prefix carries almost
  // no embedding weight, so the cosine is dominated by the action words, which belong to the
  // action intents' phrase clusters. A question prefix + one of these corpus verbs is
  // unambiguous — the user is asking HOW, and the how_do_i catalog answers with the command +
  // example phrases + a suggestion chip; it never executes. Deliberately narrow: run/start/
  // launch/serve verbs are excluded so "how to run the site" stays with the project-specific
  // how_to_run interpretation, and the rule lives FIRST because the bare "deploy" override
  // below would otherwise catch "how to deploy the site" and run a push.
  { intent: 'system.chit_chat.how_do_i', pattern: /^(?:how\s+(?:to|do\s+(?:you|i|we))\s+|(?:what\s+is\s+the\s+)?command\s+to\s+)(?:push|commit|deploy|build|stop\s+the\s+server|open\s+in|show|make\s+a\s+checkpoint|see\s+(?:the\s+)?(?:dashboard|test\s+coverage|bundle)|switch\s+projects|change\s+the\s+theme|check\s+(?:git\s+status|the\s+console\s+health|collisions)|export|schedule|review|approve)/i },
  { intent: 'git_init', pattern: /\bgit\s+init\b|\b(initialize|init)\b.*\brepo(sitory)?\b|\b(initialize|init)\b.*\bgit\b/i },
  { intent: 'git_ignore_add', pattern: /\bgiti?gnore\b/i },
  { intent: 'system.chit_chat.deploy', pattern: /\bdeploy\b|\bpush\s+live\b/i },
  // Confirmed live: "add a file" / "can you help me add a file" (no filename, no git
  // context) was resolving to git_add instead of file_create — both intents' example
  // phrases share the bag-of-words "add" + "file(s)", and git_add's semantic-embedding
  // cluster was winning even for plain file-creation requests. Only fires when there's no
  // git-specific word anywhere in the input, so "add files to git" / "stage all files" /
  // "add new files to git" still resolve to git_add normally. Also excludes "(add/append)
  // ... to (the/this) file" phrasing — that's file_append territory ("add this to the
  // file"), not a new-file request, so it's left to fall through to normal matching instead.
  { intent: 'file_create', pattern: /^(?!.*\b(git|stage|staging|track|tracking|index|commit|repo|repository)\b)(?!.*\bto\s+(?:the\s+|this\s+|that\s+)?file\b).*\b(add|create|make|write|generate)\b.*\bfile\b/i },
  // Confirmed live: "Can I attach the github link" had no matching intent at all before
  // git_remote_add existed, and fell through to an unrelated generic help response. Requires
  // both a connect-style verb AND a github/remote-url noun so it doesn't collide with
  // "push to github" / "deploy to github" (system.chit_chat.deploy), which mention github
  // without asking to attach/set a link.
  { intent: 'git_remote_add', pattern: /\b(attach|add|set|connect|link|point)\b.{0,20}\b(github|remote)\b.{0,20}\b(link|url|repo|repository|address|origin)\b/i },
  // Phase 1 (2026-08-03, measured live with real embeddings): "who uses main.py" scored
  // 0.826 for the new file_find intent ("where is main.py" — the filename dominates the
  // vector) vs 0.770 for project.context.file_relations, silently flipping a documented,
  // confirmed-live intent's own territory. The "who/which ... uses/imports/references"
  // question-verb is unambiguous in this app's domain — it's always file_relations, never a
  // locate request — so it wins outright before the embedding stage. Deliberately narrow:
  // second alternative requires the "which/what + files/modules + verb" shape so "what is
  // imported" (project.context.dependencies) and "what does this file import" stay untouched.
  { intent: 'project.context.file_relations', pattern: /\bwho\s+(?:uses?|imports?|references?|depends\s+on)\b|\b(?:which|what)\s+(?:files?|modules?)\s+(?:use|import|reference)\b/i },
  // Confirmed via the Matchday-Exchange harness (2026-08-04, real embeddings): bare
  // imperative "run server" scored for project.context.scan_servers and "run its server"
  // scored for project.context.dev_server_status — both informative intents whose example
  // clusters share the "server/run" tokens. Neither is ever a legitimate match for an
  // imperative launch request (scan/status phrases are question-shaped: "is the server
  // running", "which servers are up", "scan the servers" — all begin with a non-run verb),
  // so a leading run-family verb + a server/backend/api noun is unambiguous here and wins
  // outright before embedding. Once routed to run_project, stage 1b's config-entry check or
  // builtinIntents.js's findMentionedScript picks the real server script. Deliberately
  // anchored to the START (so "check the server status" / "is the server up" are untouched)
  // AND the noun to the END with an optional trailing "please" — "run api tests" / "run
  // server tests" must stay with run_tests, not be stolen by the run_project redirect.
  // Phase 9 (2026-08-11, probe-verified TODAY with real embeddings): after how_to_run gained
  // site/server-shaped QUESTION examples ("how to run the site", "command to run the server"),
  // the bare imperatives "run the site" / "run the app" / "run the project" drifted onto
  // how_to_run (informational) and stopped launching the dev server — the question cluster
  // pulled the centroid. Same class of trap, same fix: a leading run-family verb + a
  // site/app/project noun is an imperative launch, never a question — literal override wins.
  { intent: 'run_project', pattern: /^(?:run|start|launch|boot|restart|spin\s+up)\s+(?:the\s+|its\s+|your\s+|my\s+|this\s+)?(?:server|backend|api|site|website|app|project)\b(?:\s+please)?$/i },
  // Phase 16 (2026-08-05, harness-verified with real embeddings): file-open requests collided
  // with pre-existing owners — file_read owns the "open file"/"open this file" seeds, and
  // file_find owns every name-bearing "find/where is the X file" shape (the filename dominates
  // the vector, the same trap as the file_relations override above), so "open main.py" /
  // "open the config file" / "open a file" all landed on read/locate instead of open-in-editor.
  // An "open ..." + file-shaped noun is unambiguous in this app's domain — it always means open
  // in the editor, never read or locate — so it wins outright before the embedding stage.
  // Deliberate consequence, probe-verified: the bare "open file"/"open this file" seeds now
  // route to open_file too (opening beats reading for an "open X" ask; both handlers just ask
  // "which file" when no name is present, so the practical difference is nil). Exclusions keep
  // the other open actions' territory: explorer/folder/directory (open_in_explorer),
  // site/url/link (run_project/open_site), github (open_github_page), and vs code/cursor/
  // editor/browser (open_in_vscode/open_in_cursor).
  { intent: 'project.action.open_file', pattern: /^(?:open|open\s+up|open\s+me)\b(?!(?:.*\b(?:explorer|folder|directory|site|website|url|link|github|editor|browser|vs\s*c?ode|cursor)\b)).*\b(?:files?|readme|[\w./-]+\.[a-zA-Z0-9]{1,10})\b/i },
  // Confirmed live (Phase 5, 2026-08-10, matcher probe): "serve the site on port 3040" fell
  // out of the embedding stage entirely (match: null) and landed on system.chit_chat.deploy
  // via a later stage — a bare "serve the site[ on port N]" never means deploy, it means
  // run the dev server on that port. Deliberately narrow: requires the literal serve verb
  // AND the site noun, optional port suffix only.
  { intent: 'npm_run', pattern: /^serve\s+the\s+site(?:\s+(?:on|at|using)\s+port\s+\d{2,5})?$/i },
];

/**
 * Returns the first override whose pattern matches, or null. semanticMatcher.js's match()
 * returns the override's intent with a fixed 0.9 confidence when this hits.
 */
export function findPreSemanticOverride(inputStr) {
  for (const { intent, pattern } of PRE_SEMANTIC_OVERRIDES) {
    if (pattern.test(inputStr)) return { intent, pattern };
  }
  return null;
}
