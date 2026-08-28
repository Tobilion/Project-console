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
  // NetPulse crosscheck (2026-08-17): "How do I publish" (and "how do i publish to npm") fired
  // the deploy git-push confirm — the deploy example cluster owns publish-shaped phrases, and
  // "publish" was missing from this list. Added alongside deploy; the catalog answers with the
  // push-to-github guidance first and the npm publish option as the suggestion.
  // 2026-08-26 live crosscheck: "how CAN i push my code" AND "whats the best way to push" both
  // fired the deploy confirm — the how-prefix only covered to/do-you-i-we, and "best way to"
  // shapes were entirely uncovered. The full question-helper set (can/would/could/should) and
  // the best-way prefix are covered now; `pus` (the live typo) too. All are unambiguous HOW
  // questions and must never execute or confirm.
  { intent: 'system.chit_chat.how_do_i', pattern: /^(?:(?:how\s+(?:to|do\s+(?:you|i|we)|can\s+(?:i|we)|would\s+(?:i|we)|could\s+(?:i|we)|should\s+(?:i|we))\s+)|(?:what(?:'s|s| is) the (?:best|easiest) way to\s+)|(?:what\s+is\s+the\s+)?command\s+to\s+|(?:can|could|would|should)\s+(?:i|we)\s+|how\s+do\s+i\s+get\s+to\s+|where\s+is\s+(?:the\s+)?)(?:pus|push|commit|deploy|publish|build|undo|(?:take|make)\s+a\s+backup|backup|remember|(?:make|write|add)\s+a\s+note|open\s+(?:an\s+old|a\s+previous|my\s+old|my\s+previous|the\s+previous)\s+chat|stop\s+(?:the\s+server|it\b)|open\s+in|show|make\s+a\s+checkpoint|see\s+(?:the\s+)?(?:dashboard|test\s+coverage|bundle|history|terminal)|switch\s+projects|change\s+(?:the\s+)?(?:theme|accent\s+color)|check\s+(?:git\s+status|the\s+console\s+health|collisions)|settings?|preferences?|dashboard|history|terminal\s+view|export|schedule|review|approve|version|offline|ai\s+mode|trigger\s+mode|data\s+safe|privacy)/i },
  // App meta questions (2026-08-28 audit): "what version am i running", "is this offline",
  // "what is ai mode vs trigger mode", "is my data safe" all drifted to overview/stack/status
  // because their nouns dominate the embedding. They are how_do_i catalog questions with their
  // own entries — pin the question shapes so they answer from the catalog, never a project Q&A.
  { intent: 'system.chit_chat.how_do_i', pattern: /^what\s+version\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^is\s+this\s+offline\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^what\s+is\s+ai\s+mode\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^is\s+my\s+data\s+safe\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^where\s+does\s+my\s+data\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+is\s+this\s+different\s+from\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^what\s+can\s+this\s+actually\s+do\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^check\s+for\s+updates\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^(?:turn\s+on|enable|disable|turn\s+off)\s+(?:sandbox|clipboard|accent|theme|permission)\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^what(?:'s|s| is)\s+my\s+(?:permission\s+mode|theme|clipboard|accent)/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^what\s+theme\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^change\s+(?:my\s+)?accent\s+color\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+do\s+i\s+open\s+history\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^(?:nothing\s+is\s+working|it\s+broke\s+again)\b/i },
  { intent: 'system.chit_chat.ack', pattern: /^\s*ok\s*\??\s*$/i },
  { intent: 'system.chit_chat.ack', pattern: /^\s*okay\s*\??\s*$/i },
  // "how do i set up ai mode" (live 2026-08-26) answered the status line — the needs_ai_mode
  // intent owns the AI-setup questions; pin every set-up/turn-on/use-ai phrasing to it.
  { intent: 'system.chit_chat.needs_ai_mode', pattern: /^(?:how\s+(?:do|can|would|should)\s+i\s+)?(?:set\s+up|turn\s+on|enable|activate|start|use)\s+(?:ai\s+mode|the\s+ai|ai\s+assistant|ai)\b/i },
  // Desktop build/release self-documentation (2026-08-25): "how do i rebuild the desktop app"
  // drifted to project.knowledge.how_to_run (answered with the scanned project's CLAUDE.md),
  // "how do i release an update" matched git_fetch and fired a CONFIRM PROMPT (git fetch), and
  // "how do i run the build" matched npm_run and EXECUTED `npm run build` — all three are
  // questions about building/releasing the CONSOLE itself, never the active project, and none
  // may execute or confirm anything. They pin to how_do_i, whose desktop catalog entry renders
  // server/desktop-release.md (the maintained build/release pipeline doc).
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+(?:do|can|would|should)\s+i\s+(?:re)?build\s+(?:the\s+)?desktop\s+app\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+(?:do|can|would|should)\s+i\s+release\s+(?:an|a)\s+update\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+(?:do|can|would|should)\s+i\s+run\s+the\s+build\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+(?:do|can|would|should)\s+i\s+.*\bapp\s+icon\b/i },
  // CI/embedding determinism (2026-08-25): two matcher rows drifted on the ubuntu CI runner
  // (a fresh model download produces slightly different floats than this Windows machine):
  // "push the site with the comment ..." flipped todos→git_push, and the multi-split parts of
  // "run the tests and show me the results" collapsed when "show me the results" flipped
  // run_project→structure. These literal pins make both machine-independent — the multi-split
  // (stage 0) runs before this stage, but each split PART passes through match() and hits its
  // pin. "run the tests" is pinned to its own intent to protect the multi's first member.
  { intent: 'git_push', pattern: /^push\s+the\s+site\s+with\s+the\s+comment\b/i },
  { intent: 'run_tests', pattern: /^run\s+the\s+tests$/i },
  { intent: 'run_project', pattern: /^show\s+me\s+the\s+results$/i },
  // Matchday-Exchange live session (2026-08-14): "what is the site about" routed to
  // system.chit_chat.deploy — a read-only question triggered the git-push confirm card — and
  // "what is the details of the site" landed on project.context.dev_server_status. The
  // deploy/status example clusters are saturated with "the site" phrases, so the cosine is
  // dominated by the noun. A what-verb + site/app/project noun + about/details/for question is
  // unambiguous in this app's domain — it asks what the project IS, never to push it or check
  // its server. Same trap class as the how_do_i pin above, so it lives alongside it.
  { intent: 'project.knowledge.overview', pattern: /^what(?:'s| is| are)\s+(?:the\s+)?(?:site|app|website|project)\s+(?:about|details|for)\b/i },
  { intent: 'project.knowledge.overview', pattern: /^what(?:'s| is| are)\s+(?:the\s+)?details?\s+(?:of|about|on)\s+(?:the\s+)?(?:site|app|website|project)\b/i },
  // Same live session: typo'd time questions drifted into unrelated clusters — "what is the
  // tme" answered with the tech stack and "what as time\" executed git status. A what-verb +
  // a (typo-tolerant) time/clock noun is unambiguous — it is always the clock, never a
  // stack/status question. The \b boundary keeps "timeline"/"times" (plural) on their
  // existing routes.
  { intent: 'system.chit_chat.time', pattern: /^what(?:'s| is| as| are)\s+(?:the\s+)?(?:t(?:i)?me|clock)\b/i },
  { intent: 'git_init', pattern: /\bgit\s+init\b|\b(initialize|init)\b.*\brepo(sitory)?\b|\b(initialize|init)\b.*\bgit\b/i },
  { intent: 'git_ignore_add', pattern: /\bgiti?gnore\b/i },
  // The deploy literal rule (audit 2026-08-17): "deploy"/"push live" is unambiguous as an
  // IMPERATIVE, but the same tokens appear in negation/hesitation shapes — "don't deploy",
  // "should i deploy", "is it deployed", "stop deploying" — which must NOT trigger a git-push
  // confirm card. A leading negative/question marker routes those to normal matching instead
  // (the how_do_i rule above already owns the "how do i deploy" shapes).
  { intent: 'system.chit_chat.deploy', pattern: /^(?!.*\b(?:don'?t|dont|do\s+not|should\s+(?:i|we|you)|is\s+it|stop)\b).*(?:\bdeploy\b|\bpush\s+live\b)/i },
  // 2026-08-26 live batch crosscheck: bare "commit" / "comit" routed to git_status by the
  // fuzzy stage ("commit" prefix-matches git_status's "commit history" example) and RAN A
  // STATUS CHECK instead of offering the commit flow. A bare commit token with no object is
  // unambiguous in this app's domain — it is the commit action, never a status question
  // ("what changed"/"any changes" own the status phrasings and are untouched). The same pin
  // fixes the "commit" PART of conjunction splits ("commit and push" used to split into
  // [git_status, deploy]); the whole-phrase matchMulti guard in matcherMulti.js keeps the
  // compound itself on git_commit_push.
  { intent: 'git_commit', pattern: /^com?mit\s*(?:it|now|everything|all|this|my changes|the changes|the code|my work)?$/i },
  // 2026-08-26 live batch crosscheck: yes/no STATE questions about pushing/committing fired
  // the ACTIONS — "did i push yet" opened the git-push confirm, "did i commit" opened the
  // commit confirm, "have i pushed recently" landed on deploy. The how_do_i helper override
  // covers how-can-would-should forms, but the English yes/no-past form ("did/have/is/was
  // ... pushed?") carries the action verb with no question marker the embedding clusters can
  // see. A leading did/have/is/was/are + a pushed/committed mention is unambiguous: a state
  // question, answered by git status (which shows the ahead/behind state), never an action.
  // Imperatives ("push", "commit now") don't start with these verbs and stay untouched.
  // "do i need to push/pull" is the git_ahead_behind diagnostic, not git_status — pin early
  // so it wins over the broad git_status pin that would otherwise steal it.
  { intent: 'git_ahead_behind', pattern: /\b(?:do|does|should|did)\s+(?:i|we)\s+need\s+to\s+(?:push|pull)\b/i },
  { intent: 'git_ahead_behind', pattern: /\bneed\s+to\s+(?:push|pull)\b/i },
  // 2026-08-28 audit: non-native "the code, is it pushed already?" carries the same meaning
  // but with a leading noun clause before the verb — allow an optional comma-prefixed lead-in.
  { intent: 'system.chit_chat.git_status', pattern: /^(?:.*,\s*)?(?:did|have|has|had|was|were|is|are|do|does)\s+(?:i|we|you|my|it|the|this|that|everything|all|anything|nothing|any)\b.*\b(?:push(?:ed)?|commit(?:ted)?)\b/i },
  { intent: 'system.chit_chat.git_status', pattern: /,\s*(?:is|are|was|were|did|have|has)\s+(?:it|this|that|my|the).*pushed/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^what\s+is\s+the\s+repo\s+map\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^explain\s+the\s+repo\b/i },
  { intent: 'run_tests', pattern: /^\s*test\s*\??\s*$/i },
  { intent: 'system.chit_chat.yes_no', pattern: /^\s*y\s*\??\s*$/i },
  { intent: 'system.chit_chat.yes_no', pattern: /^\s*n\s*\??\s*$/i },
  // 2026-08-26 live crosscheck: "why isnt this working" fired the DEPLOY CONFIRM (git push) —
  // the weak NLP stage claimed deploy on a frustration question. Unspecified frustration/
  // why-question shapes pin to how_do_i, whose handler answers a troubleshooting reply for
  // them (it cannot know what "this" is, and says so) — never a canned cheer, never an
  // action. Deliberately limited to UNSPECIFIC subjects ("this/that/it/everything") so
  // "why is the server down" keeps its read-only dev_server_status probe and "why is my
  // push failing" falls to the fallback (safe) instead of the generic text.
  // 2026-08-28 audit: "ugh why isnt this working" and "this keeps failing" were missed —
  // leading filler (ugh/oh/well/hmm/so) and the keeps-failing phrasing are the same unspecified
  // frustration class. Prefix is optional and non-capturing so specific why-shapes stay below.
  { intent: 'system.chit_chat.how_do_i', pattern: /^(?:(?:ugh|oh|well|hmm|so|like|yeah|okay|ok)\s+)*(?:why\s+(?:is|isn'?t|isnt|are|aren'?t|arent|did|didn'?t|didnt|does|doesn'?t|doesnt|do|don'?t|dont|was|were|won'?t|wont|can'?t|cant|has|have|had|couldn'?t|couldnt|wouldn'?t|wouldnt)\s+(?:this|that|it|everything|nothing|anything|the\s+thing)\b|what\s+(?:went\s+wrong|happened|is\s+wrong)|(?:whats|what's)\s+wrong|this\s+is\s+broken|it'?s\s+broken|nothing\s+works|i\s+give\s+up|just\s+fix\s+it|fix\s+it\s+already|this\s+keeps\s+failing|it\s+keeps\s+failing|this\s+is\s+annoying|it'?s\s+annoying|so\s+frustrating)/i },
  // "why is the server down"-shaped questions answer from a read-only URL probe, never from
  // the stack/overview or an action (live 2026-08-26: the why-frustration pin deliberately
  // leaves specific nouns alone, and the semantic stage drifted this one to stack).
  { intent: 'project.context.dev_server_status', pattern: /^why\s+is\s+(?:the\s+)?(?:server|site|app|api|backend)\s+(?:down|not\s+running|not\s+working|offline)\b/i },
  // 2026-08-26 live batch crosscheck: bare "run tests" (no article) fell below the semantic
  // floor and dead-ended on the fallback (which offered "run tests" as a chip) — the short
  // form is the one a hurried user actually types. The pin is exact-phrase narrow so
  // project-specific test entries ("run api tests" on a project with its own config entry)
  // keep winning their own triggers.
  { intent: 'run_tests', pattern: /^run\s+tests?$/i },
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
  // Phase T (2026-08-14): "open X.html in the browser" / "preview the page" shapes — a plain
  // HTML file's purpose is rendering, so an open/preview ask with a .html mention or an
  // explicit browser/preview intent must reach the browser, never the editor. These rules must
  // sit BEFORE the open_file rule below: that rule's filename pattern matches .html files too
  // and would otherwise send "open index.html" to VS Code. Exclusions keep the other open
  // actions' territory (github page / vs code / cursor / editor / explorer / folder / site).
  // Split in three because a verb-position "preview" cannot satisfy a trailing browser lookahead:
  //  (a) open-family verb + a .html filename mention — the filename alone is the discriminator;
  //  (b) preview/view verb + a page/html noun — the verb itself carries the browser intent;
  //  (c) open/show/launch + page/html noun + an explicit browser mention;
  //  (d) any open/view verb + ANY filename mention + an explicit browser mention — "open
  //      report.pdf in the browser" / "view main.py in the browser": the OS default browser
  //      handles the file via its association (HTML renders; other types open/download).
  { intent: 'project.action.open_html', pattern: /^(?:open|open\s+up|open\s+me|preview|view|show|launch)\b(?!(?:.*\b(?:explorer|folder|directory|site|website|url|link|github|editor|vs\s*c?ode|cursor|tools|panel)\b))(?=[\s\S]*\b[\w./-]+\.html\b)/i },
  { intent: 'project.action.open_html', pattern: /^(?:preview|view)\b(?!(?:.*\b(?:explorer|folder|directory|site|website|url|link|github|editor|vs\s*c?ode|cursor|tools|panel)\b))(?=[\s\S]*\b(?:page|html\b)\b)/i },
  { intent: 'project.action.open_html', pattern: /^(?:open|open\s+up|open\s+me|show|launch)\b(?!(?:.*\b(?:explorer|folder|directory|site|website|url|link|github|editor|vs\s*c?ode|cursor|tools|panel)\b))(?=[\s\S]*\b(?:html\s+files?|the\s+page|a\s+page|this\s+page)\b)(?=[\s\S]*\b(?:browser)\b)/i },
  { intent: 'project.action.open_html', pattern: /^(?:open|open\s+up|open\s+me|preview|view|show|launch)\b(?!(?:.*\b(?:explorer|folder|directory|site|website|url|link|github|editor|vs\s*c?ode|cursor|tools|panel)\b))(?=[\s\S]*\b[\w./-]+\.[a-zA-Z0-9]{1,10}\b)(?=[\s\S]*\bbrowser\b)/i },
  // Phase T: an explicit editor mention in an open ask must keep its editor route — the new
  // open_html examples pull "open X.html in vs code" toward the browser by embedding, so the
  // mention is pinned back to its editor owner (narrow: requires the vs-code/cursor token).
  // Split per editor so "open the project in cursor" keeps open_in_cursor (pinned together it
  // drifted to open_in_vscode — the vscode intent owns "vs code" tokens but must not own cursor).
  { intent: 'project.action.open_in_vscode', pattern: /^(?:open|open\s+up|open\s+me)\b(?=[\s\S]*\b(?:vs\s*c?ode|vscode)\b)/i },
  { intent: 'project.action.open_in_cursor', pattern: /^(?:open|open\s+up|open\s+me)\b(?=[\s\S]*\bcursor\b)/i },
  // Phase T2 (2026-08-14): "open X with <Editor>" / "open X in <Editor>" → open_with, and
  // "open X in the folder" / "show X in explorer" → reveal_file. Both need a filename token
  // (open_with additionally an editor name after with/in), and both sit BEFORE the open_file
  // rule below (whose filename pattern would otherwise claim the .ext mention). Guards keep
  // the pre-existing owners: "open the folder" (open_in_explorer), "open the github page",
  // vs-code/cursor/editor mentions, and the browser shapes (open_html rules above already
  // won those). The editor-name capture is deliberately loose (a-z0-9 spaces +._-).
  { intent: 'project.action.open_with', pattern: /^(?:open|open\s+up|open\s+me|launch)\b(?!(?:.*\b(?:explorer|folder|directory|site|website|url|link|github|vs\s*c?ode|vscode|cursor|browser|preview)\b))(?=[\s\S]*\b[\w./-]+\.[a-zA-Z0-9]{1,10}\b)(?=[\s\S]*\b(?:with|in)\s+(?:the\s+)?(?:default\s+)?[a-z][a-z0-9 .+_-]*\s*$)/i },
  { intent: 'project.action.reveal_file', pattern: /^(?:open|open\s+up|open\s+me|show|reveal|locate)\b(?!(?:.*\b(?:github|vs\s*c?ode|vscode|cursor|browser|editor)\b))(?=[\s\S]*\b[\w./-]+\.[a-zA-Z0-9]{1,10}\b)(?=[\s\S]*\b(?:in\s+the\s+folder|in\s+file\s+explorer|in\s+explorer)\b)/i },
  { intent: 'backup.create', pattern: /^backup\s+(?:this\s+|the\s+|my\s+)?(?:project|folder)\b/i },
  { intent: 'backup.create', pattern: /^create\s+a\s+backup\b/i },
  { intent: 'backup.create', pattern: /\bzip\s+this\s+project\b/i },
  // Phase 8 follow-up (2026-08-24): "rename X to Y" / "move X into Y" where X is a FILE-shaped
  // token (a bare "file" noun or an extension-bearing name). Probed live: the embedding stage
  // routes those correctly, but abstract nouns drift ("rename the site to production" → deploy,
  // "rename the project to netpulse" → a config ENTRY whose action would actually RUN). The
  // extension/\"file\"-noun shapes are unambiguous file operations; abstract-noun senses stay
  // embedding-driven by design. Narrow, file-bearing only.
  { intent: 'general.files.rename', pattern: /^rename\s+(?:the\s+)?(?:file\b|[\w./-]+\.[a-zA-Z0-9]{1,10}\b)\s+(?:to|as)\s+/i },
  { intent: 'general.files.move', pattern: /^move\s+(?:the\s+)?(?:file\b|[\w./-]+\.[a-zA-Z0-9]{1,10}\b)\s+into\s+/i },
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
  { intent: 'project.action.open_file', pattern: /^(?:open|open\s+up|open\s+me)\b(?!(?:.*\b(?:explorer|folder|directory|site|website|url|link|github|editor|browser|tools|vs\s*c?ode|cursor)\b)).*\b(?:files?|readme|[\w./-]+\.[a-zA-Z0-9]{1,10})\b/i },
  // Confirmed live (Phase 5, 2026-08-10, matcher probe): "serve the site on port 3040" fell
  // out of the embedding stage entirely (match: null) and landed on system.chit_chat.deploy
  // via a later stage — a bare "serve the site[ on port N]" never means deploy, it means
  // run the dev server on that port. Deliberately narrow: requires the literal serve verb
  // AND the site noun, optional port suffix only.
  { intent: 'npm_run', pattern: /^serve\s+the\s+site(?:\s+(?:on|at|using)\s+port\s+\d{2,5})?$/i },
  // Phase 1.5 (2026-08-11, probe-verified with real embeddings): "run the calculation"
  // previously drifted onto system.chit_chat.calculate on this machine (documented in
  // CLAUDE.md as pre-existing) — the new open_calculator opener's examples ("open the
  // calculator") share the "calculat" root so tightly that the input began routing there
  // instead, silently moving a documented drift target. "run the calculation" IS a
  // calculation request, never a request to open the calculator panel — literal override
  // restores the baseline. Deliberately the exact literal shape, nothing looser.
  { intent: 'system.chit_chat.calculate', pattern: /^run\s+(?:the\s+|this\s+)?calculation$/i },
  // Phase 3 (2026-08-11, probe-verified live): "merge alpha.pdf and beta.pdf into
  // combined.pdf" routed to system.chit_chat.deploy — the git/deploy example clusters own
  // every "merge ... into ..." shape and the .pdf filenames carry no embedding weight
  // against them. A pdf operation verb + a pdf mention (.pdf extension, the word pdf, or
  // pdf file(s)) is unambiguous in this app's domain — git never names pdf files, and the
  // PDF toolkit is the only consumer of these shapes. Verb-to-intent mapping: merge/combine/
  // join → pdf.merge; split → pdf.split; extract with page(s) → pdf.extract_pages, with
  // text → pdf.extract_text; watermark/stamp → pdf.watermark. Lookaheads keep each rule
  // anchored on both the verb AND the pdf mention, in any order.
  { intent: 'pdf.merge', pattern: /\b(?:merge|combine|join)\b(?=[\s\S]*\b(?:pdfs?|pdf\s+files?|[\w.-]+\.pdf)\b)/i },
  { intent: 'pdf.split', pattern: /\bsplit\b(?=[\s\S]*\b(?:pdfs?|pdf\s+files?|[\w.-]+\.pdf)\b)/i },
  { intent: 'pdf.extract_pages', pattern: /\bextract\b(?=[\s\S]*\b(?:pdfs?|pdf\s+files?|[\w.-]+\.pdf)\b)(?=[\s\S]*\bpages?\b)/i },
  { intent: 'pdf.extract_text', pattern: /\bextract\b(?=[\s\S]*\b(?:pdfs?|pdf\s+files?|[\w.-]+\.pdf)\b)(?=[\s\S]*\btext\b)/i },
  { intent: 'pdf.watermark', pattern: /\b(?:watermark|stamp)\b(?=[\s\S]*\b(?:pdfs?|pdf\s+files?|[\w.-]+\.pdf)\b)/i },
  // Phase 4 (2026-08-12, probe-verified with real embeddings): "remind me about the meeting"
  // drifted onto project.context.structure ("about the meeting" reads like a project
  // overview ask) and "remind me what time it is" drifted onto chit-chat status — the
  // "remind me" prefix carries the intent, but the trailing nouns hijack the vector. A
  // leading "remind me" is unambiguous in this app's domain — it is always a reminder
  // request, and the create handler asks for the when/what it's missing. Deliberately
  // anchored to the start; "set a reminder" shapes verified routing correctly without it.
  // 2026-08-28 audit: "set a reminder for tomorrow" (generic, no time) still drifted to
  // tech_preview — the "set a reminder" + time-word prefix is the same unambiguous class.
  { intent: 'system.reminders.create', pattern: /^remind\s+me\b/i },
  { intent: 'system.reminders.create', pattern: /^set\s+a\s+reminder\b/i },
  // Phase 2 catch-up (2026-08-12, probe-verified): "open file tools" / "open the file
  // tools" is unambiguous in this app's domain — it opens the File Tools panel. Without
  // this override the open_file literal rule below catches "file" and routes to
  // project.action.open_file (which asks "Which file?"). Placed BEFORE the open_file rule.
  { intent: 'system.tools.open_file_tools', pattern: /^open\s+(?:the\s+)?file\s+tools(?:\s+panel)?$/i },
  // 2026-08-28 audit: "open folder explorer" / "open file explorer" had no dedicated intent
  // and fell to open_in_explorer (the project folder). The explorer panel is a first-class
  // Tools surface with its own opener — same class as the file-tools pin above. Must sit
  // before the open_in_explorer territory.
  { intent: 'system.tools.open_folder_explorer', pattern: /^open\s+(?:the\s+)?(?:folder|file)\s+explorer(?:\s+panel)?$/i },
  { intent: 'system.tools.open_folder_explorer', pattern: /^browse\s+(?:a\s+)?folders?$/i },
  // Phase 2 audit (2026-08-12, probe-verified): the File Tools panel's move-preview table
  // sends "tidy this folder: <explicit file list>" — the colon + filenames after the verb
  // dominate the vector and the input drifts onto project.context.structure. A leading
  // "tidy this folder" is unambiguous.
  { intent: 'general.files.tidy', pattern: /^tidy\s+this\s+folder(?:\s+by\s+(?:date|year|month))?(?:\s*:\s*[\w.,\s/-]+)?$/i },
  // Same class for the duplicates delete list-filter the panel sends
  // ("delete duplicates, keep newest: <files>").
  { intent: 'general.files.duplicates_delete', pattern: /^delete\s+duplicates?,\s*keep\s+newest(?:\s*:\s*[\w.,\s/-]+)?$/i },
  // Phase 14 (2026-08-12, probe-verified): "extract the zip file" drifted onto backup.create
  // ("export this project as a zip") — the archive-file "extract" ask is a file_count query,
  // never a request to create a backup. Same class of pin as the pdf-verb rules: an
  // extract-verb + archive-file mention is unambiguous.
  { intent: 'project.context.file_count', pattern: /\bextract\b(?=[\s\S]*\b(?:zip|archive|rar|7z|tar|gz)\s*(?:file|folder)?\b)/i },
  // Phase 5 (2026-08-12, probe-verified): "note: <free text>" with arbitrary words scores
  // low in the embedding stage because the trailing nouns dominate the vector — same trap
  // as the "remind me" override. A leading "note:" / "add a note:" / "write a note:" /
  // "jot down:" prefix is unambiguous — it is always a note-creation request.
  // 2026-08-28 audit: "add a note about login bug" (no colon) and similar task-phrased notes
  // dominate the vector with the topic noun and drift to tech_preview. The about-phrasing is
  // the same unambiguous note-create class — no colon needed when the verb + note noun is present.
  { intent: 'system.notes.create', pattern: /^(?:note|add\s+a\s+note|write\s+a\s+note|jot\s+down)\s*:/i },
  { intent: 'system.notes.create', pattern: /^(?:add|create|make|write)\s+a\s+note\s+(?:about|on|for)\s+\S/i },
  // Same class of trap for note SEARCH: "search my notes for <free text>" — the query
  // terms after "for/about/with" dominate the vector. The prefix is unambiguous.
  { intent: 'system.notes.search', pattern: /^(?:search|find)\s+(?:my\s+)?notes?\s+(?:for|about|with)\s+\S/i },
  // Typo tolerance (2026-08-28 audit): the most common typo/mangled forms of high-traffic
  // intents that repeatedly drifted onto the wrong cluster in the live audit. The embedding
  // stage treats a 1-2 char typo as a different token and the fuzzy stage's floor (0.55) is
  // tuned for longer phrases, so short typo tokens slip through to the wrong semantic winner
  // (e.g. "stauts" -> metrics, "bulid" -> help). Pinning the common typos directly keeps the
  // user's intent instead of a confident wrong answer. Keep narrow — only the top typo forms
  // that actually appeared in the audit, not a generic typo dictionary.
  { intent: 'system.chit_chat.git_status', pattern: /\b(?:stauts|staus|statu|git\s+stauts|chek\s+status|chekc\s+status)\b/i },
  { intent: 'npm_build', pattern: /\b(?:bulid|biuld|buil\s+the\s+project|buil)\b/i },
  { intent: 'git_push', pattern: /\b(?:psuh|git\s+psuh|pish\s+push|psuh)\b/i },
  { intent: 'npm_install', pattern: /\b(?:instal|isntall|install\s+dependancies|install\s+depedencies)\b/i },
  { intent: 'run_tests', pattern: /\b(?:runtests|runtest|run\s+tets|run\s+tst)\b/i },
  { intent: 'system.chit_chat.ack', pattern: /^\s*hmm\s*$/i },
  // Audit 2026-08-28 Part A v2 — additional typo/ bare-token pins found in the 598-variation pass
  { intent: 'git_push', pattern: /^\s*push\s*\??\s*$/i },
  { intent: 'git_push', pattern: /^\s*push\?\s*$/i },
  { intent: 'git_commit', pattern: /\bcommittt+\b/i },
  { intent: 'git_branch', pattern: /\bbrnaches\b/i },
  { intent: 'git_branch', pattern: /\bbrnach\b/i },
  { intent: 'git_push', pattern: /\bpus\s+h\b/i },
  { intent: 'git_commit', pattern: /\bcommmit\b/i },
  { intent: 'npm_build', pattern: /\bbild\b/i },
  // "do i need to push/pull" is the git_ahead_behind diagnostic, not git_status — the git_status
  // pin's broad "did|do i ... push" would otherwise steal it (driver showed "do i need to push"
  // -> git_status). Pin ahead_behind explicitly before the git_status stage can claim it.
  { intent: 'git_ahead_behind', pattern: /\b(?:do|does|should|did)\s+(?:i|we)\s+need\s+to\s+(?:push|pull)\b/i },
  { intent: 'git_ahead_behind', pattern: /\bneed\s+to\s+(?:push|pull)\b/i },
  // Frustration extended — "i am frustrated", "im so frustrated", "this is driving me crazy", etc.
  // The main how_do_i frustration pin only covers why/this/that/ugh shapes; standalone frustrated
  // statements were falling to tech_preview/help/overview.
  { intent: 'system.chit_chat.how_do_i', pattern: /\b(?:i\s+am|i'?m|im)\s+(?:so\s+)?frustrated\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /\bthis\s+is\s+driving\s+me\s+crazy\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /\bwhy\s+does\s+nothing\s+work\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /\bwhy\s+can'?t\s+this\s+just\s+work\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /\bim\s+stuck\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /\bim\s+annoyed\b/i },
  // Offline / data privacy — "am i offline", "does this work offline", "is my data private",
  // "where is my data stored" all drifted to tech_preview/identity/file_find.
  { intent: 'system.chit_chat.how_do_i', pattern: /^\s*am\s+i\s+offline\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /\bdoes\s+this\s+work\s+offline\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^is\s+my\s+data\s+private\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^where\s+is\s+my\s+data\s+stored\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /\bam\s+i\s+offline\b/i },
  // Settings with optional "current" — "what is my current permission mode" failed because the
  // existing pin required "my permission mode" adjacent. Allow an optional adjective and the
  // inverted "what permission mode am i in" shape.
  { intent: 'system.chit_chat.how_do_i', pattern: /^what(?:'s|s| is)\s+my\s+(?:current\s+)?(?:permission\s+mode|theme|clipboard|accent)/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^what\s+permission\s+mode\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^what\s+accent\s+color\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /\bpermission\s+mode\s+am\s+i\s+in\b/i },
  // Navigation — specific "where/how do i ..." UI questions that were routing to git/project
  // actions instead of the how_do_i catalog (which guides to the UI). Keep each pin narrow.
  { intent: 'system.chit_chat.how_do_i', pattern: /^where\s+do\s+i\s+find\s+my\s+saved\s+notes\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+do\s+i\s+get\s+to\s+(?:the\s+)?settings\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+do\s+i\s+see\s+what\s+happened\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+do\s+i\s+open\s+(?:the\s+)?terminal\s+view\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^show\s+history\s*$/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^where\s+is\s+my\s+chat\s+history\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^where\s+is\s+my\s+chat\s+history\??\s*$/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+do\s+i\s+find\s+settings\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+do\s+i\s+go\s+to\s+dashboard\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+do\s+i\s+see\s+recent\s+actions\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^where\s+is\s+the\s+history\s+tab\b/i },
  { intent: 'system.chit_chat.how_do_i', pattern: /^how\s+do\s+i\s+see\s+my\s+old\s+chats\b/i },
  // Coverage — "how much coverage do we have" drifted to status; pin to diagnostics
  { intent: 'project.diagnostics.test_coverage_report', pattern: /\bhow\s+much\s+coverage\b/i },
  { intent: 'project.diagnostics.test_coverage_report', pattern: /\bcoverage\s+do\s+we\s+have\b/i },
  // Platform Finder — "reveal in Finder" without filename is a folder open, not file reveal;
  // the file reveal intent requires a filename token, so folder reveal correctly goes to
  // open_in_explorer. Pin the folder-reveal shape explicitly.
  { intent: 'project.action.open_in_explorer', pattern: /^(?:reveal|show)\s+in\s+(?:Finder|Explorer)\s*$/i },
  { intent: 'project.action.open_in_explorer', pattern: /^reveal\s+in\s+Finder\s*$/i },
  // Phase 6 (2026-08-12): the expanded calculator grammar — "convert 5 km to miles" /
  // "15% of 80" / "18% tip on 64.50" / "add 8.25% tax to 120". The percent sign and unit
  // words carry little embedding weight, so these shapes drift off the calculate cluster;
  // a leading convert/how-many verb + a number, or any percent phrase, is unambiguous.
  { intent: 'system.chit_chat.calculate', pattern: /^(?:convert|how\s+many)\s+[\d.]+\s+[a-z]+\s+(?:to|in|into)\b/i },
  { intent: 'system.chit_chat.calculate', pattern: /[\d.]+%\s+(?:of|tip|tax|gratuity|vat)\b/i },
  // Symbol-operator arithmetic ("calculate 12 + 8" / "what is 12*7"): the + - * / symbols
  // carry no embedding weight, so the expression falls out of the calculate cluster and
  // lands in the generic fallback. A leading calculate/what-is phrase + any number is
  // unambiguous — always arithmetic. Deliberately does NOT anchor on the numbers, which are
  // free-form.
  { intent: 'system.chit_chat.calculate', pattern: /^(?:calculate|whats|what's|what\s+is|compute|calc)\b.*\d/ },
  // Phase 16 (2026-08-12, probe-verified): "search my documents for <free text>" — the query
  // terms after "for/about" dominate the vector and the input drifts onto file_find/notes.
  // The search-documents prefix is unambiguous (same class of trap as the notes.search pin).
  { intent: 'project.knowledge.ask_documents', pattern: /^(?:search|find)\s+(?:my|the|all)\s+(?:documents?|pdfs?)\s+(?:for|about)\s+\S/i },
  { intent: 'project.knowledge.ask_documents', pattern: /^what\s+(?:did|do)\s+i\s+write\s+about\s+\S/i },
  // Phase 7 (2026-08-12, probe-verified): the fixed CSV grammar — "sum column X in Y.csv" /
  // "filter Y.csv where ..." — has a .csv extension token and a where-clause with free-form
  // values; both carry no embedding weight. A leading verb + .csv mention is unambiguous.
  { intent: 'csv.sum', pattern: /^(?:sum|add up|total)\s+(?:the\s+)?(?:column\s+)?[\w ]+?\s+(?:in|from|of)\s+[\w.-]+\.csv\b/i },
  { intent: 'csv.average', pattern: /^(?:average|mean|avg)\s+(?:the\s+)?(?:column\s+)?[\w ]+?\s+(?:in|from|of)\s+[\w.-]+\.csv\b/i },
  { intent: 'csv.filter', pattern: /^(?:filter|show rows in|show rows from)\s+[\w.-]+\.csv\s+where\s+\S/i },
  { intent: 'csv.count', pattern: /^(?:count rows in|count rows from|how many rows in)\s+[\w.-]+\.csv\s+where\s+\S/i },
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
