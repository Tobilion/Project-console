/**
 * checkMatcherCoverage.js — committed regression harness for the intent-matching pipeline.
 *
 * Run:  npm run check-matcher
 * Probe: node server/scripts/checkMatcherCoverage.js --probe   (prints actual routing, no asserts)
 *
 * Uses REAL embeddings (Xenova/all-MiniLM-L6-v2, cached at .cache/xenova — offline, ~60-120s
 * cold model load). The batteries are self-asserting {input, expect} pairs baked from the
 * current verified behavior of the real modules — no temp baseline files, so a regression in
 * any split/refactor shows up as a hard FAIL instead of a diff. `--probe` is the calibrator:
 * when intents intentionally grow/change, re-probe, eyeball the deltas, then update EXPECT.
 *
 * Batteries (see CLAUDE.md for provenance):
 *  - CONTROL: spec §4.3 control battery in its CURRENT documented state (two accepted changes:
 *    'run the tests' -> run_tests [Phase 1], 'what is the link' -> dev_server_status [Phase 1]).
 *  - PHASE1/2/3, BASICS: per-phase intent batteries from the 2026-08-03 intent-expansion records.
 *  - MATCHDAY: the 2026-08-04 "run server"/"run its server" misroute regression set.
 *  - TRAPS: confirmed-live misclassification regressions (2026-07-28/29/30).
 *  - MUST_NOT_STEAL: adjacent intents that must NOT capture another intent's phrasings.
 *  - GARBAGE: out-of-distribution input must land on the fallback, never a confident intent.
 *
 * NOTE: 'stop server' / 'what is the dev url' have connection.js pre-checks in the live app and
 * never reach the matcher there — they are deliberately NOT in this harness (matcher-only).
 */
import { pathToFileURL } from 'url';

const PROBE = process.argv.includes('--probe');
const base = 'C:/Users/tobil/Desktop/Projects/Project console/server/';

const { semanticMatcher } = await import(pathToFileURL(base + 'semanticMatcher.js').href);
const { matchInput } = await import(pathToFileURL(base + 'matcher.js').href);

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
    name: 'CONTROL (spec §4.3, current state)',
    items: [
      ['run the site', 'BUILTIN=run_project'],
      ['run the server', 'BUILTIN=run_project'],
      ['run this project', 'BUILTIN=run_project'],
      ['run the numbers', 'BUILTIN=project.knowledge.commands'],
      ['run the calculation', 'BUILTIN=project.knowledge.commands'],
      ['run your idea', 'BUILTIN=run_project(closeSecond=project.knowledge.how_to_run)'],
      ['how do I run this', 'BUILTIN=project.knowledge.how_to_run'],
      ['run the site and watch at interval of 5 minutes', 'MULTI[builtin=run_project | entry=python main.py watch --interval {interval}]'],
      ['watch at interval of 5 minutes', 'ENTRY action=python main.py watch --interval {interval}'],
      ['run the network speed', 'ENTRY action=python main.py watch --interval {interval}'],
      ['run the tests', 'BUILTIN=run_tests'],
      ['check git status', 'BUILTIN=system.chit_chat.git_status'],
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
      // entry_point on real embeddings — pre-existing, not a regression. Fixing the
      // routing (example trimming/override) is a deliberate behavior change, not a
      // split-safety issue, so the harness records current behavior until that lands.
      ['find the file main.py', 'BUILTIN=project.context.entry_point'],
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
      // Calibrated quirk: quote-heavy "push ... with the comment \"bug fixes\"" lands on
      // todos (the 'bug fixes' tokens pull the embedding that way). Pre-existing, recorded
      // as-is — the deploy handler's comment parsing fix (2026-07-29) is about the handler,
      // not dispatch; a dispatch fix would be a deliberate PRE_SEMANTIC_OVERRIDES addition.
      ['push the site with the comment "bug fixes"', 'BUILTIN=project.context.todos(closeSecond=system.chit_chat.deploy)'],
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
      ['run the tests and show me the results', 'MULTI[builtin=run_tests | builtin=run_project]'],
    ],
  },
  {
    name: 'GARBAGE (must not land on a confident intent)',
    items: [
      ['please to running the site for me today', 'FALLBACK(didYouMean=run_project)'],
      ['Call it jimmyjagz.md with tex :- "', 'FALLBACK'],
      ['gibberish qxzqwplk zzz', 'FALLBACK'],
      ['asdfghjkl', 'FALLBACK'],
    ],
  },
  {
    // Stage-level dispatch coverage for matcher.js itself (Phase 7, 2026-08-04) — the
    // batteries above already route through matchInput(), but several branches had no
    // dedicated input: the stage-1b config-run-entry redirect positive path (winner
    // run_project/npm_run + bestProjectCommandEntry >= 0.55), trust-guard-blocked
    // chit-chat with a real-request-looking input landing on a non-chit-chat intent,
    // and didYouMean presence on no-match fallbacks (needs a didYouMean display in fmt).
    name: 'MATCHER-DISPATCH (matcher.js stage-level, Phase 7)',
    items: [
      // 1a — direct config-entry hits via semantic meta (project.action.*)
      ['run one measurement', 'ENTRY action=python main.py once'],
      ['export the data', 'ENTRY action=python main.py export'],
      ['watch network at interval', 'ENTRY action=python main.py watch --interval {interval}'],
      // 1a vs 1b config redirect — probe-calibrated pre-split (2026-08-04)
      ['start the flask server', 'ENTRY action=python main.py serve'],
      ['run the site please', 'BUILTIN=run_project'],
      ['start netpulse', 'ENTRY action=python main.py serve'],
      // Multi-intent with a config entry in the second half
      ['run the tests and watch network', 'MULTI[builtin=run_tests | entry=python main.py watch --interval {interval}]'],
      // Trust guards: filename/quote-bearing chit-chat must not land on the chit-chat intent
      ['thanks for the file report.pdf', 'FALLBACK(didYouMean=file_read)'],
      ['good job on fixing main.py', 'BUILTIN=file_find'],
      // didYouMean on no-match (input below floor but nearest >= 0.45)
      ['show me the status of everything', 'FALLBACK(didYouMean=system.chit_chat.status)'],
    ],
  },
];

await semanticMatcher.initialize();
await semanticMatcher.addProjectIntents([project]);

let total = 0, failed = 0;
for (const battery of BATTERIES) {
  console.log(`\n=== ${battery.name} ===`);
  for (const [input, expect] of battery.items) {
    const r = await matchInput(input, project, 0);
    const got = fmt(r);
    const ok = got === expect;
    total++;
    if (!ok) failed++;
    if (PROBE) console.log(`  ${JSON.stringify(input).padEnd(58)} -> ${got}`);
    else if (!ok) console.log(`  FAIL ${JSON.stringify(input)}\n    expected: ${expect}\n    got:      ${got}`);
  }
  if (!PROBE) console.log(`  (${battery.items.length} inputs)`);
}

if (PROBE) {
  console.log(`\nProbe complete — ${total} inputs routed. Bake the desired outputs into EXPECT.`);
  process.exit(0);
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
