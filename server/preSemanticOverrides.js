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
  { intent: 'system.reminders.create', pattern: /^remind\s+me\b/i },
  // Phase 2 catch-up (2026-08-12, probe-verified): "open file tools" / "open the file
  // tools" is unambiguous in this app's domain — it opens the File Tools panel. Without
  // this override the open_file literal rule below catches "file" and routes to
  // project.action.open_file (which asks "Which file?"). Placed BEFORE the open_file rule.
  { intent: 'system.tools.open_file_tools', pattern: /^open\s+(?:the\s+)?file\s+tools(?:\s+panel)?$/i },
  // Phase 14 (2026-08-12, probe-verified): "extract the zip file" drifted onto backup.create
  // ("export this project as a zip") — the archive-file "extract" ask is a file_count query,
  // never a request to create a backup. Same class of pin as the pdf-verb rules: an
  // extract-verb + archive-file mention is unambiguous.
  { intent: 'project.context.file_count', pattern: /\bextract\b(?=[\s\S]*\b(?:zip|archive|rar|7z|tar|gz)\s*(?:file|folder)?\b)/i },
  // Phase 5 (2026-08-12, probe-verified): "note: <free text>" with arbitrary words scores
  // low in the embedding stage because the trailing nouns dominate the vector — same trap
  // as the "remind me" override. A leading "note:" / "add a note:" / "write a note:" /
  // "jot down:" prefix is unambiguous — it is always a note-creation request.
  { intent: 'system.notes.create', pattern: /^(?:note|add\s+a\s+note|write\s+a\s+note|jot\s+down)\s*:/i },
  // Same class of trap for note SEARCH: "search my notes for <free text>" — the query
  // terms after "for/about/with" dominate the vector. The prefix is unambiguous.
  { intent: 'system.notes.search', pattern: /^(?:search|find)\s+(?:my\s+)?notes?\s+(?:for|about|with)\s+\S/i },
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
