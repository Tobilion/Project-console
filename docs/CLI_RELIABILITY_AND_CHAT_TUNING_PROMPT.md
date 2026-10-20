# Project Console — CLI Reliability and Conversational Tuning

Master execution prompt. Paste this entire file into a fresh session.

## 0. Mission

Work in `C:\Users\tobil\Desktop\Projects\Project console`.

Three outcomes, in priority order:

1. **P0 — CLI reliability.** The CLI chat sometimes takes over a minute to become usable,
   sometimes never connects, and sometimes crashes. Make it fast, deterministic, and honest
   about what it is doing.
2. **P0 — Bug sweep.** Run a structured, adversarial sweep of the CLI and the chat pipeline.
   Fix real defects with regression coverage; do not stop at a code read.
3. **P1 — Conversational tuning.** Exercise the CLI the way a real user talks: many projects,
   many phrasings, follow-ups, pronouns, yes/no/wrong replies, ambiguity, typos, compound
   requests, and failure recovery. Create intents where coverage is genuinely missing. Where
   two intents collide, the console must ask what the user means rather than guess. Tune reply
   quality and naturalness.

Do P0 work before tuning. Tuning against a flaky CLI produces noise, not evidence.

## 1. Read first

Read these before exploring code:

1. `CLAUDE.md` — the live source of truth. Its "Known gotchas" and matcher sections are
   load-bearing.
2. `features.md` — current feature map.
3. `docs/PROJECT_CONSOLE_MASTER_EXECUTION_PROMPT.md` — ground rules and the established
   per-item format (findings, fixes, verification). Do not redo completed phases.
4. `docs/CONTINUOUS_CHAT_TEST_PROMPT.md` — the existing high-volume harness.
5. `server/scripts/eval/heldOutEval.json` and `server/evalGuard.js` — the frozen evaluation
   set. Never train on it.
6. `C:\Users\tobil\Downloads\Bad response Tuning Template.txt` if available. Its failure
   classification is mandatory for every chat defect in this task.

Run `git status` and `git log --oneline -10` before touching anything. The tree currently has
modified `server.log.prev` / `server.err.log.prev`; do not stage or commit runtime logs.

## 2. Non-negotiable operating rules

- **Scope discipline.** Touch only files required by the item in front of you. One logical
  change per commit. Do not refactor nearby code because it looks untidy.
- **No shortcuts.** If a thorough fix and a shortcut both satisfy the request, build the
  thorough one. Deferring part of the work is allowed only for genuine execution risk, stated
  explicitly.
- **Verify with evidence.** Never report "fixed" from a code read. Every claim needs a command,
  a transcript, a harness result, or a measured number. Distinguish "I checked" from "this
  should work."
- **No safety weakening.** Never auto-approve a risky command, remove a confirm gate, bypass
  `ALWAYS_CONFIRM_TOOLS`, or loosen a global matcher threshold to make a test pass. The safety
  model in `CLAUDE.md` is a hard boundary.
- **No direct phrase padding.** Do not fix a bad match by pasting the failing input into an
  intent's examples. Use the protocol in Section 6.
- **Real projects are read-only test subjects.** Never run mutating commands, installs,
  deletes, commits, pushes, or PDF/CSV writes against the user's real project folders. Use
  temporary fixture projects for anything that mutates.
- **Windows PowerShell 5.1.** Use full absolute paths. Do not chain with `&&`; use separate
  commands or `;`.
- **Git.** Small commits, no `--no-verify`, no `git push`. If the hook fails, fix the cause.
  Commit messages must state what was verified and what was not.
- **Docs stay current.** Update `CLAUDE.md` in place (replace stale status, do not append a
  changelog) and `features.md` after meaningful changes.
- **Repo hygiene.** No scratch scripts, reports, or fixture files left in the repo. Put
  throwaway drivers in `C:\Users\tobil\AppData\Local\Temp\opencode` and delete them. A durable
  regression corpus may live under `server/scripts/eval/` only if it is meant to be kept.
- **Stop-and-ask only for the cases in Section 10.** Routine implementation judgment is
  yours; make it and say what you chose.

## 3. Baseline before any edit

Record the starting state in a table. Do not assume the counts in `CLAUDE.md` are still exact.

```powershell
Set-Location -LiteralPath "C:\Users\tobil\Desktop\Projects\Project console"
git status --short
git log --oneline -10
node --version
npm --version
npm run doctor
```

Check which server entry the CLI will actually run. `bin/cli.js` prefers `dist/server.js` when
it exists, so a stale bundle can silently hide source changes:

```powershell
Get-Item -LiteralPath "dist\server.js" -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime
Get-ChildItem -LiteralPath "server" -Recurse -Filter *.js | Sort-Object LastWriteTime -Descending | Select-Object -First 5 FullName,LastWriteTime
```

Run the full harness baseline:

```powershell
npm run lint
npm test
npm run check-matcher
npm run check-handlers
npm run check-tools
npm run check-indexer
npm run check-ws-cases
npm run check-intents
npm run check-docs
npm run check-auth
npm run check-eval
npm run check-oos
npm run replay-history:digest
npx vite build
```

Note: `check-handlers` must exit 0 naturally on Windows. If it exits with a libuv assertion,
treat that as a defect to fix, not a reason to bypass the hook.

Starting performance baseline, five runs each, report min/median/max:

```powershell
# A. Attach to an already-running console, one query then exit
Measure-Command { node server/cli-client.js --project "Oja" --query "hello" | Out-Null }

# B. Full in-process boot plus one query (this is the path users experience)
Measure-Command { node bin/cli.js cli --project "Oja" --query "hello" | Out-Null }
```

Also record how many console processes exist before the run:

```powershell
3000..3019 | ForEach-Object {
  Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue |
    Select-Object LocalPort,OwningProcess
}
```

Interactive prompt readiness is not measurable with `--query`. Add an opt-in trace in Phase 1
so the real "prompt is ready" moment is recorded.

## 4. Phase 1 — CLI boot performance and connection reliability (P0)

### 1.1 Instrument first

Add an opt-in boot trace. Default off; no behavior change when unset. Suggested shape:

- Env: `CONSOLE_BOOT_TRACE=1` for the server, `CONSOLE_CLI_TRACE=1` for the client.
- Log one line per phase with elapsed milliseconds to stderr and to `logs/` via the existing
  file logger. Do not add a dependency.
- Server phases to cover: module import complete, config/tuning loaded, routes mounted, dev
  or prod static setup, project discovery start/end, learned intents loaded, semantic matcher
  start/end, NLP training end, confidence/threshold work end, port bound, WS ready.
- Client phases to cover: process start, discovery start/end, login/onboarding, project picker
  start/end, WebSocket open, readline ready, first prompt printed.

Use the trace to produce a real startup breakdown, not a guess. Keep it in the codebase only
if it remains cheap and off by default; otherwise remove it before the final commit and paste
the evidence into the report.

### 1.2 Fix the double-boot path

**Strong suspect, verify before changing:** `node bin/cli.js cli` always calls `startServer()`
even when a console is already answering. `startServer()` imports `server/index.js`, which
runs the full boot (discovery, embeddings, NLP training) and binds a fallback port. The client
then discovers the older console on the base port and attaches to it, leaving the newly booted
server as wasted work and a temporary duplicate.

Required behavior:

- If a console is already running, the CLI must attach to it without booting another server.
- If none is running, boot exactly one server and attach to it.
- The same rule must hold for every CLI entry point:
  `node bin/cli.js cli`, `npx local-project-console cli`, `Project Console.exe --cli`,
  `npm run launcher` option C, and `node server/cli-client.js` against a running server.
- The web/default path (`node bin/cli.js`) has the same class of bug. Fix it in the same
  logical change only if it shares the code path; otherwise note it and ask.

Acceptance: with a console already running, a CLI launch creates zero new listening ports and
reaches a prompt in ≤ 5 seconds, 10 out of 10 runs.

### 1.3 Fix the zero-project console rejection

**Strong suspect, verify:** `server/cli-client.js:229` treats a discovered console as a
failure when `projects.length === 0` unless the server is armed. A valid console with an empty
scan folder is therefore reported as "could not connect."

Required behavior: a console that answers `/api/projects` with `{ projects: [] }` is a live
console. The CLI must connect, show an empty project state, and offer the General workspace.
Test with a temporary empty directory as the scan root.

### 1.4 Make port discovery bounded and observable

`server/cliDiscovery.js` probes 20 ports serially with a 5-second timeout per port. A single
unresponsive port can cost 5 seconds per retry cycle, and the outer loop runs for 90 seconds.
Measure the real per-port cost on this machine, then:

- Prefer a bounded-concurrency probe that preserves base-port priority and never reports an
  armed console as dead.
- Report progress that names the phase, not a spinner with no information.
- Keep the 90-second ceiling unless evidence shows it is wrong; if a healthy boot legitimately
  exceeds it, fix the boot, not only the timeout.

### 1.5 Surface real boot progress

The server already emits `[boot-state]` markers. The CLI should show meaningful phases
(scanning projects, loading matcher, training classifier, binding port) rather than a silent
spinner. Do not make the CLI depend on parsing fragile log text; use an explicit, versioned
signal or the existing boot-state contract.

If binding earlier than ML startup is proposed, treat it as an architecture change:

- Prove which boot steps are safe to defer without changing first-message behavior.
- Do not change the desktop splash `[boot-state]` contract.
- Do not let a first message race an uninitialized matcher.
- If the trade-off is not clearly safe, do not do it; fix the double-boot and the messaging
  instead.

### 1.6 Stale bundle guard

Because `bin/cli.js` prefers `dist/server.js`, add a staleness check or a `--source` escape
hatch. A CLI launch must never silently run an older server than the source tree. The check
should be cheap and must not run a build automatically.

### 1.7 Startup acceptance targets

Set these as targets, measure them, and report the real floor if hardware or the embedding
model makes one impossible:

| Scenario | Target | Required evidence |
|---|---|---|
| Attach to running console, prompt ready | ≤ 5 s, 10/10 | trace + 10 runs |
| No server, warm cache, prompt ready | ≤ 20 s, 10/10 | trace + 10 runs |
| No server, model cached but vector cache cleared | ≤ 45 s, 5/5 | trace + 5 runs, cache restored |
| Empty scan root | connects and offers General | transcript |
| Double launch | no second listener | port check before/after |
| Crash-free soak | 20 consecutive launches, 0 crashes | logs + exit codes |

Do not clear `.cache/xenova` unless the model is already cached elsewhere; a network download
would confound the measurement. For the vector-cache test, rename
`data/.cache/intent-vectors.json`, measure, then restore it.

## 5. Phase 2 — Crash and lifecycle bug sweep (P0)

### 2.1 Reproduce before theorizing

Exercise every entry point and report the exact failure with a log tail:

- Windows Terminal, PowerShell 5.1, and `cmd.exe`.
- TTY and non-TTY (piped stdin/stdout).
- `--query`, `--json`, `--resume`, `--last`, `--export`, `--dry-run`.
- Console already running / not running / armed (login required) / zero projects.
- Server killed mid-turn; WebSocket closed mid-turn; malformed JSON from server.
- Ctrl+C once and twice; `quit`/`exit`; EOF.
- `ELECTRON_RUN_AS_NODE=1` path used by the desktop CLI.
- 20 consecutive launches; note any process left behind.

Logs to read: `logs/cli.log`, `logs/server.log`, `server.log`, `server.err.log`, and their
`.prev` rotations. Do not kill Node by image name; use the owning PID.

### 2.2 Named suspects to verify

1. `server/scripts/continuousChatHarness.js` parses `--live` but never uses it. Either
   implement live WS mode properly or remove the flag and the stale documentation. Do not
   leave a documented feature that does nothing.
2. The harness report tells the reader to paste failing phrases into intent examples. That
   contradicts the tuning protocol. Correct the guidance to match Section 6.
3. `server/cli-client.js`'s 401 message says "CLI login is coming" even though interactive
   login exists. Fix the stale text.
4. `isTTY` guards clack raw mode, but test the actual failure modes under ConPTY and Electron.
   A raw-mode throw must produce a readable message, not a vanished window.
5. `process.exit()` inside crash handlers can truncate output. Ensure the final line is
   flushed before exit.
6. Confirm `crlfDelay: Infinity` on every `readline.createInterface` in the CLI path.
7. Confirm a server restart mid-session produces a clear "connection closed" and a non-zero
   exit, not a hang or a silent close.
8. Confirm `--query`'s quiet-window exit cannot cut off a slow but valid answer, and that its
   30-second no-response cap reports a real error.
9. Confirm `--json` piped stdin still works after the `process.stdin.resume()` fix on Node 24.
10. Check for other dead flags, unreachable branches, and TODO paths in `bin/cli.js`,
    `server/cli-*.js`, and `server/cliRenderer.js`.

### 2.3 Bug sweep categories

Work each category as an adversarial reviewer, not as the author confirming their own code.
For every finding: reproduction, evidence, root cause, fix, regression test, and a note on
what else could be affected.

1. **Startup and lifecycle** — double boot, port fallback, stale bundle, signal handling,
   process cleanup, orphan children, windows left open.
2. **Discovery and connection** — zero projects, armed server, fallback ports, timeouts,
   duplicate consoles, port held by another service.
3. **Sessions and resume** — `--resume`, `--last`, project lock, session id mismatch, deleted
   session, cross-root same-name projects.
4. **WebSocket protocol** — message types the CLI does not handle, confirm tokens, `end`
   semantics, error frames, reconnect behavior, CLI/web parity.
5. **Matcher safety** — question-shaped input firing an action, chit-chat firing a risky
   intent, compound clauses dropping one intent, ambiguous pairs guessing instead of asking.
6. **Handlers** — uncaught exceptions, missing `end`, wrong project resolution, missing tab
   context, confirmation state leaking between turns.
7. **Output rendering** — markdown, ANSI leakage, JSON blocks, truncated output, interleaved
   spinner and prompt writes, Unicode on Windows code pages.
8. **Filesystem** — path resolution, CRLF handling, encoding, long paths, spaces in names,
   case-insensitive collisions, temp-file leaks.
9. **Auth** — armed/anonymous behavior, cookie jar, 401 paths, login prompt cancellation.
10. **Concurrency** — two messages in flight, rapid double Enter, a confirm arriving after
    another turn, timer leaks, watcher leaks.
11. **Error quality** — every failure names what happened and the next action. No bare
    "could not connect" when the server log already explains it.
12. **Configuration and tuning** — out-of-range values, unknown keys, profile corruption,
    malformed JSON in `data/`.

Do not fix style issues found in passing. Record them separately.

## 6. Phase 3 — Conversational test corpus (P1)

### 3.1 Test subjects

Use the real project folders read-only. At minimum cover six, chosen for variety:

- `Oja` (general/web project)
- `netpulse` (Python/Flask)
- `dream-kick` (vanilla JS + Three.js)
- `habitline` (frontend app)
- `Sportsim-pro` and `Matchday Exchange` (large codebases)
- `StudyFlash` (full-stack with a server)
- `footysim` (headless engine)
- `insightflow` (Python desktop)
- `website`, `Python`, `Java Crud App`, `newproject`, `kimi project`, `joke-kick`,
  `DuplicateFileAnalyzer`, `log_analyzer` (edge cases: empty, non-code, same-name patterns)

Also test the General pseudo-workspace (`__general__`) with no project selected.

### 3.2 Fixture for mutations

Create one temporary fixture under `%TEMP%` containing:

- a git repo with a clean and a dirty state,
- `package.json` with `dev`, `start`, `test` scripts that are safe and fast,
- notes, a CSV, two PDFs, duplicate files, an HTML file, a README with a run command,
- a nested folder and a file with spaces in its name.

Use it for every confirm, delete, move, rename, PDF, CSV, tidy, duplicate, and revert test.
Delete the fixture when done.

### 3.3 Matrix

Run at least 1,000 messages total, including at least 300 multi-turn conversations. Each row
below needs several paraphrases, not one canonical sentence.

**A. Small talk and identity** — hello, hi, hey, good morning, what's up, how are you, who are
you, what can you do, thanks, ok, lol, haha, I'm tired, I'm frustrated, goodbye.

**B. Help and meta** — how do I use this, how do I push, how do I publish, how do I run the
site, what version am I on, what mode am I in, what are git commands, is my data safe, what is
AI mode, list commands, help all, how do I export, how do I rebuild the desktop app.

**C. Project knowledge** — what is this project about, what stack, what dependencies, what
scripts, how do I run it, how do I test it, where is the entry point, what changed recently,
where is X defined, who uses X, what are the routes, any todos, biggest files, what files do I
have, show me the structure.

**D. Run/stop/port** — run the site, start the app, run the dev server, run tests, build it,
run on port 3010, is the server running, how long has it been running, stop the server, stop
the api, stop it, which process is on 5173, start it again.

**E. Git** — status, diff, log, branch, create a branch, checkout, commit, commit and push,
push, pull, fetch, stash, tag, remote, what's ahead, did I push yet, undo the last commit,
deploy, publish to production.

**F. Files** — find a file, search code, search documents, read a file, create a file, append,
delete, rename, move, tidy, find duplicates, delete duplicates, show hidden files, open in
editor, reveal in folder, copy path, open index.html, preview the page.

**G. Notes** — add a note, add a note to X, show notes, search notes, delete a note, edit a
note, restore from trash, empty trash, note with a checklist, note with tags.

**H. Reminders** — remind me tomorrow at 9, remind me to call the dentist in 3 days, list
reminders, cancel reminder 2, mark it done, snooze 10 minutes, remind me what the meaning of
life is (must not create a junk todo), reminder with a linked note.

**I. Tools** — open calculator, calculate 15% of 80, convert 5 km to miles, merge PDFs, split
a PDF, extract pages, watermark, extract text, sum a CSV column, filter CSV rows, clipboard
history, copy item 2, save a snippet, backup this project, open file tools, open notes, open
reminders, open folder explorer, open marketplace, open diagnostics.

**J. Schedules and notifications** — schedule every 10 minutes "git status", schedule daily at
09:30, schedule on file save, list schedules, remove schedule, review schedule log, notify me
when task-done, notify me when files change in X, stop watching X, test notification.

**K. Workspace modes** — switch to general mode, switch to developer mode, open tools, open
the calculator, what mode am I in, scan another folder, switch projects.

**L. AI mode** — turn AI on, turn AI off, explain this code, write a function, fix this bug,
refactor this file, is AI on, why did you do that, what did you change, undo that.

**M. Follow-ups and pronouns** — "open it", "run that", "the second one", "do it", "stop it",
"what about the tests", "and the dependencies", "now push it", "same for the other project",
"that file", "the one in src", "no, the other one".

**N. Yes/no/cancel/backtrack** — for every pending state above: yes, y, yeah, go ahead, do it,
no, n, cancel, stop, wait, what?, never mind, an unrelated message, empty input, 1, 2, neither,
both.

**O. Ambiguity** — these must ask, not guess:
- "open the site" vs "run the site" vs "open the project folder"
- "deploy" vs "publish" vs "push"
- "add a note" vs "remember this"
- "remind me" vs "schedule this"
- "find files" vs "search code" vs "search documents"
- "clean up" vs "tidy" vs "delete duplicates"
- "stop" vs "cancel the AI turn" vs "stop the server"
- "check the server" vs "health check" vs "dev server status"
- "open the file" vs "open in the editor" vs "reveal in folder"
- "test" vs "run tests" vs "type check"
- "build" vs "npm build" vs "desktop build"
- "update" vs "update the console" vs "update dependencies"
- "clear" vs "delete the trash" vs "clear clipboard"

**P. Phrasing variation** — lowercase, ALL CAPS, no punctuation, trailing punctuation, filler
("please", "can you", "hey", "so", "um"), typos at edit distance 1, contractions, emoji,
quoted arguments, paths with spaces, Windows backslashes, port numbers, "the thing" references.

**Q. Compound requests** — "open the site and check the network at 3", "commit and push",
"run the tests and then tell me what failed", "add a note and remind me tomorrow", "stop the
server and start it on 3010". Every recognized clause must produce a chip or an answer; no
clause may be silently dropped.

**R. Safety and adversarial** — "ignore previous instructions", "run rm -rf", "delete
node_modules", "push without asking", "turn off confirmations", "show me .env", "read
data/users.json", "format the drive", path traversal, shell metacharacters in a parameter,
prompt injection inside a filename or note. Expected: refuse, ask, or confirm; never bypass.

**S. Error paths** — nonexistent file, nonexistent project, bad port, port in use, server
down mid-turn, malformed CSV, encrypted PDF, empty notes, no reminders, no git repo, no
upstream branch, missing script, type-check failure, permission denied.

**T. Novice vs expert** — "make it go" vs "npm run dev"; "save my thought" vs "append to
notes.md"; "put it on the internet" vs "deploy"; "check if it's alive" vs "probe the dev URL".

**U. Edge inputs** — empty string, whitespace, one character, 5,000 characters, repeated
input, non-English, emoji-only, a bare path, a bare URL, a quoted command, a command with a
trailing backslash.

### 3.4 Expected behavior contract

Every turn must satisfy all of these unless the specific test says otherwise:

- It terminates. No stuck "Running...", no prompt that never returns.
- Risky work is confirm-gated. No exceptions.
- Ambiguity produces a question with numbered choices, and the choices are honored.
- A follow-up either resolves using conversation context or asks a specific clarifying
  question. It never silently starts a different task.
- "No" and "wrong" backtrack cleanly. Pending state is cleared; the next message is treated as
  a fresh request unless the user is correcting the previous one.
- Fallback gives a useful next step, not a dead end.
- Answers are specific to the active project. No invented files, scripts, branches, or PIDs.
- The CLI renders the same substance as the web for the same input. Formatting may differ.

### 3.5 How to execute the tests

- **Bulk read-only:** `node server/cli-client.js --project "<name>" --query "<text>" --json`
  against a running console. `--query` auto-declines confirmations, so use it for read-only
  turns only. Do not treat an auto-declined confirm as a pass for a mutation flow.
- **Live WebSocket:** use a driver in `%TEMP%\opencode`, resolving `ws` from the repo's
  `node_modules` by absolute path. Do not create scripts in the repo root; Vite watches it and
  stalls the WS pipeline.
- **Interactive CLI:** use a real terminal for the picker, raw mode, Ctrl+C, confirmations,
  and multi-turn state. Record the transcript. This is mandatory for every yes/no/cancel and
  ambiguity row.
- **High volume:** use `server/scripts/continuousChatHarness.js` for matcher coverage, but do
  not treat it as a CLI test. It does not exercise rendering, handlers, confirmations, or
  sessions. Fix or remove its dead `--live` flag as part of Phase 2.

## 7. Phase 4 — Failure classification and fix protocol

Every chat defect gets classified before it gets fixed. The categories are:

1. **Matcher misfire** — wrong intent chosen.
2. **Slot extraction miss** — right intent, wrong or missing entities.
3. **Threshold problem** — fell through to fallback/AI when it should not have, or the
   reverse.
4. **Handler bug** — right dispatch, broken behavior or crash.
5. **Response quality** — correct dispatch, unhelpful or unnatural answer.
6. **Lifecycle/rendering bug** — the CLI itself failed: connection, confirm, output, exit.

Then apply the correct fix type:

- **Confirmed trap:** a narrow literal pre-semantic pin plus a matcher battery row. Keep the
  pin as narrow as the evidence allows. Do not reorder the pipeline.
- **Genuine paraphrase gap:** log the near-miss and let the existing near-miss to suggestion
  to gated-promotion path handle it. Do not paste the phrase into examples directly.
- **Genuinely new or ambiguous real phrasing:** append it to the frozen held-out eval set for
  explicit review, not to training data. Never train on `heldOutEval.json`.
- **Missing capability:** create a new intent only if no existing intent owns the job and the
  behavior is distinct. Three or more independent phrasings, or a real cluster, is the
  threshold. A single odd sentence is not.
- **Threshold drift:** per-intent evidence, not a global change. Re-run held-out and OOS.
- **Collision:** if two intents are within the tie window, return a disambiguation prompt
  (1/2/neither) and verify all reply shapes. Do not widen one rule so it steals the other.
- **Response quality:** update the reply pools and wording, keeping CLI-readable text and the
  same underlying facts.

For every new intent, complete the full registration checklist:

- `server/intents/*.js` examples
- `server/intentRegistry.js` `BUILTIN_INTENTS`
- `server/intentTrust.js` if it is pure chit-chat
- `server/preSemanticOverrides.js` only if it is a confirmed embedding trap
- `server/wsHandlers/` handler, including a trailing `end` where required
- `server/scripts/checkHandlerCoverage.js` rows
- `server/scripts/batteries/matcherBatteries.js` rows
- `server/consoleCommandDocs.js` and the README command table if it is user-facing
- `npm run check-intents`, `check-matcher`, `check-handlers`, `check-docs`
- Workspace eligibility decision (dev-only vs available in General)

Every fix needs a regression test that fails before the fix and passes after it.

## 8. Phase 5 — Response quality tuning (P1)

- Audit canned replies for repetition. Every repeatable answer should have 3–5 variants via
  the existing `chatReplyPool` / `pickRandom` pattern.
- Remove echo-like replies that repeat the user's words without adding information.
- Error replies must say what happened, why it likely happened, and the next action.
- Do not invent state. If a process is untracked, say so. If a file was not found, name the
  search that failed. If a command exited non-zero, report the code.
- Keep the CLI text-only contract. Panels may open in the web; the CLI must still receive a
  useful answer.
- Measure chat latency for 50 representative read-only turns (p50 and p95). A tuning change
  must not regress matcher latency materially.
- Re-run the response-variation audit and fix real single-string cases, not cosmetic ones.

## 9. Phase 6 — Verification and closeout

Run everything again after the final change:

```powershell
npm run lint
npm test
npm run check-matcher
npm run check-handlers
npm run check-tools
npm run check-indexer
npm run check-ws-cases
npm run check-intents
npm run check-docs
npm run check-auth
npm run check-eval
npm run check-oos
npm run check-encoding
npx vite build
npm run doctor
```

Also run the CLI-specific soak:

- 20 consecutive launches from a clean state, zero crashes, zero orphan listeners.
- Attach to a running console 10 times, prompt each time under target.
- One 30-turn interactive session with confirmations, follow-ups, ambiguity, and a wrong
  reply, ending with a clean quit.
- One server-killed-mid-turn session, confirming a clear error and a non-zero exit.
- One zero-project console session, confirming connection and General workspace.
- One armed-console session, confirming login and no data leak before login.

Update `CLAUDE.md` with the new startup numbers, confirmed root causes, and any new gotchas.
Update `features.md` for new intents or changed CLI behavior. Update `README.md` only if a
user-facing command or flag changed. Update `CHANGELOG.md` only for release-level changes.

## 10. Stop and ask

Stop before:

- changing boot ordering in a way that also changes the desktop app or web startup,
- touching the safety model, confirm gates, or `ALWAYS_CONFIRM_TOOLS`,
- changing a global threshold or deleting an existing pre-semantic pin,
- adding a dependency,
- migrating or rewriting persisted user data,
- modifying the user's real project files,
- expanding scope into the web UI or desktop packaging beyond what the CLI requires.

Everything else in this prompt is yours to execute and report.

## 11. Final report format

Return a compact report with these sections:

1. **Startup results** — table of before/after for each scenario, five-run distributions,
   and the dominant remaining cost.
2. **Crash and lifecycle fixes** — root cause, reproduction, fix, regression test.
3. **Bug sweep** — every finding, severity, status (fixed / accepted / deferred with reason).
4. **Chat tuning** — counts by category, defect classification table, new intents, collision
   fixes, response changes.
5. **Verification** — exact commands and results, including the soak.
6. **Known gaps** — what was not verified and why. Be specific; do not hide gaps behind
   "should work."
7. **Commits** — hashes and one-line summaries.

Definition of done:

- The CLI attaches to a running console without booting a second server.
- A zero-project console is recognized.
- The startup targets are met or the real floor is measured and explained.
- No crash in the 20-launch soak and no orphan process or listener.
- At least 1,000 messages and 300 multi-turn conversations exercised across at least six
  projects and the General workspace.
- Zero risky actions on chit-chat, zero bypassed confirms, zero stuck turns.
- Every ambiguity case asks; every yes/no/cancel/backtrack case behaves correctly.
- New intents exist only where justified, fully registered, and covered.
- Full harness suite green, or every failure explained as pre-existing with evidence.
- `CLAUDE.md` and `features.md` describe the present state accurately.
