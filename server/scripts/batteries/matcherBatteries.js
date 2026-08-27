import fs from 'fs';
import path from 'path';

// Shared regression batteries for the intent-matching pipeline. Imported by both the legacy
// check-matcher harness (server/scripts/checkMatcherCoverage.js) and the node:test suite
// (server/test/matcher.test.js) so there is exactly one source of truth for every case.
const ENTRIES = [
  { triggers: ['start flask server', 'run locally', 'start netpulse'], type: 'command', action: 'python main.py serve' },
  { triggers: ['run one measurement', 'run a single measurement', 'run once', 'run one cycle'], type: 'command', action: 'python main.py once' },
  { triggers: ['export data', 'export to csv', 'export the data'], type: 'command', action: 'python main.py export' },
  { triggers: ['seed demo data', 'load demo data', 'demo mode', 'fill with fake data'], type: 'command', action: 'python main.py demo' },
  { triggers: ['watch network', 'track network speed', 'monitor network', 'watch network at interval', 'run network speed test on a loop', 'keep checking the network'],
    type: 'command', action: 'python main.py watch --interval {interval}',
    params: [{ name: 'interval', prompt: 'What interval, in minutes? (e.g. 15)', pattern: '\\d+' }] },
  { triggers: ['run tests', 'test project'], type: 'command', action: 'python -m pytest' },
  { triggers: ['what is the app', 'describe project'], type: 'answer', response: 'An ISP performance tracker.' },
];

const project = {
  id: 'netpulse', name: 'NetPulse',
  path: 'C:/Users/tobil/Desktop/Projects/netpulse',
  config: { entries: ENTRIES },
  codebaseIndex: { languages: ['Python (8 files)'], entryPoints: ['main.py'],
    keyFiles: { 'requirements.txt': 'x' }, fileSample: ['main.py', 'requirements.txt'] },
  contextFiles: [], parsedKnowledge: {},
};

function fmt(r) {
  if (!r) return 'null';
  if (r.multi) return 'MULTI[' + r.multi.map(m => m.builtin ? `builtin=${m.builtin}` : `entry=${m.match?.action}`).join(' | ') + ']';
  if (r.match) return `ENTRY action=${r.match.action}`;
  if (r.builtin) return `BUILTIN=${r.builtin}` + (r.closeSecond ? `(closeSecond=${r.closeSecond.intent})` : '');
  if (r.disambiguate) return `DISAMBIGUATE=${JSON.stringify(r.disambiguate)}`;
  return 'FALLBACK' + (r.didYouMean ? `(didYouMean=${r.didYouMean.intent})` : '');
}

/** Current verified behavior of the real modules (calibrated 2026-08-04, Phase 5 commit 2). */
const BATTERIES = [
  {
    name: 'CONTROL (spec Â§4.3, current state)',
    items: [
      ['run the site', 'BUILTIN=run_project'],
      ['run the server', 'BUILTIN=run_project'],
      ['run this project', 'BUILTIN=run_project'],
      ['run the numbers', 'BUILTIN=project.knowledge.commands'],
      // Recalibrated 2026-08-18: the calculator builtin wins "run the calculation" (safe
// calculator with unit conversion was added to the offline toolset after this row
// was baked); project.knowledge.commands only sees "run the tests" phrasings now.
['run the calculation', 'BUILTIN=system.chit_chat.calculate'],
      ['run your idea', 'BUILTIN=run_project(closeSecond=project.knowledge.how_to_run)'],
      ['how do I run this', 'BUILTIN=project.knowledge.how_to_run'],
      ['run the site and watch at interval of 5 minutes', 'MULTI[builtin=run_project | entry=python main.py watch --interval {interval}]'],
      ['watch at interval of 5 minutes', 'ENTRY action=python main.py watch --interval {interval}'],
      ['run the network speed', 'ENTRY action=python main.py watch --interval {interval}'],
      ['run the tests', 'BUILTIN=run_tests'],
      // how_do_i's Phase 9 question-shape cluster ("how do you check git status" etc.) now sits
      // within did-you-mean chip margin of the bare imperative â€” winner unchanged, chip added.
      ['check git status', 'BUILTIN=system.chit_chat.git_status(closeSecond=system.chit_chat.how_do_i)'],
      ['help', 'BUILTIN=system.chit_chat.help'],
      ['overview', 'BUILTIN=project.knowledge.overview'],
      ['what is the link', 'BUILTIN=project.context.dev_server_status(closeSecond=project.action.open_site)'],
    ],
  },
  {
    name: 'PHASE1 (run_tests / dev_server_status / file_find)',
    items: [
      ['run pytest', 'BUILTIN=run_tests'],
      ['run the test suite', 'BUILTIN=run_tests'],
      ['tell me about the tests', 'BUILTIN=project.context.tests'],
      ['test coverage', 'BUILTIN=project.context.tests'],
      ['is the server running', 'BUILTIN=project.context.dev_server_status'],
      ['is the site live', 'BUILTIN=project.context.dev_server_status'],
      ['where is main.py', 'BUILTIN=file_find'],
      ['find the config file', 'BUILTIN=file_find'],
      // Quirk (calibrated): the exact spec seed 'find the file main.py' loses to
      // entry_point on real embeddings â€” pre-existing, not a regression. Fixing the
      // routing (example trimming/override) is a deliberate behavior change, not a
      // split-safety issue, so the harness records current behavior until that lands.
      ['find the file main.py', 'BUILTIN=project.context.entry_point'],
    ],
  },
  {
    name: 'PHASE1b (how_do_i guidance intent, 2026-08-10)',
    items: [
      ['how do i export this chat', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i schedule a command', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i change the theme', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i review my learning', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i install a pack', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how can i see the dashboard', 'BUILTIN=system.chit_chat.how_do_i'],
    ],
  },
  {
    name: 'PHASE2 (git_fetch / ahead_behind / tag / checkpoint / recent_activity)',
    items: [
      ['git fetch', 'BUILTIN=git_fetch'],
      ['fetch from origin', 'BUILTIN=git_fetch'],
      ['am i behind origin', 'BUILTIN=git_ahead_behind'],
      ['is my branch in sync with origin', 'BUILTIN=git_ahead_behind'],
      ['list tags', 'BUILTIN=git_tag'],
      ['create a tag called v1.0', 'BUILTIN=git_tag'],
      ['make a checkpoint', 'BUILTIN=project.workflow.checkpoint'],
      ['save my work as a checkpoint', 'BUILTIN=project.workflow.checkpoint'],
      ['what changed recently', 'BUILTIN=system.chit_chat.git_status'],
      ['what files changed recently', 'BUILTIN=project.context.recent_activity(closeSecond=system.chit_chat.git_status)'],
      ['what files did i touch recently', 'BUILTIN=project.context.recent_activity'],
    ],
  },
  {
    name: 'PHASE3 (needs_ai_mode / git_stash_list)',
    items: [
      ['turn on ai mode', 'BUILTIN=system.chit_chat.needs_ai_mode'],
      ['ask the ai', 'BUILTIN=system.chit_chat.needs_ai_mode'],
      ['list stashes', 'BUILTIN=git_stash_list'],
      ['show the stash', 'BUILTIN=git_stash_list'],
    ],
  },
  {
    name: 'BASICS (2026-08-03 phase: open/copy/remote/processes/session)',
    items: [
      ['open the project in vs code', 'BUILTIN=project.action.open_in_vscode'],
      ['open the project in explorer', 'BUILTIN=project.action.open_in_explorer'],
      ['open the site', 'BUILTIN=run_project'],
      ['copy the project path', 'BUILTIN=project.action.copy_path'],
      // Phase 16 (2026-08-05): the four new open-in actions. open_file's name-bearing shapes
      // route via the PRE_SEMANTIC_OVERRIDE (file_read/file_find own the read/locate clusters).
      ['open the project in cursor', 'BUILTIN=project.action.open_in_cursor'],
      ['open a terminal here', 'BUILTIN=project.action.open_in_terminal'],
      ['open the github page', 'BUILTIN=project.action.open_github_page'],
      ['open the config file', 'BUILTIN=project.action.open_file'],
      ['open a file', 'BUILTIN=project.action.open_file'],
      ['show git remotes', 'BUILTIN=git_remote_info'],
      ['show running processes', 'BUILTIN=project.context.running_processes'],
      // Calibrated: 'what session is this' routes to overview on real embeddings
      // (session_info's seeds win for other phrasings). Pre-existing, recorded as-is.
      ['what session is this', 'BUILTIN=project.knowledge.overview'],
    ],
  },
  {
    name: 'MATCHDAY regression (2026-08-04)',
    items: [
      ['run server', 'BUILTIN=run_project'],
      ['run its server', 'BUILTIN=run_project'],
      ['is the server running', 'BUILTIN=project.context.dev_server_status'],
      ['scan for servers', 'BUILTIN=project.context.scan_servers'],
      ['which servers are up', 'BUILTIN=project.context.scan_servers'],
    ],
  },
  {
    name: 'TRAPS (confirmed-live misclassifications)',
    items: [
      ['who uses connection.js', 'BUILTIN=project.context.file_relations'],
      ['which files import state.js', 'BUILTIN=project.context.file_relations'],
      ['initialize git', 'BUILTIN=git_init'],
      ['deploy to my git', 'BUILTIN=system.chit_chat.deploy'],
      ['add node_modules/ to gitignore', 'BUILTIN=git_ignore_add'],
      ['add a file', 'BUILTIN=file_create'],
      ['can you help me add a file', 'BUILTIN=file_create'],
      ['Can I attach the github link', 'BUILTIN=git_remote_add'],
      // Recalibrated 2026-08-25: this row drifted across machines (locally the 'bug fixes'
      // tokens pulled the embedding to todos; on the ubuntu CI runner the same phrase routed
      // to git_push). The drift is pinned by a PRE_SEMANTIC_OVERRIDES literal rule, so the
      // expectation is now machine-independent: git_push, with the comment parsed by the
      // handler's extractCommentMessage (the deploy handler's comment parsing fix (2026-07-29)
      // is about the handler, not dispatch).
      ['push the site with the comment "bug fixes"', 'BUILTIN=git_push'],
    ],
  },
  {
    name: 'MUST_NOT_STEAL (adjacent phrasings)',
    items: [
      ['open the project', 'BUILTIN=run_project'],
      ['push this code to github with comment "Massive Memory and Learning improvements"', 'BUILTIN=git_push'],
      // Live: 'stop it' with a TRACKED process is intercepted by connection.js's stop-server
      // pre-check before the matcher; with nothing tracked it falls through to the matcher
      // and lands on yes_no (its examples include 'stop'/'abort'). Harness = matcher-only,
      // so yes_no is the recorded baseline.
      ['stop it', 'BUILTIN=system.chit_chat.yes_no'],
      // Calibrated 2026-08-25: the multi-split is deterministic (stage 0) but its PARTS match
      // through the embedding stage — "show me the results" is a marginal run_project hit
      // (0.57 locally) that flipped to project.context.structure on the ubuntu CI runner,
      // collapsing the multi to a single intent. Both parts are now pinned by
      // PRE_SEMANTIC_OVERRIDES literal rules (each part passes through match() and hits them),
      // so this expectation is machine-independent.
      ['run the tests and show me the results', 'MULTI[builtin=run_tests | builtin=run_project]'],
    ],
  },
  {
    name: 'GARBAGE (must not land on a confident intent)',
    items: [
      // Still a fallback (no confident match) â€” only the chip target moved: how_to_run's Phase 9
      // site question cluster now owns the nearest intent for run-site-garbled input.
      ['please to running the site for me today', 'FALLBACK(didYouMean=project.knowledge.how_to_run)'],
      ['Call it jimmyjagz.md with tex :- "', 'FALLBACK'],
      ['gibberish qxzqwplk zzz', 'FALLBACK'],
      ['asdfghjkl', 'FALLBACK'],
    ],
  },
  {
    // Phase 0 (2026-08-10): the utility intents. Positive rows for each phrase family and one
    // garbled-input row that pins the PURE_CHITCHAT_INTENTS guard specifically against the new
    // canned replies (a garbage hit on "It's 4:32 PM" is the same failure mode as gratitude).
    name: 'PHASE0 (utility intents: time / date / calculate)',
    items: [
      ['what time is it', 'BUILTIN=system.chit_chat.time'],
      ['whats the time', 'BUILTIN=system.chit_chat.time'],
      ['what is the current time', 'BUILTIN=system.chit_chat.time'],
      ['whats the date', 'BUILTIN=system.chit_chat.date'],
      ['what day is it', 'BUILTIN=system.chit_chat.date'],
      ['what is today', 'BUILTIN=system.chit_chat.date'],
      ['what is 12 times 7', 'BUILTIN=system.chit_chat.calculate'],
      ['whats 340 divided by 4', 'BUILTIN=system.chit_chat.calculate'],
      ['calculate 12 + 8', 'BUILTIN=system.chit_chat.calculate'],
      ['calculate 12 + 8 * 3', 'BUILTIN=system.chit_chat.calculate'],
      ['asdf1234', 'FALLBACK'],
    ],
  },
  {
    // Phase 10 (2026-08-12): full-catalog command list â€” "list commands" / "help all" render
    // every consoleCommandDocs entry (CLI equivalent of the web Command Reference tab).
    // "list all commands"/"show all commands" still route to help (its compact summary is a
    // fine answer for those â€” both are command-list requests, no behavior loss).
    name: 'PHASE10 (command reference list)',
    items: [
      ['list commands', 'BUILTIN=system.chit_chat.list_commands'],
      ['help all', 'BUILTIN=system.chit_chat.list_commands'],
      ['list all commands', 'BUILTIN=system.chit_chat.help'],
      ['show all commands', 'BUILTIN=system.chit_chat.help'],
      ['help', 'BUILTIN=system.chit_chat.help'],
    ],
  },
  {
    // Phase 14 (2026-08-12): i18n scaffolding â€” German POC phrases ADD to English. These rows
    // only apply when the profile locale is 'de' (the locale merge is a no-op for 'en', and
    // the harness must stay machine-independent); the English shapes must keep matching even
    // with the locale active (additive, never replace).
    name: 'PHASE14 (i18n: de locale POC â€” active only when profile locale is de)',
    activeWhen: () => {
      try {
        const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'user-profile.json'), 'utf-8');
        return JSON.parse(raw)?.userProfile?.locale === 'de';
      } catch { return false; }
    },    items: [
      ['hallo', 'BUILTIN=system.chit_chat.greeting'],
      ['was ist 12 mal 7', 'BUILTIN=system.chit_chat.calculate'],
      ['hilfe', 'BUILTIN=system.chit_chat.help'],
      ['tschuess', 'BUILTIN=system.chit_chat.farewell'],
      ['hello', 'BUILTIN=system.chit_chat.greeting'],
      ['what is 12 times 7', 'BUILTIN=system.chit_chat.calculate'],
      ['help', 'BUILTIN=system.chit_chat.help'],
    ],
  },
  {
    // Phase 6 (2026-08-12): expanded calculator grammar â€” unit conversion + percentage/tax/tip
    // stay on the same calculate intent; the percent sign / unit words carry little embedding
    // weight, so these shapes are pinned by pre-semantic overrides.
    name: 'PHASE6 (expanded calculator: convert / percent / tip / tax)',
    items: [
      ['convert 5 km to miles', 'BUILTIN=system.chit_chat.calculate'],
      ['convert 2 liters to cups', 'BUILTIN=system.chit_chat.calculate'],
      ['convert 100 fahrenheit to celsius', 'BUILTIN=system.chit_chat.calculate'],
      ['how many cups in 2 liters', 'BUILTIN=system.chit_chat.calculate'],
      ['what is 15% of 80', 'BUILTIN=system.chit_chat.calculate'],
      ['whats 18% tip on 64.50', 'BUILTIN=system.chit_chat.calculate'],
      ['add 8.25% tax to 120', 'BUILTIN=system.chit_chat.calculate'],
      ['calculate 20% tip on 45', 'BUILTIN=system.chit_chat.calculate'],
    ],
  },
  {
    // Phase 1.5 (2026-08-11): chat openers for the shared interactive tool panels. Phrase
    // shapes are deliberately verb+noun only ("open/show" were rejected: "show me the tools"
    // near-dups "show me the todos", and generic "show me the results" inputs drifted). "open
    // the tools" also routes to the calculator opener (its panel is the first registered);
    // PDF merge/compress work belongs to Phase 3 and must NOT drift here yet.
    name: 'PHASE-1.5 (tool-panel openers: open calculator / open pdf tools)',
    items: [
      ['open calculator', 'BUILTIN=system.tools.open_calculator'],
      ['open the calculator', 'BUILTIN=system.tools.open_calculator'],
      ['open the tools', 'BUILTIN=system.tools.open_calculator'],
      ['open pdf tools', 'BUILTIN=system.tools.open_pdf_tools'],
      ['open the pdf tools', 'BUILTIN=system.tools.open_pdf_tools'],
      ['open file tools', 'BUILTIN=system.tools.open_file_tools'],
      ['open the file tools', 'BUILTIN=system.tools.open_file_tools'],
    ],
  },
  {
    // Stage-level dispatch coverage for matcher.js itself (Phase 7, 2026-08-04) â€” the
    // batteries above already route through matchInput(), but several branches had no
    // dedicated input: the stage-1b config-run-entry redirect positive path (winner
    // run_project/npm_run + bestProjectCommandEntry >= 0.55), trust-guard-blocked
    // chit-chat with a real-request-looking input landing on a non-chit-chat intent,
    // and didYouMean presence on no-match fallbacks (needs a didYouMean display in fmt).
    name: 'MATCHER-DISPATCH (matcher.js stage-level, Phase 7)',
    items: [
      // 1a â€” direct config-entry hits via semantic meta (project.action.*)
      ['run one measurement', 'ENTRY action=python main.py once'],
      ['export the data', 'ENTRY action=python main.py export'],
      ['watch network at interval', 'ENTRY action=python main.py watch --interval {interval}'],
      // 1a vs 1b config redirect â€” probe-calibrated pre-split (2026-08-04)
      ['start the flask server', 'ENTRY action=python main.py serve'],
      ['run the site please', 'BUILTIN=run_project'],
      ['start netpulse', 'ENTRY action=python main.py serve'],
      // Multi-intent with a config entry in the second half
      ['run the tests and watch network', 'MULTI[builtin=run_tests | entry=python main.py watch --interval {interval}]'],
      // Trust guards: filename/quote-bearing chit-chat must not land on the chit-chat intent.
      // Phase 1.5 (2026-08-11): the didYouMean target for the .pdf example moved from file_read
      // to system.tools.open_pdf_tools â€” the new opener's phrases own the "pdf" token, and a
      // pdf-named file suggesting the PDF-tools panel is the intended direction of the feature
      // (the row still pins the guard itself: FALLBACK, never chit-chat).
      ['thanks for the file report.pdf', 'FALLBACK(didYouMean=system.tools.open_pdf_tools)'],
      ['good job on fixing main.py', 'BUILTIN=file_find'],
      // didYouMean on no-match (input below floor but nearest >= 0.45)
      ['show me the status of everything', 'FALLBACK(didYouMean=system.chit_chat.status)'],
    ],
  },
  {
    // Phase 9 (2026-08-11, probe-calibrated with real embeddings): "how to / how do you /
    // command to / what is the command to" question shapes route to the how_do_i catalog
    // (which now answers with the real shell command + example phrases + a run chip), while
    // site/server-flavored run questions route to how_to_run (project-specific commands).
    // The guard rows pin the imperative launch family â€” after how_to_run gained
    // site/server-shaped question examples, bare "run the site" drifted onto how_to_run and
    // a PRE_SEMANTIC_OVERRIDE had to win it back for run_project (see preSemanticOverrides.js).
    name: 'HOWTO (Phase 9 question shapes + imperative guards)',
    items: [
      ['how do you push to github', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how to push to github', 'BUILTIN=system.chit_chat.how_do_i'],
      ['what is the command to push', 'BUILTIN=system.chit_chat.how_do_i'],
      ['command to push to github', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you check git status', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how to check git status', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you open this in vs code', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how to open this in vs code', 'BUILTIN=system.chit_chat.how_do_i'],
      ['what is the command to open in vs code', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how to run the tests', 'BUILTIN=system.chit_chat.how_do_i(closeSecond=project.context.tests)'],
      ['what is the command to run the tests', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you check the console health', 'BUILTIN=system.chit_chat.how_do_i'],
      ['command to check the console health', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you export this chat', 'BUILTIN=system.chit_chat.how_do_i'],
      ['what is the command to export this chat', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you schedule a command', 'BUILTIN=system.chit_chat.how_do_i'],
      ['what is the command to schedule a command', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you see the dashboard', 'BUILTIN=system.chit_chat.how_do_i'],
      ['command to see the dashboard', 'BUILTIN=system.chit_chat.how_do_i'],
      // Question-shape guard rows (probe-verified 2026-08-11): these all previously misfired onto
      // EXECUTING intents (deploy/run_project/npm_build/status) because the "how to"/"command to"
      // prefix carries no embedding weight â€” the PRE_SEMANTIC_OVERRIDES question rule above now
      // catches them before the semantic stage. Answer-only, never execute.
      ['how to push my changes', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you build the project', 'BUILTIN=system.chit_chat.how_do_i'],
      ['command to stop the server', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how to open in vs code', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you show history', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do you make a checkpoint', 'BUILTIN=system.chit_chat.how_do_i'],
      ['command to see test coverage', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how to deploy the site', 'BUILTIN=system.chit_chat.how_do_i'],
      // 2026-08-26 live crosscheck additions: the full question-helper set (can i), the
      // best-way phrasing, the `pus` typo, and the backup/note/remember/old-chat subjects all
      // fired EXECUTING intents or dead-ended live — each is now pinned to how_do_i.
      ['how can i push my code', 'BUILTIN=system.chit_chat.how_do_i'],
      ['whats the best way to push', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i pus', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i take a backup', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i make a note', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i remember things', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i open an old chat', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how to run the site', 'BUILTIN=project.knowledge.how_to_run'],
      ['how do i run the site', 'BUILTIN=project.knowledge.how_to_run'],
      ['how do you run the server', 'BUILTIN=project.knowledge.how_to_run'],
      ['how to start the site', 'BUILTIN=project.knowledge.how_to_run'],
      ['command to run the site', 'BUILTIN=project.knowledge.how_to_run'],
      ['what is the command to run the site', 'BUILTIN=project.knowledge.how_to_run'],
      ['how do i launch the site', 'BUILTIN=project.knowledge.how_to_run'],
      ['how to serve the site', 'BUILTIN=project.knowledge.how_to_run'],
      // imperative guards: the launch family stays EXECUTING (run_project), never informational
      ['run the site', 'BUILTIN=run_project'],
      ['run this project', 'BUILTIN=run_project'],
      ['run the project', 'BUILTIN=run_project'],
      ['start the site', 'BUILTIN=run_project'],
      ['start the app', 'BUILTIN=run_project'],
      ['launch the site', 'BUILTIN=run_project'],
      ['run the app', 'BUILTIN=run_project'],
      ['run the site on port 3010', 'BUILTIN=npm_run'],
      ['serve the site', 'BUILTIN=npm_run'],
      ['serve the site on port 3040', 'BUILTIN=npm_run'],
      ['run the tests', 'BUILTIN=run_tests'],
      // The fixture's own "run tests" entry wins at 0.71 â€” a project-specific test command beats
      // the generic builtin; without a matching entry this input routes to run_tests instead.
      ['run api tests', 'ENTRY action=python -m pytest'],
      ['run the numbers', 'BUILTIN=project.knowledge.commands'],
    ],
  },
  {
    // NetPulse crosscheck (2026-08-17): "How do I publish" fired the deploy git-push confirm â€”
    // deploy's example cluster owns publish-shaped phrases and "publish" was missing from the
    // question-shape override's verb list. Question shapes now pin to how_do_i (the catalog
    // answers push-to-github first, npm publish as the suggestion); the imperative guard row
    // keeps "publish to production" on deploy, where it belongs by design.
    name: 'PUBLISH-2026-08-17 (publish question shapes vs the deploy confirm)',
    items: [
      ['how do i publish', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i publish to npm', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how do i publish this', 'BUILTIN=system.chit_chat.how_do_i'],
      ['how to publish my changes', 'BUILTIN=system.chit_chat.how_do_i'],
      ['what is the command to publish', 'BUILTIN=system.chit_chat.how_do_i'],
      ['command to publish to npm', 'BUILTIN=system.chit_chat.how_do_i'],
      // imperative guard: publishing to production IS the deploy flow â€” checkpoint + git push
      ['publish to production', 'BUILTIN=system.chit_chat.deploy'],
    ],
  },
  {
    name: 'CODE-SEARCH (Phase 7 semantic code search intent)',
    items: [
      ['where do we handle retries', 'BUILTIN=project.code.search'],
      ['where is the retry logic', 'BUILTIN=project.code.search'],
      ['find code about error handling', 'BUILTIN=project.code.search'],
      ['search the codebase for auth', 'BUILTIN=project.code.search'],
      ['which file handles the websocket connections', 'BUILTIN=project.code.search'],
      ['where is the database code', 'BUILTIN=project.code.search'],
      // Name-shaped "where is X" must NOT leave file_find (locates by file NAME, different
      // contract â€” code.search is about code inside files).
      ['where is main.py', 'BUILTIN=file_find'],
    ],
  },
  {
    name: 'GENERAL-FILES (Phase 2 general-mode file tools)',
    items: [
      // Content-search shapes route to general.files.find â€” file_find is locate-by-name and
      // must not steal them ("search my files for X" names content, not a file).
      ['search my files for budget', 'BUILTIN=general.files.find'],
      ['search for rent in my files', 'BUILTIN=general.files.find'],
      ['find files matching invoice', 'BUILTIN=general.files.find'],
      ['find files containing tax', 'BUILTIN=general.files.find'],
      ['search all my files for expenses', 'BUILTIN=general.files.find'],
      ['find files with the word meeting', 'BUILTIN=general.files.find'],
      // Name-ish "find files named like X" also stays in general.files.find.
      ['find files named like report', 'BUILTIN=general.files.find'],
      // Guard: locate shapes stay with file_find.
      ['where is main.py', 'BUILTIN=file_find'],
      ['find the config file', 'BUILTIN=file_find'],
      // Tidy family.
      ['tidy this folder', 'BUILTIN=general.files.tidy'],
      ['organize this folder by type', 'BUILTIN=general.files.tidy'],
      ['organize my files by date', 'BUILTIN=general.files.tidy'],
      ['sort these files by type', 'BUILTIN=general.files.tidy'],
      // Phase 2 audit: the panel's move-preview table sends an explicit file list after a
      // colon â€” pinned by a pre-semantic override (the filenames dominate the vector).
      ['tidy this folder: pic.jpg', 'BUILTIN=general.files.tidy'],
      ['tidy this folder: pic.jpg, doc.pdf', 'BUILTIN=general.files.tidy'],
      // Duplicates: find vs delete must split cleanly.
      ['find duplicate files', 'BUILTIN=general.files.duplicates'],
      ['are there any duplicate files', 'BUILTIN=general.files.duplicates'],
      ['delete duplicate files', 'BUILTIN=general.files.duplicates_delete'],
      ['remove duplicates', 'BUILTIN=general.files.duplicates_delete'],
      ['delete duplicates keep newest', 'BUILTIN=general.files.duplicates_delete'],
      // Phase 2 audit: the panel's per-row checkbox subset.
      ['delete duplicates, keep newest: dup-b.txt', 'BUILTIN=general.files.duplicates_delete'],
      // Phase 8 follow-up (2026-08-24): rename + move — the Folder Explorer's in-place rename
      // and drag-and-drop move ride chat commands. The "rename X to Y" shape is pinned by a
      // pre-semantic override (deploy's "merge X into Y" cluster owns verb+into shapes, and
      // "rename ... to ..." drifted to file ops without it); move+into is embedding-driven and
      // verified not to collide with pdf.merge's override (no .pdf mention).
      ['rename main.py to app.py', 'BUILTIN=general.files.rename'],
      ['rename notes.txt as diary.txt', 'BUILTIN=general.files.rename'],
      ['rename this file to newname.txt', 'BUILTIN=general.files.rename'],
      ['move main.py into src', 'BUILTIN=general.files.move'],
      ['move report.pdf into documents', 'BUILTIN=general.files.move'],
      ['move the file into archive', 'BUILTIN=general.files.move'],
    ],
  },
  {
    // Phase 3 (2026-08-11): the .pdf-bearing merge/extract/watermark shapes are pinned by
    // PRE_SEMANTIC_OVERRIDES (preSemanticOverrides.js) â€” "merge alpha.pdf and beta.pdf into
    // combined.pdf" was confirmed live routing to system.chit_chat.deploy, whose example
    // clusters own every "merge ... into ..." shape. The override makes these rows
    // machine-independent; the no-pdf guard rows below stay embedding-driven by design.
    name: 'PDF (Phase 3 PDF toolkit intents)',
    items: [
      // Merge family â€” every shape lands on pdf.merge, not git_add/deploy.
      ['merge these pdfs into combined.pdf', 'BUILTIN=pdf.merge'],
      ['merge a.pdf and b.pdf into merged.pdf', 'BUILTIN=pdf.merge'],
      ['merge alpha.pdf and beta.pdf into combined.pdf', 'BUILTIN=pdf.merge'],
      ['merge the pdf files into one file', 'BUILTIN=pdf.merge'],
      ['merge pdfs', 'BUILTIN=pdf.merge'],
      ['combine the pdfs', 'BUILTIN=pdf.merge'],
      // Split family.
      ['split this pdf into one file per page', 'BUILTIN=pdf.split'],
      ['split report.pdf at page 5', 'BUILTIN=pdf.split'],
      ['split the pdf at page 3', 'BUILTIN=pdf.split'],
      ['split this pdf into single pages', 'BUILTIN=pdf.split'],
      // Extract-text family â€” .pdf-suffixed and pdf-noun shapes only; ".py"-suffixed inputs
      // stay away (verified: "extract text from main.py" routes to entry_point, not here).
      ['extract text from report.pdf', 'BUILTIN=pdf.extract_text'],
      ['extract the text from this pdf', 'BUILTIN=pdf.extract_text'],
      ['pull the text out of this pdf', 'BUILTIN=pdf.extract_text'],
      // Extract-pages family.
      ['extract pages 2-5 from report.pdf into excerpt.pdf', 'BUILTIN=pdf.extract_pages'],
      ['extract page 1 from the pdf into cover.pdf', 'BUILTIN=pdf.extract_pages'],
      ['extract a range of pages from the pdf into range.pdf', 'BUILTIN=pdf.extract_pages'],
      // Watermark family.
      ['watermark report.pdf with confidential', 'BUILTIN=pdf.watermark'],
      ['watermark the pdf with draft', 'BUILTIN=pdf.watermark'],
      ['add a watermark to this pdf', 'BUILTIN=pdf.watermark'],
      // Guards: non-PDF senses of the same verbs must not land on the toolkit (probe-verified
      // 2026-08-11). Name-less pdf-verb inputs routing here is fine â€” the handlers only act on
      // a resolved .pdf file and otherwise open the panel (Phase 1.5 convention).
      ['merge this branch into main', 'BUILTIN=project.context.entry_point'],
      ['merge my changes', 'BUILTIN=git_add'],
      ['extract the zip file', 'BUILTIN=project.context.file_count'],
      // Recalibrated 2026-08-18: "extract" + "archive" now scores higher on the file_count
// intent than the PDF-extract phrasing this row was baked against.
['extract the archive', 'BUILTIN=project.context.file_count'],
      ['split the window', 'BUILTIN=project.context.structure'],
      ['split the project into parts', 'BUILTIN=project.knowledge.architecture'],
    ],
  },
  {
    // Phase 4 (2026-08-12): personal reminders. The create shapes are embedding-driven (no
    // pre-semantic override â€” "remind me" is a distinctive verb, probe-verified); the list
    // and cancel shapes must not drift to the schedule admin tier (which is pre-matcher and
    // answers "schedule/list schedules/remove schedule" shapes directly, so no conflict).
    name: 'REMINDERS (Phase 4 reminder intents)',
    items: [
      ['remind me tomorrow at 9am to renew my license', 'BUILTIN=system.reminders.create'],
      ['remind me in 3 days to follow up', 'BUILTIN=system.reminders.create'],
      ['remind me every friday at 5pm to call the accountant', 'BUILTIN=system.reminders.create'],
      ['remind me daily at 9am to drink water', 'BUILTIN=system.reminders.create'],
      ['remind me to water the plants at 8pm', 'BUILTIN=system.reminders.create'],
      ['remind me at 7pm to take out the trash', 'BUILTIN=system.reminders.create'],
      ['remind me about the meeting', 'BUILTIN=system.reminders.create'],
      ['set a reminder for friday at 5pm to pay rent', 'BUILTIN=system.reminders.create'],
      ['set a reminder to call the dentist tomorrow at 10am', 'BUILTIN=system.reminders.create'],
      ['list my reminders', 'BUILTIN=system.reminders.list'],
      ['show my reminders', 'BUILTIN=system.reminders.list'],
      ['what reminders do i have', 'BUILTIN=system.reminders.list'],
      ['cancel reminder s1', 'BUILTIN=system.reminders.cancel'],
      ['delete reminder s3', 'BUILTIN=system.reminders.cancel'],
      ['remove reminder s2', 'BUILTIN=system.reminders.cancel'],
      // Phase 4 panel opener: these phrases must route to the opener so the web client
      // opens the Reminders panel (carried via openPanel on the answer, not tested here).
      ['open reminders', 'BUILTIN=system.tools.open_reminders'],
      ['open the reminders panel', 'BUILTIN=system.tools.open_reminders'],
      // Guards: the schedule-admin tier is pre-matcher (the live server answers
      // "schedule every 10 minutes ..." there, before the matcher ever sees it), so the
      // harness can only pin what the RAW matcher does with the bare command; the reminder
      // pin above keeps "remind me what time it is" on the create handler (which asks for
      // the when) instead of drifting to status, and plain "what time is it" keeps its
      // chit-chat route.
      ['schedule every 10 minutes "git status"', 'BUILTIN=system.chit_chat.git_status'],
      ['remind me what time it is', 'BUILTIN=system.reminders.create'], // create handler asks for a when
      ['what time is it', 'BUILTIN=system.chit_chat.time'],
    ],
  },
  {
    name: 'NOTES (Phase 5 note intents)',
    items: [
      ['note: buy milk', 'BUILTIN=system.notes.create'],
      ['add a note: remember the wifi password', 'BUILTIN=system.notes.create'],
      ['note: panel test 12345', 'BUILTIN=system.notes.create'],
      ['show my notes', 'BUILTIN=system.notes.list'],
      ['read my notes', 'BUILTIN=system.notes.list'],
      ['search my notes for wifi', 'BUILTIN=system.notes.search'],
      ['search my notes for panel test 54760', 'BUILTIN=system.notes.search'],
      ['find my notes about the trip', 'BUILTIN=system.notes.search'],
      ['open notes', 'BUILTIN=system.tools.open_notes'],
      ['open the notes panel', 'BUILTIN=system.tools.open_notes'],
    ],
  },
  {
    name: 'CSV (Phase 7 spreadsheet intents)',
    items: [
      ['sum column sales in data.csv', 'BUILTIN=csv.sum'],
      ['sum the total column in expenses.csv', 'BUILTIN=csv.sum'],
      ['average column price in data.csv', 'BUILTIN=csv.average'],
      ['count rows in data.csv where status equals done', 'BUILTIN=csv.count'],
      ['filter data.csv where price greater than 50', 'BUILTIN=csv.filter'],
      ['filter sales.csv where region equals west', 'BUILTIN=csv.filter'],
      ['open spreadsheet', 'BUILTIN=system.tools.open_csv_tools'],
      ['open the csv tools', 'BUILTIN=system.tools.open_csv_tools'],
    ],
  },
  {
    name: 'CLIPBOARD (Phase 8 clipboard + snippet intents)',
    items: [
      ['show clipboard history', 'BUILTIN=clipboard.show'],
      ['clipboard history', 'BUILTIN=clipboard.show'],
      ['copy clipboard item 2', 'BUILTIN=clipboard.copy_item'],
      ['clear clipboard history', 'BUILTIN=clipboard.clear'],
      ['remove clipboard item 2', 'BUILTIN=clipboard.remove_item'],
      ['delete clipboard item 1', 'BUILTIN=clipboard.remove_item'],
      ['save this as a snippet: welcome', 'BUILTIN=snippet.save'],
      ['show my snippets', 'BUILTIN=snippet.show'],
      ['copy snippet welcome', 'BUILTIN=snippet.copy'],
      ['delete snippet welcome', 'BUILTIN=snippet.delete'],
      ['open clipboard', 'BUILTIN=system.tools.open_clipboard'],
      ['open the clipboard panel', 'BUILTIN=system.tools.open_clipboard'],
    ],
  },
  {
    name: 'BACKUP (Phase 9 backup intents)',
    items: [
      ['backup this folder', 'BUILTIN=backup.create'],
      ['export this project as a zip', 'BUILTIN=backup.create'],
      ['list backups', 'BUILTIN=backup.list'],
      ['open backup', 'BUILTIN=system.tools.open_backup'],
      ['open the backup panel', 'BUILTIN=system.tools.open_backup'],
    ],
  },
  {
    name: 'NOTIFICATIONS (Phase 15 panel opener)',
    items: [
      ['open notifications', 'BUILTIN=system.tools.open_notifications'],
      ['open the notifications panel', 'BUILTIN=system.tools.open_notifications'],
    ],
  },
  {
    name: 'DOCUMENTS (Phase 16 knowledge-base intents)',
    items: [
      ['search my documents for pricing', 'BUILTIN=project.knowledge.ask_documents'],
      ['search my documents for quarterly goals', 'BUILTIN=project.knowledge.ask_documents'],
      ['search my documents for the trip', 'BUILTIN=project.knowledge.ask_documents'],
      ['what did i write about the budget', 'BUILTIN=project.knowledge.ask_documents'],
      ['search the pdfs for the contract terms', 'BUILTIN=project.knowledge.ask_documents'],
      ['open documents', 'BUILTIN=system.tools.open_documents'],
      ['open the knowledge base', 'BUILTIN=system.tools.open_documents'],
    ],
  },
  {
    name: 'MARKETPLACE (Phase 17 panel opener)',
    items: [
      ['open marketplace', 'BUILTIN=system.tools.open_marketplace'],
      ['open the pack marketplace', 'BUILTIN=system.tools.open_marketplace'],
    ],
  },
  {
    // Round-6 audit (2026-08-24): repo-map panel opener — the visual counterpart of the
    // whole-project symbol map the AI prompt receives. "show me the repo map" shapes could
    // drift onto the structure/knowledge cluster ("show me the todos"), so the opener's own
    // examples carry the "repo map" noun and the battery pins the routing.
    name: 'REPO-MAP (round-6 panel opener)',
    items: [
      ['open repo map', 'BUILTIN=system.tools.open_repo_map'],
      ['open the repo map', 'BUILTIN=system.tools.open_repo_map'],
      ['show the repo map', 'BUILTIN=system.tools.open_repo_map'],
      ['show me the repo map', 'BUILTIN=system.tools.open_repo_map'],
    ],
  },
  {
    // Matchday-Exchange live session (2026-08-14): "what is the site about" triggered the
    // deploy confirm (git push) and "what is the details of the site" landed on server status â€”
    // the "the site" token collision. The typo'd time questions drifted onto stack/git_status.
    // The pre-semantic overrides pin all five shapes; these rows make the regression visible.
    name: 'MATCHDAY-2026-08-14 (site-question + time-typo misroute set)',
    items: [
      ['what is the site about', 'BUILTIN=project.knowledge.overview'],
      ['What is the details of the site', 'BUILTIN=project.knowledge.overview'],
      ['what is the tme', 'BUILTIN=system.chit_chat.time'],
      ['what as time\\', 'BUILTIN=system.chit_chat.time'],
      ['what is the time', 'BUILTIN=system.chit_chat.time'],
      ['what files do i have', 'BUILTIN=project.context.structure'],
      ['list all my files', 'BUILTIN=project.context.structure'],
    ],
  },
  {
    // Phase T (2026-08-14): "open X.html in the browser" / "preview the page" â€” pinned by the
    // pre-semantic open_html override (the open_file rule's filename pattern would otherwise
    // send .html names to the editor). Guards: the editor/repo/site owners keep their shapes.
    name: 'HTML-OPEN (Phase T open-in-browser set)',
    items: [
      ['open index.html in the browser', 'BUILTIN=project.action.open_html'],
      ['open index.html', 'BUILTIN=project.action.open_html'],
      ['open the html file in the browser', 'BUILTIN=project.action.open_html'],
      ['preview the page', 'BUILTIN=project.action.open_html'],
      ['preview index.html', 'BUILTIN=project.action.open_html'],
      ['open the page in the browser', 'BUILTIN=project.action.open_html'],
      ['show the html file in the browser', 'BUILTIN=project.action.open_html'],
      ['view the html file', 'BUILTIN=project.action.open_html'],
      // Any file type with an explicit browser mention opens in the browser (rule d) â€” the
      // OS association handles HTML (renders) and other types (open/download).
      ['open report.pdf in the browser', 'BUILTIN=project.action.open_html'],
      ['view main.py in the browser', 'BUILTIN=project.action.open_html'],
      ['show app.ts in the browser', 'BUILTIN=project.action.open_html'],
      // Guards: explicit editor/repo/site shapes stay with their owners; no-browser file
      // opens default to the editor.
      ['open index.html in vs code', 'BUILTIN=project.action.open_in_vscode'],
      ['open main.py', 'BUILTIN=project.action.open_file'],
      ['open the github page', 'BUILTIN=project.action.open_github_page'],
      ['open the dev site', 'BUILTIN=project.action.open_site'],
      ['open the folder', 'BUILTIN=project.action.open_in_explorer'],
      ['open a file', 'BUILTIN=project.action.open_file'],
    ],
  },
  {
    // Phase T2 (2026-08-14): open-with-IDE + reveal-in-folder shapes, pinned by pre-semantic
    // overrides (a filename + with/in <editor> is unambiguous; a filename + "in the folder"
    // means reveal, never edit). Guards: the editor/repo/site/folder owners keep their shapes.
    name: 'OPEN-WITH (Phase T2 open-with-IDE + reveal set)',
    items: [
      ['open main.py with pycharm', 'BUILTIN=project.action.open_with'],
      ['open main.py with PyCharm', 'BUILTIN=project.action.open_with'],
      ['open app.ts in intellij', 'BUILTIN=project.action.open_with'],
      ['open the config file in the editor', 'BUILTIN=project.action.open_with'],
      ['open file.py in the default editor', 'BUILTIN=project.action.open_with'],
      ['open report.pdf in webstorm', 'BUILTIN=project.action.open_with'],
      ['open main.py in the folder', 'BUILTIN=project.action.reveal_file'],
      ['show file.py in explorer', 'BUILTIN=project.action.reveal_file'],
      ['open the config file in the folder', 'BUILTIN=project.action.reveal_file'],
      // Guards: pre-existing owners keep their shapes.
      ['open the folder', 'BUILTIN=project.action.open_in_explorer'],
      ['open index.html in vs code', 'BUILTIN=project.action.open_in_vscode'],
      ['open the github page', 'BUILTIN=project.action.open_github_page'],
      ['open index.html in the browser', 'BUILTIN=project.action.open_html'],
      ['open the site', 'BUILTIN=run_project'],
    ],
  },
  {
    // Audit 2026-08-17: NLP-stage dispatch gate (isNlpBuiltinEligible). Unit rows â€” the full
    // pipeline rarely reaches the NLP stage (semantic wins first), so the gate is asserted
    // directly: registered canned intents pass unless the input looks like a real request;
    // knowledge intents fail on file-naming queries; STALE ids (removed from the registry)
    // and config-entry ids (project.action.N.M â€” resolved against config, never the registry)
    // are never eligible.
    name: 'NLP-GATE (isNlpBuiltinEligible â€” audit 2026-08-17)',
    unit: true,
    items: [
      ['system.chit_chat.gratitude', 'thanks a lot', true],
      ['system.chit_chat.gratitude', 'random garbage.txt', false],
      ['system.chit_chat.time', 'what is the time', true],
      ['stale.removed.intent', 'thanks a lot', false],
      ['project.knowledge.overview', 'what is the overview', true],
      ['project.knowledge.overview', 'what about main.py', false],
      ['project.action.0.1', 'run the dev script', false],
    ],
  },
];
export { project, fmt, BATTERIES };
