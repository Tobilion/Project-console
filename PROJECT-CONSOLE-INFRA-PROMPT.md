# Project Console — Infrastructure Expansion Prompt (hand to opencode / deepseek)

Paste this whole file as your instructions. Work through the phases **in order**, one at a time.
Do not start Phase N+1 until Phase N's verification checklist passes. If a phase turns out to be
too large for one pass, stop mid-phase at a clean, working checkpoint rather than leaving the
repo in a broken state.

## Repo context you must respect

This is `project-console` — a local, offline Express + WebSocket backend / React 19 + Vite
frontend that dispatches commands and runs an optional local-AI (Ollama) chat for a user's
project folders. Read `CLAUDE.md` at the repo root FIRST, in full, before writing any code — it
documents the actual current architecture, known gotchas, and hard conventions. Do not trust your
own assumptions about the codebase's shape over what CLAUDE.md says.

Non-negotiable conventions (all currently true, verify against CLAUDE.md if anything below seems
out of date):

- No file over ~400 lines; target ~150 for logic files. Split by concern into `server/wsHandlers/`
  style leaf modules with a thin orchestrator, matching the existing pattern.
- Handlers/tools take named-args objects, not positional args.
- `writeFile`/`editFile`/`insertAtLine`/`appendToFile` and any risky `executeCommand` require
  explicit user approval — never make anything in this codebase auto-approve a risky command or
  a file mutation. `ALWAYS_CONFIRM_TOOLS` (runTests, stopProcess) and `risky: true`
  `executeCommand` can NEVER be auto-approved by any mechanism, existing or new.
- New WS message types belong in both the server emitter AND
  `src/hooks/wsMessageCases.ts`/`wsStreamingCases.ts` — check whether you actually need a new
  message type before adding one; reusing the existing `answer`/`error_output` types (which
  render as a fresh chat bubble any time they're sent, no matching `end` required) avoids frontend
  changes for anything that's just "post a result later."
- Every new intent goes into the relevant `server/intents/*.js` phrase file AND
  `intentRegistry.js`'s `BUILTIN_INTENTS` Set AND gets a handler in the matching
  `server/wsHandlers/builtin*.js` leaf AND gets merged into `builtinIntents.js`'s dispatcher.
  Run `npm run check-handlers` and `npm run check-intents` after touching any of this.
- Run `npm run lint` (`tsc --noEmit`), `node --check` on every edited server `.js` file, and the
  relevant `check-*` script after every change. `.github/workflows/ci.yml` already runs
  `lint` + all `check-*` scripts on push/PR — treat that as the bar you must clear, not a
  suggestion.
- Professional code, not vibe-coded: comments explain *why*, not *what*; no dead code; no
  leftover scratch/spec files committed to the repo (this file you're reading right now is a
  hand-off prompt, not a deliverable — don't copy it into the repo).
- Update `CLAUDE.md` in place (replace stale info, don't append a changelog) after finishing each
  phase, describing what was actually built, in the same terse style as the rest of the file.
- The safety model is load-bearing. Read the "Safety model — don't weaken without discussing
  first" section of CLAUDE.md before Phase 3 (sandboxed executor) and Phase 2 (notifications) in
  particular — both touch trust boundaries.

Already built (do NOT rebuild — extend if a phase below genuinely needs to touch it, otherwise
leave it alone): `server/taskQueue.js` (in-memory per-project FIFO background task queue),
`.github/workflows/ci.yml`, `server/wsHandlers/connectionPackAdmin.js` +
`server/pluginTools.js` (local pack install for `console.tools.json`), `server/crossProjectMemory.js`
+ the `system.knowledge.cross_project_search` intent, the Dashboard's Projects/Live Sites tabs
and per-card action row (`src/components/Dashboard.tsx`, `/api/dashboard` in
`server/routes/monitoringRoutes.js`).

---

## Phase 0 — Quick wins (do these first, before Phase 1)

Both items below are small, low-risk, and independent of everything else in this document —
knock them out first for an early working checkpoint before touching the bigger phases.

### 0a. Chat export improvements

**Problem:** `useConsoleExports.ts`'s `exportAsMarkdown`/`exportAsJson` only export whatever the
browser tab currently has loaded in React state, and lose real information the server already
has on disk: no timestamps (each NDJSON entry in `conversationStore.js`'s `appendMessage` already
carries `timestamp`, it's just never passed to the client), and every non-user/error/warning
message type — `bot`, `system`, `output` — collapses into a single generic "Assistant" bucket in
the export, so a tool-call/tool-result/system notice looks identical to an actual AI answer once
exported.

**Build:**
1. Add `timestamp?: number` to the `TerminalMessage` interface (`src/types.ts`) and thread it
   through wherever messages are constructed client-side (`makeMessage` helper, WS message case
   handlers in `wsMessageCases.ts`/`wsStreamingCases.ts`) and wherever a reloaded session's
   messages are hydrated from the server. Server already has this data (`appendMessage`'s
   `entry.timestamp`) — check `GET /api/sessions/:id` in `sessionRoutes.js` to confirm it's
   actually returned to the client; if not, add it there rather than inventing a new endpoint.
2. Fix `exportAsMarkdown`/`exportAsJson` (`src/hooks/useConsoleExports.ts`) to: (a) include the
   timestamp per message (human-readable in markdown, ISO string in JSON), (b) label `system` and
   `output` message types distinctly instead of falling through to "Assistant" — markdown export
   should use their own `## System` / `## Output` headers, JSON export should use their own
   `role` values (`system`, `output`) instead of remapping to `assistant`.
3. Add a server-side export endpoint, e.g. `GET /api/sessions/:id/export?format=md|json`, that
   exports the COMPLETE persisted NDJSON history for a session (not just whatever the browser
   happens to have rendered) — reuse the same formatting logic as the client export where
   possible (a small shared formatter is fine, but don't fork the logic into two diverging
   implementations; if it's easiest, have the client export call this new endpoint instead of
   formatting from React state at all).
4. Add a "export whole project" option: either a new endpoint that zips/concatenates every
   session for a project, or — simplest — a direct download link for that project's existing
   `.console/chat-log.md` (already a complete human-readable transcript of every session in that
   project, written by `chatLog.js`; no new generation logic needed, just expose it for download).
5. Add a PDF export option alongside the existing Markdown/JSON buttons (client-side PDF
   generation from the same message data — check whether a PDF library is already a dependency
   before adding a new one).

**Verify:** exported markdown/JSON for a session with tool calls and system messages preserves
every distinct message type and its timestamp; the project-wide export actually contains every
session for that project, not just the currently active one; re-running an export twice on an
unchanged session produces identical output (no nondeterminism from ordering).

### 0b. Basic utility intents in chat ("what time is it", etc.)

**Problem:** there's no way to ask the console simple, universally-answerable questions —
current time, current date, day of the week, basic arithmetic — without either typing a shell
command or turning on AI mode for something that needs zero project context and zero model call.

**Build:**
1. New intent(s) in a fitting existing phrase file (`server/intents/chitChatIntents.js` is the
   right home — these are zero-argument, canned-shape answers, same family as `greeting`/`status`/
   `port`): `system.chit_chat.time` ("what time is it", "what's the date", "what day is it",
   "current time", "what's today's date" — cover both time and date under one intent, or split
   into `system.chit_chat.time` and `system.chit_chat.date` if the phrase corpus makes them
   collide with each other more than with anything else; check with `npm run check-intents`).
   Handler computes from `new Date()` server-side (document whether this uses server-local time or
   a configurable timezone — server-local is the simpler, correct-by-default choice for an
   offline single-user local tool).
2. Optional, only if time allows: a basic arithmetic intent (`system.chit_chat.calculate` —
   "what is 12 times 7", "what's 340 divided by 4") using a SAFE expression evaluator — never
   `eval()` or `new Function()` on user input. If a safe math-expression library is already a
   dependency, use it; otherwise a small hand-rolled parser limited to `+ - * / ( )` and numbers
   is enough — reject anything else outright rather than trying to be permissive.
3. Register in `intentRegistry.js`'s `BUILTIN_INTENTS` Set, add a handler in
   `server/wsHandlers/builtinChitChat.js`, and — this is the trap CLAUDE.md's matching-pipeline
   section calls out repeatedly — add the new intent(s) to `PURE_CHITCHAT_INTENTS`
   (`intentTrust.js`) since these are exactly the zero-argument canned-reply shape that
   `CHITCHAT_FLOOR_MIN` exists to protect from garbled-input misfires (see
   `intentTelemetry.js`'s comment on the keyboard-mash-scores-0.386-against-status incident —
   the same risk applies to a new canned-reply intent).
4. Run `npm run check-intents` after adding phrases — check specifically for collisions against
   the existing `port`/`status`/`git_status` intents, which already ask similarly-shaped
   "what's ..." questions.

**Verify:** "what time is it" / "what's the date" answer correctly and immediately with no model
call even when AI mode is on; garbled input ("asdf1234") does not misfire into the new intent
(same test shape as the existing GARBAGE battery in `check-matcher`); `check-intents` shows no
new exact duplicates against existing intents.

---

## Phase 1 — Scheduled / autonomous triggers

**Problem:** everything in this app is reactive — it only acts when a user types something or
opens the dashboard. There's no way to say "check every morning for unpushed changes" or "run
tests automatically whenever I save a file."

**Build:**
1. `server/scheduler.js` — a small cron-style scheduler (do not add a new npm dependency unless
   genuinely necessary; a simple `setInterval`-based tick that checks each schedule's next-fire
   time against `Date.now()` is enough for this use case — no need for a full cron-expression
   parser, a small set of interval shapes is fine: `every N minutes/hours`, `daily at HH:MM`,
   `on file save`, `on git commit`). Schedules are per-project, persisted to
   `data/schedules.json` (gitignored, same treatment as `data/dev-urls.json`), survive restart.
2. New WS admin commands (same pattern as `connectionTelemetry.js`/`connectionPackAdmin.js`):
   `schedule <interval-phrase> <trigger-mode command or intent phrase>`, `list schedules`,
   `remove schedule <id>`.
3. When a schedule fires, run the associated trigger-mode command through the SAME matching
   pipeline a typed message would use, but with no interactive user to answer confirm prompts —
   scheduled commands must be restricted to read-only intents only (git status/diff, diagnostics,
   dev-server status, etc.) at first. Any schedule that resolves to a mutating/confirm-gated
   intent must be rejected at schedule-creation time with a clear error, not silently skipped at
   fire time.
4. Fired results post as an out-of-band `answer` WS message to any currently-connected session for
   that project (reuse the `taskQueue.js` "post an answer later" pattern already established for
   `project.diagnostics.type_check`). If nobody's connected, log to a `data/schedule-log.md` the
   user can review later (`review schedule log` admin command).
5. File-save and git-commit triggers hook into the existing `server/fileWatcher.js` — do not
   build a second file-watching mechanism.

**Verify:** `node --check` all new files, a schedule that fires actually posts an answer, a
schedule that resolves to a mutating intent is rejected at creation, restart the server and
confirm schedules persist and keep firing on the right cadence.

---

## Phase 2 — Push notifications

**Problem:** everything is pull-based. The user has to have the chat open (or poll the dashboard)
to learn a background task finished, a dev server crashed, or a scheduled check (Phase 1) found
something worth seeing.

**Build:**
1. `server/notify.js` — a small notification dispatcher with pluggable channels. Ship two
   channels: (a) OS desktop notification (best-effort, platform-branched like the rest of this
   codebase's Windows-first code — use a lightweight approach, e.g. shelling out to
   `powershell -Command [Windows.UI.Notifications...]` or an existing lightweight notify library
   already common in this ecosystem; degrade silently, never crash, if unsupported), (b) generic
   outbound webhook (POST a JSON payload to a user-configured URL — this is how Slack/Discord/etc.
   integration works without this app knowing about any specific service).
2. Webhook URL(s) are configured per-project in `console.config.json` or globally in the user
   profile (`data/user-profile.json` via `profileRoutes.js`) — your call which is more consistent
   with existing config precedent, but pick one and document it in CLAUDE.md.
3. Sending to a webhook is an outbound network call to a user-supplied URL — apply the SAME SSRF
   guard `server/urlSafety.js` already provides for `webSearch.js`'s deep-research feature. Do not
   skip this.
4. Wire notifications into: task queue completions (`taskQueue.js`), schedule fires that found
   something notable (Phase 1), dev-server crash detection (`executorProcesses.js`'s process
   `close`/`error` events).
5. New admin commands: `notify me when <event>` / `stop notifying me about <event>` /
   `list notifications`, plus a plain `test notification` command that fires one immediately so
   the user can verify setup without waiting for a real event.

**Verify:** `test notification` actually produces a desktop notification and/or webhook POST,
webhook URL is validated through `urlSafety.js` before ever being called, a malformed/blocked URL
is rejected at configuration time with a clear error.

---

## Phase 3 — Sandboxed executor for risky commands (opt-in)

**Problem:** every command — AI-suggested or typed — runs directly on the host via
`child_process`. This is fine for a trusted single-user local tool, but this project is going to
npm for strangers to install; an opt-in mode that shrinks the blast radius of a bad AI suggestion
is worth having.

**Build (this is the biggest, riskiest phase — go slowly and prefer doing less well over more
half-working):**
1. A new project-level (or global) setting: `sandboxRiskyCommands: boolean`, default `false`
   (opt-in, never on by default — changing this default later is a discussion, not a silent
   change).
2. When enabled, any command that would currently require confirmation because it's flagged
   `risky: true` (or is one of `ALWAYS_CONFIRM_TOOLS`) runs inside a restricted execution context
   instead of directly on the host, AFTER the existing confirm flow — sandboxing supplements the
   confirm gate, it does not replace it. Two acceptable approaches, pick whichever is realistic
   given what's available in the target environment without adding heavy new dependencies:
   (a) spawn with a restricted working directory + environment variable allowlist + no network
   access where the platform supports it, or (b) if Docker is available on the host, run inside a
   short-lived container mounting only the project directory. Document clearly in CLAUDE.md which
   approach was taken and its actual guarantees — do NOT oversell what this protects against if
   the real implementation is closer to (a) than a true container boundary.
3. This must never become a way to skip the existing confirm_prompt UI — it is strictly "given
   that the user already approved this, run it somewhere more contained."
4. Add a settings toggle in the frontend (extend `UserProfileModal.tsx` or add a small new
   settings panel) so this is discoverable, not just a hidden config flag.

**Verify:** with the setting off, behavior is byte-identical to today (this is the most important
check — do not regress the default path). With it on, a risky command still requires the same
confirm_prompt, and once confirmed, actually executes inside the restricted context (prove it,
e.g. by showing the sandboxed process cannot read a file outside the project directory).

---

## Phase 4 — Action history / timeline beyond git checkpoints

**Problem:** undo today is one thing — revert to the last git checkpoint commit, or restore one
file's pre-edit content via the `aiGuardrails.js` journal. There's no browsable timeline of
everything the AI/console has done across a project's whole lifetime, with the ability to
selectively revert one action from three sessions ago instead of only the most recent one.

**Build:**
1. `server/actionHistory.js` — append-only log of every mutating action (file write/edit/
   insert/append, executed risky command, git mutation) taken in a project, persisted to
   `.console/action-history.jsonl` (JSON Lines, one action per line — cheap to append, cheap to
   tail). Each entry: `{ id, timestamp, sessionId, type, description, preImagePath?, command? }`.
   Reuse `aiGuardrails.js`'s existing pre-image journal for file actions rather than duplicating
   that storage — this log can just reference journal entries by id where one exists.
2. New intent `project.action.history` / admin command `show history` — paginated, most-recent
   first, human-readable summary of the last N actions.
3. New capability: `revert action <id>` — for a file-mutating action with a journaled pre-image,
   restores that specific file to its pre-action state (this generalizes the existing
   `undoLastChange({path})` to work on ANY past action referenced by id, not just the most recent
   one for that file). For a git-mutating action, this cannot literally "revert" without risking
   history rewrite — instead, respond with the exact git command the user would need to run
   themselves, same caution `git_checkout`'s handler already applies (answer-only, no auto-run for
   destructive git history changes).
4. Frontend: a lightweight history panel (could live in the existing `ProcessDock.tsx` as a third
   tab, matching its existing "logs + projects overview" tab pattern) showing the timeline with a
   "Revert" button per file-mutating entry.

**Verify:** every existing file-mutating tool call and confirmed risky command actually gets
logged, `show history` renders it, reverting a 3-actions-ago file edit actually restores that
exact prior content (not just the most recent one), git-mutating entries never auto-revert.

---

## Phase 5 — Self-update lifecycle

**Problem:** once this ships as an installed npm package, there's no mechanism for it to notice a
new version exists or help the user upgrade.

**Build:**
1. On startup (once, not on every request), a bounded, non-blocking check against the npm
   registry for the latest published version of this package, compared to the running
   `package.json` version. Never blocks server startup; times out fast (a few seconds) and fails
   silently if offline — this app is explicitly offline-first, a failed version check must never
   look like an error to the user.
2. If a newer version exists, surface it exactly once per session as a quiet, dismissible notice
   (a WS message the frontend renders as a small banner, not a blocking modal) — do not nag on
   every message.
3. Admin command `check for updates` for on-demand checking, and `update console` which runs
   `npm install -g <package-name>@latest` (or the equivalent for however this is actually
   distributed — check `package.json`'s `bin`/publish config to get this right) through the
   SAME confirm-gated risky-command flow every other mutating action goes through. Never
   self-update without explicit confirmation.

**Verify:** version check never blocks or crashes startup, offline machines see no error, the
update notice appears at most once per session, `update console` requires confirmation like any
other risky command.

---

## Phase 6 — Portable workspace export/import

**Problem:** the Phase-30-equivalent pack installer (already built) moves *tools* between
machines. It doesn't move a user's whole setup — memory, learned confidence thresholds, custom
config, profile — as one bundle.

**Build:**
1. Admin command `export workspace` — bundles into a single downloadable/saveable JSON (or
   zip, if you want file-level fidelity for things like `.console/memory.md`) covering: the
   user profile (`data/user-profile.json`), learned confidence model
   (`data/confidence-model.json` or wherever `modelStore.js` persists it), threshold overrides,
   and — per project, opt-in via a list the user confirms — that project's
   `.console/memory.md` and `console.tools.json`. Never include anything from `data/` that's
   already documented as excluded from npm publish (check `package.json`'s `files` array) unless
   the user explicitly opts in per item.
2. Admin command `import workspace <path>` — same two-step preview-then-confirm pattern as the
   pack installer (Phase "already built" above) — show exactly what will be imported/overwritten
   before writing anything.
3. This is explicitly NOT a cloud sync feature — local file export/import only, matching this
   app's offline-first design. Do not add any network dependency here.

**Verify:** export → fresh install → import round-trips correctly (learned thresholds, profile
name, and at least one project's memory.md all survive the round trip); import never silently
overwrites without the confirm step.

---

## Phase 7 (stretch — larger, do last, ok to defer entirely) — Real semantic code index

**Problem:** `codebaseIndexer.js`'s repo map/symbol graph is rebuilt in memory on every scan and
only powers the AI's context window plus the dead-code/circular-import diagnostics. There's no
persisted, queryable semantic index over actual code content — asking "where do we handle payment
retries" only works as well as the AI's context window happened to include the right file.

**Build (only attempt this after Phases 1–6 are solid; this is a genuinely bigger data-layer
investment, not an afternoon task):**
1. A persisted local vector store — no new heavyweight service dependency; a flat file of
   `{ chunkId, filePath, lines, vector, text }` records plus brute-force cosine search is
   sufficient at this project's scale (a single user's local codebases, not a multi-tenant SaaS
   corpus) — do not reach for a database server.
2. Chunk source files (function/class-level chunks using the existing `extractSymbols()` AST
   boundaries from `codebaseParsers.js` where available, falling back to fixed-size chunks for
   unsupported languages) and embed with the SAME extractor `semanticMatcher.js` already loads —
   do not add a second embedding model.
3. Index build is background/on-demand only (reuse `taskQueue.js` from Phase "already built"),
   never blocks project scanning, and is invalidated/incrementally updated on file change via
   `fileWatcher.js`.
4. New intent for semantic code search, read-only, answers with file+line citations, not
   fabricated code — be explicit in the handler that this is retrieval, not generation.

**Verify:** index survives restart, a semantic query returns real file/line citations that
actually contain relevant code (spot-check several queries by hand), indexing a large project
doesn't block anything else in the console.

---

## Additional smaller quality-of-life backlog (pick these up opportunistically between phases,
or as a final Phase 8 — each is small enough to do in isolation)

- Expose the currently-hardcoded tuning constants (`FUSE_THRESHOLD`, `DEBOUNCE_MS`,
  `DEV_URL_DETACH_GRACE_MS`, etc. — see CLAUDE.md's "Conventions" section for the full named-
  constant list) through a real settings panel in the frontend instead of requiring a code edit.
- A `health check` / `is my console healthy` admin command that reports: Ollama reachability,
  embedding model loaded, disk space for `data/`, whether any zombie tracked processes exist.
- Extend session export (`exportAsMarkdown`/`exportAsJson` in `useConsole.ts`) with a PDF option.
- A "pinned/favorite projects" layer on top of the existing `workspaceProjects` concept, surfaced
  at the top of `SidebarDrawer.tsx`.
- Revisit the two diagnostics intents explicitly deferred in the last intent-taxonomy pass:
  `diagnostics_test_coverage_report` and `diagnostics_bundle_size_analysis` — both need a little
  new tooling (coverage report parsing, bundle analyzer output parsing) that wasn't worth building
  just for those two at the time; worth revisiting now that more infra exists.
- A rate/concurrency cap on `taskQueue.js` if Phase 1's scheduler ends up creating many
  simultaneous cross-project background tasks — re-check whether the current "one task at a time
  per project, unlimited across projects" design still holds up once schedules can fire
  unattended.

---

## After every phase

1. `npm run lint && npm run check-intents && npm run check-indexer && npm run check-handlers && npm run check-matcher && npm run check-tools && npm run check-ws-cases`
2. Update CLAUDE.md in place describing what actually got built (not what was planned — what's
   really there), in the same terse, dated-comment style as the rest of the file.
3. Commit with a clear message naming the phase. Do not squash multiple phases into one commit.
