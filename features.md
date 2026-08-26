# Local Project Console — Complete Feature Map

This document is the single, exhaustive reference for the Local Project Console: every feature,
every subsystem, every command, every endpoint, and every persisted file. It is a cross between an
extended README and a developer-facing CLAUDE.md — read it to understand the whole product, or jump
to a section to understand one part.

**Stack**: Node.js ≥20 (Express + WebSocket) backend, React 19 + Vite + Tailwind v4 frontend, optional
local AI via Ollama. Offline-first: zero external API calls by default (an opt-in Ollama Cloud model
still proxies through the local daemon), zero data leaves your machine unless you opt in.

**Numbers at a glance** (re-measured 2026-08-24, round-6 audit):
- 148 built-in intents / 2,907 example phrases across `server/intents/*`
- 23 REST route modules, 59 WebSocket-handler files, 13 interactive tool panels
- 6 matching stages (pre-semantic literal → embedding → fuzzy → NLP → local router → fallback)
- 482 node:test cases (349 matcher + 133 WS case tables) plus 7 `check-*` regression harnesses
- 1 background daemon (cross-platform `scripts/daemon.mjs`), 1 desktop (Electron) shell, 1 terminal launcher

---

## Table of contents

1. [Running the console](#1-running-the-console)
2. [The command dispatcher (trigger mode, no AI)](#2-the-command-dispatcher-trigger-mode-no-ai)
3. [The matching pipeline](#3-the-matching-pipeline)
4. [The AI assistant (opt-in)](#4-the-ai-assistant-opt-in)
5. [Interactive tool panels](#5-interactive-tool-panels)
6. [General-mode file tools](#6-general-mode-file-tools)
7. [Personal tools: reminders, notes, clipboard, backup](#7-personal-tools-reminders-notes-clipboard-backup)
8. [PDF toolkit & spreadsheets](#8-pdf-toolkit--spreadsheets)
9. [Automation: schedules, notifications, auto-start](#9-automation-schedules-notifications-auto-start)
10. [Memory systems](#10-memory-systems)
11. [Self-learning: near-miss, telemetry, confidence model, distillation](#11-self-learning)
12. [Project discovery, indexing & code search](#12-project-discovery-indexing--code-search)
13. [Safety model](#13-safety-model)
14. [Multi-user / LAN attribution](#14-multi-user--lan-attribution)
15. [Developer & General workspaces](#15-developer--general-workspaces)
16. [Frontend & UI](#16-frontend--ui)
17. [REST API reference](#17-rest-api-reference)
18. [WebSocket protocol](#18-websocket-protocol)
19. [Admin commands](#19-admin-commands)
20. [Configuration files](#20-configuration-files)
21. [Persisted data layout](#21-persisted-data-layout)
22. [Development, testing & CI](#22-development-testing--ci)
23. [Desktop app, publishing & installing](#23-desktop-app-publishing--installing)
24. [Differentiation & positioning](#24-differentiation--positioning)
25. [Repo layout](#25-repo-layout)

---

## 1. Running the console

The server auto-falls back through ports 3000–3019 if 3000 is taken; the frontend and CLI client
discover whichever port it actually bound to.

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (from the repo root) |
| `npm run dev` | Start the server with **current source** (`tsx server/index.js`), web UI at `http://127.0.0.1:3000`. Prefer over the batch file while iterating. |
| `npm run launcher` | **start.bat-equivalent W/C/Q menu** (terminal-native, no batch file). Probes ports 3000–3019 for a running server and hands off instead of starting a duplicate. |
| `npm start` | Start from the esbuild bundle (`node dist/server.js`) — only if `dist/` is up to date |
| `node bin/cli.js` | Start server in-process + auto-open the browser |
| `node bin/cli.js cli` | Start server in-process + hand the terminal to the CLI chat |
| `node server/cli-client.js [--dir <path>] [--project <name>]` | CLI chat against an already-running server |
| `npx local-project-console` / `local-project-console` | Run from npm without a clone |
| `npx local-project-console init [dir]` | Generate a `console.config.json` for a project |
| `scripts/daemon.mjs start\|stop\|status` (or `npm run daemon:*`) | Cross-platform background daemon (Node; also `scripts/*.ps1` on Windows) |
| `cd desktop; npm install; npm start` / `npm run dist` | Electron desktop shell / Windows installer |

### The launcher (`npm run launcher`)

A terminal-native replica of `start.bat` (added 2026-08-24). It:

1. Renders the same ANSI-styled W/C/Q menu (Web UI / CLI Chat / Quit).
2. Probes ports 3000–3019 via `GET /api/projects` (5s per port) for an already-running server.
3. **[W]** — opens the browser against the running port, or starts the server in-process (loading
   all models: embeddings + NLP classifier) and opens the browser.
4. **[C]** — hands to `server/cli-client.js` (which waits out cold boot, up to 90s) against the
   running server, or starts the server in-process first. When the CLI exits, the server exits with
   it (no orphan).
5. **[Q]** — exits.

Implementation lives in `bin/cli.js` (`probeRunningPort`, `runLauncher`, `askChoice` with
`crlfDelay: Infinity` for the Windows ConPTY quirk, `openBrowser` shared with the default/cli modes).

---

## 2. The command dispatcher (trigger mode, no AI)

The console works fully without AI: every message is routed through a matching pipeline and
dispatched to a handler that runs real commands, reads real files, or answers from real state.

### Intent catalog (148 intents)

**git** — push, commit, commit+push (comment-parsed), pull, fetch, remote add/info, init, add,
ignore-add, rm-cached, log, branch, branch-create, branch-cleanup, checkout (answer-only), diff,
diff-summary, stash, stash-pop, stash-list, stash-summary, tag, ahead/behind, pr-ready-check, deploy
(checkpoint + push). Read-only run immediately; mutations confirm-gated with `isSafeParamValue()`.

**npm & files** — install, build, run (duplicate-dev-server guard; `--port` rewriting), run-project
(script-name whole-word match), run-tests (real test-command detection), create/append/read/find/
delete file, how-to-run, open-* family. File creates/edits are regex-parsed, quoted-content only,
confirm-before-write.

**project.knowledge / project.context** — overview, stack, commands, gotchas, architecture,
how-to-run, code.search, file relations, routes, monorepo, todos, biggest files, recent activity,
dev-server status, scan servers, running processes (global), session info, needs-AI-mode.

**chit-chat** — greeting (time-of-day aware, live-state + memory enriched), status, gratitude,
farewell, identity (incl. privacy answers), ack, joke, clear, help, list-commands, explain-followup,
yes-no, port, time/date (server-local clock, never a model call), calculate (safe arithmetic,
offline unit conversion, percentage/tip/tax), git-status, undo alias, how-do-I (catalog-backed),
needs-ai-mode, monitoring metrics.

**actions** — metrics, open-in-vscode (code CLI → `vscode://` fallback), open-in-cursor,
open-in-explorer, open-in-terminal, open-github-page, open-site, open-file, open-html, open-with
(editor registry), reveal-file, copy-path, checkpoint, project-scan, project-list.

**tools openers** — open calculator / pdf-tools / reminders / file-tools / notes / spreadsheet /
clipboard / backup / notifications / documents / marketplace / repo-map (all send an additive
`openPanel` field on the answer; the CLI ignores it and prints the chat-equivalent phrasing).

**general.files** — find (name+content), tidy (type/date folder moves), duplicates (hash groups),
duplicates-delete (keep newest), rename (in-place, same-dir), move (into an existing subfolder).
Usable from every workspace type; the mutating ones are confirm-gated, journaled as `file_move`,
and revertible — they power the Folder Explorer's inline rename + drag-and-drop.

**pdf** — merge, split, extract-text (read-only), extract-pages, watermark. Tagged
`opensPanel: 'pdf-tools'`.

**reminders / notes / csv / clipboard & snippets / backup / diagnostics** — see the dedicated
sections below. Diagnostics: dead-code, circular-imports, type-check (background tsc), env-check,
log-errors, cross-project memory search, test-coverage-report (reads lcov artifacts, never runs
anything), bundle-size-analysis (walks build output).

### Read-only code Q&A

- Detected API routes (Express/Flask/FastAPI/Django), import + imported-by relationships, monorepo
  sub-package detection, TODO/FIXME scan, largest files, recent file activity, session info.
- Every answer is derived from the project's `codebaseIndex` — no fresh scan, no model call.

### Multi-intent queries & conversation context

- "show structure and run tests" splits on conjunctions (`and/also/then/plus`, commas, semicolons,
  `&`, "as well as") and handles each part. Splitting bails on quotes or a colon-introduced list
  (no quote/colon-boundary awareness — it refuses to split rather than cut a value in half).
- Pronoun/keyword carryover (`resolveContext`): "show it" repeats the last turn's intent; short
  inputs (<10 chars) repeat the last turn **only if it was read-only** (so "ok"/"yes" after a
  deploy never re-dispatches the mutation).

### Typed-command bypass

A well-formed command line typed in chat runs directly, bypassing the matcher:

- Single-token commands require the allowlist (`npm`, `node`, `git`, `python`, `npx`, `vite`,
  framework CLIs: `ng`, `flutter`, `dart`, `cargo`, `go`, `mvn`, `dotnet`, `ruby`, `php`, ...).
- Multi-token lines resolve the executable on PATH **or** the project's own `node_modules/.bin`
  (so a project-local CLI like `ng serve` works even when not globally installed).
- Natural-language guard: `find`/`sort`/`where`/`convert` followed only by plain words is treated
  as a request ("find duplicate files") and reaches the matcher, not the Windows binary.

### "how do I run this" / "how do I <anything>"

- Run-command answers follow a trust order: config entries > package.json scripts > documented
  README/CLAUDE.md commands > `Play *.bat` launcher > language-based guess. Site/server-flavored
  asks prefer the command that actually serves the web app.
- Question shapes ("how to push", "command to see the dashboard") are pinned to a built-in command
  catalog before the matcher — a question can never execute the thing it asks about. Answers show
  the chat phrasing, the real shell command, and a clickable suggestion chip.

---

## 3. The matching pipeline

`matchInput()` in `server/matcher.js` resolves every trigger-mode message. Stage order:

1. **Input normalization** — strips trailing `?!.,;`/backslashes (typo tolerance), balanced-pair-aware
   closer stripping.
2. **Multi-intent split** — conjunction splitting; telemetry captured per part immediately.
3. **Pre-semantic literal overrides** (`PRE_SEMANTIC_OVERRIDES`) — narrow literal rules for
   confirmed embedding traps: how-do-I question shapes, "what is the site about" (→ overview),
   typo'd time, git init/ignore/remote-add, imperative deploy, file-create, who-uses/imports,
   run/start/launch+server nouns, open-html vs open-file vs open-with vs reveal-file, pdf-verb+
   pdf-mention shapes, "remind me", notes/csv/documents free-text shapes, calculator
   convert/percent/tip/tax, "run the calculation", serve-the-site-on-port. **Must stay narrow** —
   each rule is a dated, named incident record.
4. **Embedding stage** — `semanticMatcher` (all-MiniLM-L6-v2, optional dependency) scans project +
   base intent vectors. `getEffectiveThreshold()` gates only `source === 'semantic'` results;
   fuzzy/keyword results are trusted as-is.
   - **Config-entry redirect** (stage 1b): when the winner is `run_project`/`npm_run` and the input
     isn't bare "open/run/start the project", project-authored config entries get a chance above
     floor 0.55.
   - **Collision** → blocking 1/2/neither disambiguation (different intent within 0.03).
   - **closeSecond** → non-blocking "did you mean" chip (within 0.10).
5. **Fuzzy stage** — Fuse.js (threshold 0.55, length-scaled floor).
6. **NLP classifier** — trained @nlpjs classifier (`server/nlpEngine.js`, rebuilt fresh each boot
   from the same INTENTS set, retrained from confirmed near-misses). Replaced `node-nlp` (round-2
   audit, 2026-08-24) with the equivalent @nlpjs deps — the old package dragged in a critical
   `xlsx` CVE through an unused spreadsheet feature; classifier outputs are parity-verified.
7. **Local router** — one bounded Ollama classification call (additive only; any failure returns
   null and the pre-existing fallback runs). Only decides *which* intent fires — never bypasses
   confirms.
8. **Fallback** — did-you-mean chip (nearest intent ≥ 0.45, workspace-eligible, not pure-chitchat
   on a real request) + fuzzy suggestion chips.

**Trust guards** (`intentTrust.js`): pure-chitchat intents are rejected when the input
`looksLikeRealRequest()` (has a file extension or a quote); `project.knowledge.*` is rejected when
the input names a specific file. Both prevent a weak classifier defaulting to safe-sounding canned
replies on out-of-distribution input.

**Key invariants**:
- `BUILTIN_INTENTS` membership (intentRegistry.js) is the dispatch gate — an intent missing from
  it is unreachable from any stage. It has silently killed intents 6+ times; `check-handlers`
  verifies bidirectionally.
- `WORKSPACE_DEV_ONLY_INTENTS` only filters **suggestions** (help text, did-you-mean, fallback
  chips) in General workspaces — never dispatch. A dev command typed in a mis-classified general
  folder still runs.
- Telemetry (`metrics`) records every match result for the confidence model.

---

## 4. The AI assistant (opt-in)

- **Off by default**; the header toggle is the sole opt-in. On toggle-on it checks connectivity and
  picks a sensible default model (cloud preferred when reachable, then local) unless you already
  chose one.
- **Models**: any local Ollama model, or an Ollama Cloud model (`:cloud` suffix — still proxies
  through the local daemon; `ollama signin` + internet required). Model pull streams progress.
- **Modes**: Default / Coding / Tutor / Creative / Consultant / Structured (structured forces a
  JSON code block with a `type` field).
- **Tool-call loop**: up to 6 rounds (`MAX_TOOL_ROUNDS`). Tools are sandboxed to the active project:
  readFile, writeFile, editFile (single/multi-hunk all-or-nothing, whitespace-normalized fallback),
  findFiles, insertAtLine, appendToFile, searchCode (RE2), listFiles, getProjectInfo, getGitStatus,
  undoLastChange (journal or git), saveMemory, executeCommand (gated), listProcesses, stopProcess
  (always-confirm), probeUrl (localhost/private only), runTests (always-confirm), webSearch,
  deepResearch.
- **Streaming**: tokens stream live; `<tool_call>` JSON is intercepted server-side; `think: true`
  keeps reasoning-model deliberation separate from the answer (surfaced as a live trace). The
  `/api/chat` client has an idle watchdog (2 min) so a hung model load can't spin forever.
- **Anti-hallucination**: a corrective retry fires when the model *narrates* a tool call it didn't
  make; an explicit warning is sent when a reply claims a completed mutating action with no
  evidence a tool ran.
- **Context injection**: system prompt carries the project's main doc (~6000 chars), entry-point
  snippets, a whole-project repo map (top-level symbols, imports + used-by), detected API routes,
  monorepo info, cross-session memory, and (when a query names a file) a focused per-file slice.
  History is adaptively pruned (keeps system + last 3 turns verbatim, compresses the middle).
- **Gating**: writeFile/editFile/insertAtLine/appendToFile + risky executeCommand + runTests +
  stopProcess always require explicit approval. `runTests`/`stopProcess` can never be auto-approved
  by any policy or session grant. "Approve this task" pre-grants the non-risky file tools for that
  session+project. Per-project policy via `console.tools.json` (`ask` / `allow-after-first-ask` /
  `deny`); executeCommand can never leave `ask`.
- **File upload**: attach real files in the AI input bar for analysis.
- **Web search / deep research**: DuckDuckGo-based, no API key, SSRF-guarded, results cached 5 min.
- **Write-path guards**: every AI file edit is syntax-checked (parse-level) before/after, the
  pre-edit content is journaled for `undoLastChange({path})`, concurrent edits on the same path are
  serialized, and successful writes trigger a debounced background `tsc --noEmit` type-check.
- **File-edit diff previews**: confirm cards show a before/after line diff.
- **AI-dock hints**: an open-ended request typed while AI is off answers with a concrete
  rephrasing to use in the AI dock, instead of "flip the toggle".

---

## 5. Interactive tool panels

A **Tools** button (visible with a general-mode project active) opens a registry-driven card grid.
Clicking a card opens the panel in the same space as the chat. Every panel is a convenience layer
over the chat: mutations compose the exact chat trigger command and send it through the normal WS
path, so confirm cards, journaling and `revert action <id>` stay in the terminal as the single
source of truth. Panels are server-driven via `GET /api/tool-panels`.

| Panel | What it does |
|---|---|
| **Calculator** | Live iOS-style widget (C, +/-, %, ÷×−+, digits, =, Convert, Tip modes). "=" evaluates via `POST /api/calculate` — the SAME server-side math engine chat uses, so they can't diverge. Keyboard input supported. |
| **PDF Tools** | Project PDF list with download/reveal; drag-and-drop upload (50MB cap, never overwrites); Merge (multi-select + output name), Split (per page / around page N), Extract (text / pages), Watermark. Every Run sends the chat trigger command. |
| **Reminders** | Apple Reminders-style: Today / Upcoming / All / No Date views, quick-add (full trigger or bare text → dateless TODO), complete-as-cancel with an 8s Undo snackbar, overdue highlighting, per-project attribution. |
| **File Tools** | Finder-style browser: Search & Browse (name+content search, `.html` in-console Preview), Tidy (by-type/by-date move plan with per-row exclusion checkboxes), Duplicates (MD5-by-size groups, keep-newest, per-row delete selection). |
| **Folder Explorer** | Browse ANY absolute path on disk (works in General mode with no project). Breadcrumbs + back/forward/up/home/refresh, name-filter search bar, Lines/Objects view toggle, double-click/Enter opens a file in its OS default app, per-file Open-in-IDE / Open-with / Reveal / Copy-path menu. Read-only. |
| **Notes** | Apple Notes-style 2-column split (240px list rail + editable surface). Add/search via chat triggers; edits save on blur. Selection + filter persist per project. |
| **Spreadsheet (CSV)** | Pick a CSV + column; Sum/Average/Count/Filter run through the same server CSV engine as chat. Filter renders a real sortable table (sticky header, zebra rows); drag-and-drop CSV upload (2MB cap). |
| **Clipboard** | OS clipboard history (opt-in) + named snippets. Pinned snippets above the stack; copy/remove/pin; snippet save from clipboard; .txt/.md snippet import. All copies are server-side OS writes. |
| **Backup** | Time Machine-style reverse-chronological list; subfolder picker + "Backup now"; per-row download + reveal. |
| **Notifications** | IFTTT/Zapier-style rule cards (file-changed / file-added / folder-stale + days threshold), event-channel toggles, desktop/webhook status, test notification, pause/resume/remove. |
| **Documents** | Spotlight-style search over PDFs/Word/text docs (offline embedding index) with file:line citations; status states (unavailable/indexing/ready/error); AI-mode "Ask" box synthesizes above the always-present chunk list. |
| **Pack Marketplace** | App Store-style grid over a user-configured public HTTPS registry (no default URL); registry URL field, Install → preview-then-confirm in chat. |
| **Repo Map** | Aider-style whole-project map (round-6 audit, 2026-08-24): every indexed code file's top-level exports/functions/classes, imports, reverse "used by" list, plus detected API routes — the same structure the AI system prompt is built from, rendered as a filterable table with a per-file details pane. Read-only; served by `GET /api/projects/:id/repo-map` from the project's cached codebase index (built on demand). |

---

## 6. General-mode file tools

Trigger-mode only, zero AI dependency, usable in every workspace type:

- **`find files matching X` / `search for X in my files`** — filename + content substring search
  (20KB/file cap, 20 results). Read-only, immediate.
- **`tidy this folder` / `organize this folder by type`** — moves loose root files into category
  folders (Images/Documents/Spreadsheets/Presentations/Archives/Audio/Video), or `YYYY/MM` by date,
  or combined. Shows the plan, confirms, checkpoints, journals every move (`file_move`), ≤100
  moves. Fully revertible via `revert action <id>`.
- **`find duplicate files` / `delete duplicates, keep newest`** — sha256-by-size duplicate groups
  with wasted-space estimate (read-only); the delete is confirm-gated, keep-newest, journaled with
  pre-images (≤1MB), revertible. Caps: 2000 hash candidates, 50MB/file.
- All paths validated by the same sandbox boundary the file tools use; mutating operations are
  confirm-gated with checkpoint + journaling.

---

## 7. Personal tools: reminders, notes, clipboard, backup

**Reminders** (`remind me tomorrow at 9am to ...`):
- Free-form natural-language dates via chrono-node; recurrence (weekday/daily/interval) parsed
  BEFORE the date so the scheduler gets a concrete recurrence type. Dateless input becomes a
  never-firing TODO.
- Fires to the open chat (creator's session first), any session, or `data/schedule-log.md`.
  Plain text — reminders never execute commands, so they bypass the read-only intent check.
- `list my reminders` / `cancel reminder s2` (bare numbers accepted too).

**Notes** (`note: buy milk`):
- User-authored scratch notes to `<project>/.console/notes.md` — immediate, no confirmation.
  The AI never writes them and they're never injected into the system prompt. Capped 200 entries,
  exact-normalized dedupe, per-project write lock. `show/search my notes` + the Notes panel.

**Clipboard & snippets** (`show clipboard history`):
- **Two separate opt-in** profile settings: `clipboardHistory` (poll the OS clipboard into an
  in-memory 25-entry deduped ring) and `clipboardPersist` (also write to a local file). Nothing
  reads your clipboard by default. `copy_to_clipboard` WS events are pure display notices — all
  real copies are server-side OS writes (Set-Clipboard base64-encoded), so the CLI copies for real.
- Snippets are global named text blocks in `data/snippets.json` (100 max, 4000 chars, overwrite on
  re-save). `save this as a snippet: X` / `copy snippet X` / `delete snippet X`.

**Backup** (`backup this folder`):
- Zips the project (or a named subfolder) to `data/backups/<name>-<timestamp>.zip` (50MB cap,
  skips node_modules/.git/.console/dist). Read-only against the source; each zip is journaled so
  `revert action <id>` deletes it. `list backups` + the Backup panel.

---

## 8. PDF toolkit & spreadsheets

**PDF toolkit** (five intents + the panel):
- `merge these pdfs into combined.pdf`, `split report.pdf into one file per page` / `at page 5`,
  `extract text from report.pdf` (read-only preview), `extract pages 2-5 ... into excerpt.pdf`,
  `watermark report.pdf with confidential`.
- Every write confirms first, checkpoints, journals (`file_write`, existed:false), and **never
  overwrites an existing output** (a binary pre-image can't be journaled, so an overwrite would be
  unrevertable). PDF-only folders are auto-recognized as projects (classified *general*). Bare
  operation names ("merge pdfs") open the panel. Caps: 200 files, 10 merge inputs, 150MB, 2000
  pages. Uses pdf-lib (build/split/watermark) + pdf-parse v2 (text).

**Spreadsheet (CSV)** — deterministic, dependency-free, read-only:
- `sum/average column X in Y`, `count rows in Y where X <op> v`, `filter Y where X <op> v`
  (ops: equals/contains/greater than/less than). Quoted-field parser, 2MB/20k-row caps, numeric
  ops strip `$`/`%`/commas. Column/file names validated by `isSafeParamValue`. No filter-to-file
  write variant exists (a future one must go through confirm + action-history).

---

## 9. Automation: schedules, notifications, auto-start

**Scheduled & triggered commands** (`schedule every 10 minutes "git status"`, `schedule daily at
09:30 ...`, `schedule on file save ...`, `schedule on git commit ...`):
- Persisted to `data/schedules.json` (gitignored, debounced). A 15s tick (`lastFiredAt`-based —
  restarts never double-fire) drives interval/daily/weekly/oneshot; event triggers are chokidar
  watchers (file-save vs git-commit distinguished via `.git/refs`/HEAD, 1s debounce, 60s per-schedule
  throttle).
- **Read-only allowlist only**: creation validates through the same matching pipeline, and the
  phrase is re-matched + re-checked at fire time (drift guard). Fires run through taskQueue with a
  fake ws; results deliver to the project's live session or `data/schedule-log.md` (400-line cap).
- `list schedules` / `delete schedule 2` / `review schedule log`.

**Notifications** — all off until opted in:
- Events: `dev-server-crash`, `schedule-find`, `task-done`, `collision-found`, `file-changed`,
  `file-added`, `folder-stale`, `reminder-fired`. Channels: Windows desktop toast (PowerShell WinRT,
  best-effort) and/or webhooks (SSRF-guarded — no localhost/private at send time; URLs are bearer
  secrets in gitignored `data/notifications.json`).
- `notify me when X` / `stop notifying me about X` / `list notifications` / `webhook add/remove` /
  `test notification`.

**File-watch rules** — notification-only, NEVER a command trigger (a separate store from schedules
on purpose, so a watch rule can't become a backdoor to running commands):
- `notify me when files change in <folder>` / `notify me if <folder> hasn't changed in N days`
  (1–365). One chokidar watcher per folder, 1s debounce, once-per-day folder-stale sweep from the
  scheduler tick (no second interval), bounded concurrency. Rules persist to `data/watch-rules.json`
  and survive restarts; the Notifications panel shows them as rule cards.

**Auto-start projects** (`auto-start this project` / `auto-start <name>`):
- Boots the project's dev server automatically on every start. The stored phrase is re-matched
  through the normal pipeline; the resolved intent must be launch-shaped (`run_project`/`npm_run`/
  `run_tests`) or a configured entry (drift guard — a phrase that drifted onto git push never runs
  unattended). Candidate dev URLs are probed first (no double-serve over a manual instance), runs
  stagger 20s apart through taskQueue, and boot-time runs never auto-approve confirms (they expire
  via the pending TTL). Results go to the open chat or `data/auto-start-log.md`.
- `disable auto-start` / `list auto-start` / `run auto-start now` / `review auto-start`.

**Intent-collision baseline**:
- Every boot compares intent-embedding overlaps against the persisted baseline
  (`data/collisions.json`) and raises the opt-in `collision-found` notification for anything new —
  a drift alarm for the matching corpus. `check collisions` shows current state on demand.

---

## 10. Memory systems

Four deliberately distinct stores (a split once overwrote the wrong file and broke the server):

| Store | Path | What | Written by |
|---|---|---|---|
| **AI memory** | `<project>/.console/memory.md` | Durable facts via the `saveMemory` tool, injected into the AI system prompt ("What You Remember About This Project"), 200 entries / 500 chars each, deduped (string + semantic ≥0.92 cosine), two-tier gating (low saves immediately; judgment/sensitive requires approval) | AI only |
| **User notes** | `<project>/.console/notes.md` | Scratch notes (`note: ...`), never AI-written, never in the prompt | User only |
| **Usage patterns** | `<project>/.console/project-memory.json` | Command/file/question frequency; crossing a scaled threshold offers a memory_suggestion confirm card (quick trigger / CLAUDE.md note / topic section). `review memory` shows current patterns. | Console (tracked) |
| **Sessions** | `<project>/.console/sessions/<id>.json` + `.ndjson` | Per-session history (meta + NDJSON log); parallel human-readable `chat-log.md`; fast lookup index in `data/conversations/index.json`; `.console/` auto-gitignored | Console |

Session details:
- Sessions are permanently locked to the project they were created for (session.projectId +
  projectPath). Cross-tab path checks prevent a root-A chat from running against root-B's
  same-named folder.
- The index self-heals: reconciliation adds missing entries, an mtime fast-path skips per-dir reads
  when the index is fresh, and NDJSON-only recovery re-indexes a session whose meta was lost.
- Exports: `GET /api/sessions/:id/export?format=md|json` reads the ring-buffer-UNCAPPED log (never
  the 200-message cap); the client PDF is built from the same JSON server-side formatter.
- Cross-project memory search (`which project did I ... in`) fans out over every scanned project's
  memory.md at ask time via the shared embedding extractor, capped at 400 lines.

---

## 11. Self-learning

Four independent learning layers, all local and offline:

1. **Near-miss → suggestions** (`learningEngine.js`): when the matcher falls through, the input and
   its accepted command are logged to `data/near-misses/<projectId>.jsonl`. Patterns with ≥5
   occurrences and ≥80% acceptance auto-promote into intent examples on startup; lower-confidence
   ones need `review learning` + `approve suggestions`. Promoted phrases feed the embedding matcher,
   the Fuse index, AND the NLP classifier (all three, live, no restart), and persist to
   `data/learned-intents.json`.
2. **Intent telemetry auto-tuning**: every match logs stage/confidence/outcome to
   `data/telemetry/<projectId>.jsonl`. `telemetry suggest thresholds` / the startup sweep propose
   per-intent confidence floors. Pure-chitchat floors are clamped to ≥0.5 so a trained model can
   never re-enable the garbled-input canned-reply bug.
3. **Learned confidence model** (`confidenceModel.js`): plain-JS logistic regression over real
   accept/reject outcomes. With ≥12 labeled examples per family it recommends the floor at which the
   model predicts ≥70% accept (holding margin/input-length at the means of its own accepted
   examples); below that, the fixed heuristic applies (zero change on fresh installs). Retrains on
   boot and fire-and-forget after every confirm/reject. `telemetry review` reports status.
4. **Distillation** (`distillation.js`): AI exchanges are analyzed into trigger-mode config
   suggestions (`review distillations` / `apply all distillations`). Command entries from successful
   `executeCommand` runs (trigger inferred from your phrasing, e.g. "run the tests"); knowledge
   entries when the AI read a file and produced >200 chars. Deduped, 30-day pending pruning,
   approve-gated only (never auto-applied).

---

## 12. Project discovery, indexing & code search

**Discovery** (`projectScanner.js` + leaves):
- Scans a base dir for subfolders with `console.config.json`, a context doc (CLAUDE.md first,
  then README.md, ABOUT-*.md, UNIVERSAL_CONTEXT.md), or `package.json`.
- **Code-only fallback**: a folder with none of the above is still recognized if it has real source
  in ~19 code languages (24 extensions — JS/TS, Python, Go, Rust, Java, C/C++, C#, Ruby, PHP,
  Swift, Kotlin, Dart, Vue, Svelte, Shell, PowerShell and more), a recognized config file, or a
  real `.git` dir — with a synthesized fallback
  config ("what is this project" entry describing its detected stack).
- **Single-root escape**: if the scan target itself looks like one project (config, doc,
  package.json, root PDF, or includeAll with no subfolders), it resolves to itself instead of
  listing its subfolders.
- **`scanAllFolders` setting**: include every immediate subfolder as a project (classified general)
  even with zero signals. Off by default.
- **Script auto-derivation**: package.json scripts become runnable entries (tagged `auto: true`,
  hand-authored wins, `requires: ['node_modules']` gating).
- **Whole-scan cache**: 8s TTL validated against per-project mtime signatures, so GET /api/projects
  doesn't re-walk heavy roots on every fetch.
- **Wrapper projects** (`commandDir.js`): a root with no launcher script + exactly one sub-package
  with a launcher = commands run in the sub-package (and its docs are adopted at scan time).

**Codebase indexing** (`codebaseIndexer.js`): on project select, builds a directory tree, detects
languages (real names only — a junk `.zip` folder can't fake its way in), frameworks (incl.
Angular/Flutter, Spring Boot from pom/gradle), entry points, key config files, a whole-project repo
map (top-level exports/functions/classes per file, TS compiler API for JS/TS/TSX, regex fallback
elsewhere), import + reverse "used by" relationships, API routes, and monorepo sub-packages. All
cached by mtime, deterministic, concurrency-bounded.

**Symbol graph** (`codebaseGraph.js`): per-file symbol records + reference edges; when a query names
a file, the AI system prompt's repo map is swapped for that file's focused slice; `getProjectInfo`
carries an additive symbolGraph.

**Semantic code index** (`server/codeIndex/`): a persisted per-project vector store at
`<project>/.console/code-index.json`:
- Chunking: symbol-anchored ranges for AST-capable files, fixed 40-line/10-overlap windows
  otherwise, prose paragraph runs for docs, page-mode for PDFs.
- Background-only builds (taskQueue, never on a WS turn), incremental single-file re-chunking via a
  lazy watcher, atomic debounced writes, corruption resilience (any invalid chunk resets the store
  → full rebuild).
- `project.code.search` ("where do we handle X") answers with real file:line citations,
  unavailable/indexing/ready statuses, and out-of-band results when the build is queued.
- **Documents knowledge base** (`ask_documents`): the same index covers PDFs (.docx via mammoth,
  .md/.txt); retrieval-only citations with optional AI synthesis on top. `search my documents for X`
  / `what did i write about the budget`.

---

## 13. Safety model

Layered, defense-in-depth — don't weaken without discussion:

1. **Hard blocklist** (`dangerousPatterns.js`): `rm -rf /`, force-push to main/master, `reset
   --hard` to origin/main, `branch -D main`, disk-level format/dd, shutdown, fork bombs. Last resort,
   not a security boundary.
2. **Command-risk classifier** (`commandRisk.js`): computes the EFFECTIVE risk of an executeCommand
   (git push/reset/clean/rebase/--amend/-D, npm/cargo publish, recursive deletes, disk utilities).
   The caller-supplied `risky` flag can only ADD risk, never waive it.
3. **Confirm gate** (`toolGate.js`): risky/destructive commands + writeFile/editFile/insertAtLine/
   appendToFile always confirm with one-time tokens + 5-min expiry. `runTests`/`stopProcess` can
   never be auto-approved by any policy or grant. Per-project policy via console.tools.json
   (`ask`/`allow-after-first-ask`/`deny`; executeCommand forced to `ask` at parse time).
4. **Git checkpoints** (`gitSafety.js`): before a risky command, a `console-checkpoint:` commit is
   created (message passed via `-F` tempfile — cmd.exe doesn't honor `\"` escaping). `undo`/`revert
   that` resets only when the HEAD commit is a console checkpoint (protects your own work).
5. **Sandboxed file tools** (`toolSandbox.js`): all file/git/process tools resolve within the active
   project via realpath-aware containment (symlink escapes rejected). Tools take single named-args
   objects.
6. **Opt-in `sandboxRiskyCommands`** (`executorSandbox.js`): confirmed risky commands spawn with a
   restricted environment (env allowlist, cwd pinned, CONSOLE_SANDBOXED markers). Honest
   guarantees: NOT a container — no network isolation on Windows, no OS-level file boundary. Never
   weakens the confirm flow; only applies after approval.
7. **Ask (read-only) permission mode** (round-6 audit, 2026-08-24): profile setting
   `permissionMode: 'ask'` makes the AI and direct tool paths strictly read-only — writeFile/
   editFile/insertAtLine/appendToFile, executeCommand (even "non-risky"), runTests, stopProcess,
   saveMemory, undoLastChange, and every custom manifest tool answer a plain "blocked in Ask mode"
   error instead of prompting, checkpointing, or auto-running. Checked BEFORE the gate, so no
   session grant or allow-after-first-ask policy can soften it; the gate itself is untouched and
   trigger-mode typed commands keep their normal confirm cards. Default 'default' (off).
8. **Allowlist** (`toolAllow.js`): chips/AI tool calls/manifest entries must start with an approved
   executable; typed command lines are more lenient (PATH resolution). Custom manifest values pass
   `isSafeParamValue()` and the resolved command is re-checked against the blocklist at call time.
9. **SSRF guards** (`urlSafety.js`): web search/deep-research/pack registry only reach safe external
   hosts; probeUrl/liveness only reach localhost/private. Webhooks re-validated at send time
   (redirect: 'manual' everywhere — a 3xx never reaches a host that wasn't validated).
10. **WS origin check**: non-local origins rejected. Server binds `127.0.0.1` by default; `HOST=0.0.0.0`
    is the explicit LAN opt-in (no auth — don't do it on an untrusted network).
11. **Action history** (`actionHistory.js`): every mutating action journals a pre-image to
    `.console/action-history.jsonl` (cap 2000), so `revert action <id>` restores it (file_* restores
    content/deletes; file_move moves back; backups/ deletes the zip; git/command answers
    checkpoint-aware advice, never auto-runs). Journaled destructive answers also carry an additive
    `actionIds` array (round-5 audit) so the web UI shows an 8s Undo toast that sends
    `revert action <id1>,<id2>` through the normal chat flow (batch revert = one confirm card,
    one `revertAction` per id; mixed git/command batches are answer-only).

**Executor hardening** (the shell layer):
- Dev-server URL detection + auto-detach (10s dev-shaped / 20s otherwise); stdout listener stays in
  URL-scan-only mode after detach so late "Local:" banners are still recorded.
- Interactive port prompts (`(Y/n)`) are relayed via confirm cards; EADDRINUSE offers a one-click
  retry on the next port; git "no upstream branch" offers the one-click `push --set-upstream` retry.
- Stop path (`stopTrackedProcess`) is the single kill+cleanup used by every stopper: on Windows a
  SYNCHRONOUS `taskkill /f /t /pid` (async raced SIGTERM and orphaned the real server), then
  post-stop verification (child liveness + Windows command-line survivor scan + URL probe) with a
  "Heads-up" warning — never re-kills (a same-command process may be your own manual instance).
- `cancel` kills only the current AI turn's own processes (turnKey); `abort_ai` is process-free.
- Output: ANSI-stripped streaming, LF/CRLF warning collapsing, 150ms coalescing, post-exit
  `outputSummarizer` callout (exit code, recognized error lines, npm added/removed/vulnerabilities,
  git commit/push/conflict lines).

---

## 14. Multi-user / LAN attribution

Phase 19 (opt-in via `HOST=0.0.0.0`): each WS connection may claim a display name
(`set_display_name` — web auto-claims the profile name; CLI prompts). The label feeds `createdBy`
on action-history entries, notes (`· by <name>`), and reminders; `GET /api/connected-users` powers
a Dashboard "who's connected" row when 2+ users are connected. **This is attribution, not auth** —
no passwords, no permissions, and one LAN user can still read another's action history (a real
security boundary between users is explicitly out of scope). Default single-user installs
(127.0.0.1) never prompt and everything stays `"local"`.

---

## 15. Developer & General workspaces

- Every scanned folder gets a `workspaceType` ('dev' | 'general'). A `console.config.json`
  `workspaceType` override always wins; otherwise code/package.json/.git → dev, else general
  (PDF-only folders stay general by design).
- The per-project tab switcher (header) flips between them, and `switch to developer/general mode` /
  `what mode am I in` manage it from chat/CLI (persisted into console.config.json, which is
  auto-gitignored unless you deliberately track it).
- The type only filters which commands are *suggested* — dev-shaped suggestions stay hidden in a
  general folder, but typing a dev command there still works. Never a hard gate.

---

## 16. Frontend & UI

React 19 + Vite + Tailwind v4, dark-first with an additive light theme (theme-aware accent colors;
only `accent-blue` is wired to the Settings accent picker).

**Architecture notes**:
- `useConsole.ts` is the orchestrator; `handleWebSocketMessage` is a `useCallback([])` that looks up
  the case table via a per-render `ctxRef` — never capture first-render state in a case handler (the
  fix for the stale-closure / "AI says on but responds like trigger mode" bug class).
- Every panel is a convenience layer over the chat (see section 5). UI-level persistence uses
  inline localStorage (`console.pinnedProjects`, `console.tabs`, `console.deckUsage`, tours taken,
  explorer view/size/path, notes selection/filter).

**Key screens**:
- **WelcomeScreen** — hero + BentoGrid project grid + stats strip + AI toggle + 4-step tour.
- **Terminal** — the chat column: message thread, inline confirm cards, output blocks (auto-expand
  for AI-run commands), Ctrl+R history search, ↑/↓ history, Tab completion, per-project command
  history, "load earlier" pagination, per-row error boundaries, auto-scroll only near the bottom.
- **Sidebar** — collapsible rail: scan box, New Chat, Chats (General | Projects mini-tabs, search,
  rename, delete, expand-to-full-history), pinned projects, workspace toggle.
- **ProjectTabs** — Chrome-style tabs, each with its own scan folder/project list/open chat
  (per-tab workspaces); "+ New tab" duplicates the current; every tab is closable; layout persists.
- **Dashboard** — per-project status grid (uncommitted files, recent commits, dev URL, running
  command, git ahead/behind), Projects + Live Sites tabs, name filter, dirty/running-first sort,
  expanded card action row (Open in chat / Run / Stop / Commit & push / Push / Open site / Copy
  path / History) — all via the normal chat flow, never a bypass. Live Sites truth is `entry.running`
  = any tracked process OR the stored-URL probe answered OR the project IS the console.
- **ProcessDock** — bottom dock: Live output (ring-buffer replay), Projects overview, History
  (action history with revert). Collapsed = one slim bar per running process.
- **CommandDeck (Ctrl+K)** — Raycast-style palette over navigation + actions + every tool panel +
  every chat intent + sessions + projects. Tokenized relevance scoring (Levenshtein typo
  tolerance + space-stripped concatenation matching), Recent/Frequent ranking with time-decayed
  frequency, a two-pane layout: rows carry right-aligned category labels under grouped section
  headers ("Results for 'x'" when querying), and the right-hand preview pane is a metadata panel
  (name/type/location/modified) for file-ish results. Nothing bypasses confirm flows.
- **CommandReference** — category sidebar + searchable full command catalog (curated + auto-generated
  intent layer).
- **ChatHistoryOverlay** — full chat history modal with General | Projects tabs, search, rename,
  delete; opening a row switches to the tab that owns its folder.
- **FirstRunSetup** — one-time onboarding wizard (name, scan path, default workspace type, Ollama
  note); skip-able; CLI mirrors it.
- **Tour system** — 7 sectioned tours (card or guided mode); guided steps spotlight real controls
  via `data-tour` attributes and can switch the main view.
- **UserProfileModal** — name/title/role, accent-color picker, sandbox/clipboard/scanAllFolders
  toggles, Folder Explorer default view, Editors & IDEs registry, Tours, Developer/Advanced tuning
  editor (live knobs via `/api/tuning`).
- **Theme** — dark-first zinc tokens in `:root`, light override in `[data-theme="light"]`, no
  `dark:` utilities; module-level pub/sub `useTheme` so the header toggle and Ctrl+K never drift.

---

## 17. REST API reference

All 23 route modules, mounted in `server/index.js`. Project-scoped routes accept an optional
`?tab=<id>` to resolve against that tab's scan workspace.

**Project & session**
- `GET /api/projects` — scanned projects (whole-scan cached). `?tab=`
- `POST /api/scan-path` — set the scan root (name-only paths resolve against current root/parent).
  `?tab=`
- `POST /api/projects/:id/index` — rebuild a project's codebase index (background).
- `GET /api/projects/:id/action-history?limit=N` — action history (1–200).
- `GET /api/projects/:id/chat-log` — download `.console/chat-log.md`.
- `GET /api/sessions` / `POST /api/sessions` — list (incl. projectPath/workspacePath) / create.
- `GET /api/sessions/:id?before=N&limit=N` — messages (default 200).
- `GET /api/sessions/:id/export?format=md|json` — full uncapped export (single source for MD/JSON
  downloads and the client PDF).
- `PATCH /api/sessions/:id` (rename), `PATCH /api/sessions/:id/link` (link to project),
  `DELETE /api/sessions/:id`.

**Search & AI**
- `GET /api/search?q=` — DuckDuckGo web search (SSRF-guarded).
- `GET /api/deep-research?q=` — fetch + summarize top 5 results.
- `GET /api/ollama/status` — daemon/models/cloud/internet state.
- `POST /api/ollama/start` — launch the daemon.
- `POST /api/ollama/pull` — SSE-streamed model download.

**Monitoring**
- `GET /api/metrics` / `POST /api/metrics/reset` — in-memory metrics snapshot.
- `GET /api/active-servers` — tracked running processes (projectId/command/pid/url).
- `GET /api/processes` — same + startedAt.
- `GET /api/processes/:projectId/log` — ring-buffer log replay (~2000-line tail).
- `GET /api/dashboard` — per-project status grid (30s cache, git state, live probes, console-self
  detection). `?tab=`

**Profile, tuning, workspace**
- `GET/POST /api/profile` — user profile (sanitized; `syncClipboardPolling` on save).
- `GET/POST/DELETE /api/tuning` — runtime knob overrides (bounds-validated, Fuse index rebuilt).
- `GET /api/workspace/export?file=<name>` — download a workspace bundle (newest when no file given).

**Panels & tools**
- `GET /api/tool-panels` — the 12-entry panel registry.
- PDF: `GET /api/projects/:id/pdf-files`, `GET /api/projects/:id/file?path=`, `POST
  /api/projects/:id/reveal`, `POST /api/projects/:id/pdf-upload` (50MB, never overwrites).
- CSV: `GET /api/projects/:id/csv-files`, `csv-headers`, `csv-preview`, `csv-filter`,
  `csv-aggregate`, `POST csv-upload` (2MB, never overwrites).
- Notes: `GET /api/projects/:id/notes`.
- Clipboard: `GET /api/clipboard-history` (empty when opt-in off), `GET /api/snippets`.
- Backup: `GET /api/projects/:id/backups`, `folders`, `backup-file?name=`.
- Reminders: `GET /api/reminders`.
- Notifications: `GET /api/notifications` (rules/events/desktop/webhooks).
- Documents: `GET /api/projects/:id/documents?q=`, `GET /api/projects/:id/documents/ask?q=`
  (optional AI synthesis).
- Marketplace: `GET /api/registry/config`, `GET /api/registry/packs` (SSRF-guarded HTTPS).
- File tools: `GET /api/projects/:id/files`, `search-files`, `static/*` (in-console HTML preview),
  `tidy-plan`, `duplicates`.
- **Calculate**: `POST /api/calculate` — same engine as the chat calculator.
- **Command docs**: `GET /api/command-docs` — curated + auto-generated intent catalog.
- **Browse (Folder Explorer)**: `GET /api/browse?path=` (any absolute path, 2000-entry cap),
  `POST /api/browse/reveal`, `POST /api/browse/open` (OS default app).
- **Repo Map (round-6 audit)**: `GET /api/projects/:id/repo-map` — the whole-project symbol map
  (repoMap + apiRoutes + languages/frameworks/entryPoints/subPackages), built from the project's
  cached codebase index on demand.
- **Editors**: `GET/POST /api/editors` — editor registry + per-extension defaults.
- **Connected users**: `GET /api/connected-users` — display names (LAN only).
- **Webhook tester (round-6 audit)**: `POST /api/notifications/test-webhook` `{url}` — sends one
  test payload through the same SSRF-guarded fetch a real webhook uses and returns
  `{ok, status, timeMs, sizeBytes, reason}` for the Notifications panel's response panel.

---

## 18. WebSocket protocol

Single endpoint `/stream` (origin-checked). The frontend derives the URL from `window.location`, so
it follows whatever port the server bound.

**Client → server**: `execute` (projectId/input/sessionId/tabId), `confirm_response` (with token),
`cancel`, `abort_ai`, `stop_process`, `did_you_mean_pick`, `tool_call` / `execute_tool`,
`approve_task` (one-click pre-grant), `ai_toggle`, `ai_set_model`, `workspace_set`,
`set_display_name`, `learning_review` / `learning_approve`, `memory_suggestion_respond`.

**Server → client** (27 core cases): `answer` (bot bubble; additive `openPanel`), `start`/`output`/
`end` (command output blocks; `end` clears commandPending; bare data-less `end` clears AI in-flight),
`error_output`, `warning`, `suggestions`, `did_you_mean`, `confirm_prompt`, `tool_confirm_prompt`
(with optional edit diff preview), `task_granted`, `memory_suggestion`, `tool_start`, `tool_result`,
`ai_start`, `thinking` (reasoning trace), `ai_status`, `update_available`, `learning_suggestion`,
`server_url`, `copy_to_clipboard`, `projects_updated`, `project_updated` (membership-filtered per
tab), `workspace_updated`, `dashboard_update`, `processes_update`, `semantic_matcher_progress`,
`display_name_set`. Plus the streaming trio: `stream_start` / `token` (45ms batching) /
`stream_end`.

**Persistence interceptor**: the ws.send wrapper auto-persists answers, buffered command output
(one role-`output` record per command, 200KB cap), tool_start/tool_result (role-`system`), and
warnings — so a reloaded session keeps its structure.

**CLI parity is enforced**: `server/cli-client.js` is a second renderer of the same protocol, and
`checkWsMessageCases.ts` fails when a core WS type lacks a CLI case (rendered or explicit no-op).

---

## 19. Admin commands

Pre-matcher tier in `connectionExecute.js` — all answer + trailing `end` (the trailing `end` is the
contract that clears the web "Running..." spinner; a missing one caused the 2026-08-14 mode-switch
stuck-spinner bug):

- **Telemetry**: `telemetry review|stats`, `telemetry thresholds`, `telemetry suggest`,
  `threshold set/remove <intent> <floor>`, `telemetry auto-apply [all]`, `telemetry clear`,
  `check collisions`.
- **Distillation / memory / learning**: `review distillations`, `apply distillation <n>|all`,
  `clear distillations`, `review memory`, `review learning`, `approve suggestions [n]`.
- **History**: `show history [N]`, `revert action <id>`.
- **Schedules**: `schedule <every/daily/on file save/on git commit> <command>`, `list schedules`,
  `remove schedule <id>`, `review schedule log`.
- **Notifications**: `notify me when <event>`, `stop notifying me about <event>`, `list
  notifications`, `webhook add/remove <url>`, `test notification`, `notify me when files change in
  <folder>`, `notify me if <folder> hasn't changed in N days`, `stop watching <folder>`, `list
  watched folders`.
- **Auto-start**: `auto-start <name>`, `disable auto-start`, `list auto-start`, `run auto-start now`,
  `review auto-start`.
- **Pack / registry**: `install pack <path>`, `list packs`, `set pack registry <url>`, `browse pack
  registry`, `search packs for X`, `install pack <name> from registry`, `confirm/cancel install
  pack`.
- **Workspace**: `export workspace [with projects 1 3 | with all projects | without projects]`,
  `import workspace <path>`, `confirm/cancel import workspace`.
- **Mode**: `switch to developer|general mode`, `what mode am I in`.
- **Update**: `check for updates`, `update console` (confirm-gated `npm install -g`).
- **Health**: `health check` / `is my console healthy` (Ollama reachability, embedding state, disk
  space, zombie tracked processes).
- **Doctor**: `console doctor` / `run the doctor` / `diagnose` — proactive machine-side checks
  (ports 3000-3019 free, daemon alive, embedding model cached, data/.cache writable, Ollama
  reachable, npm update status, tooling on PATH, disk space). Works WITHOUT a running server
  via `npm run doctor` / `node bin/cli.js doctor` (exit 0/1/2 for scripts) — the same checks
  the chat command runs.
- **Match quality**: `review match quality` — per-intent recent mean/min match confidence from
  the rolling per-message log, stage distribution, and drift flags when an intent's mean
  dropped >0.1 vs the prior window (the signature of the phrase corpus growing over it).
- **Onboarding**: `reset onboarding` / `retake tour` (re-shows the first-run wizard).
- **Stop/dev-URL pre-checks**: `stop the server` / `stop it` (only when a process is tracked);
  `where is the link` / `what is the url` (liveness-probes recorded + candidate URLs, with
  language-aware guidance).

---

## 20. Configuration files

**`console.config.json`** (per project) — command entries + canned replies:
- `commands`: `{ trigger, action, params [{name, prompt, pattern}], requires [paths],
  requiresMessage, followUp, response, risky }`. `{param}` placeholders are filled from the trigger
  phrase or asked one plain follow-up question; values pass `isSafeParamValue` regardless of the
  entry's own pattern. Hot-reloads on change.
- `chatReplies`: per-intent canned pools (greeting/status/gratitude/farewell/ack), sanitized at
  scan time.
- `workspaceType`: 'dev' | 'general' override.

**`console.tools.json`** (per project) — custom AI tools + permissions:
- `tools`: `{ name, description, command, risky, args }` (substitution via `{{arg}}`/`${arg}`; values
  validated + resolved command re-checked against the blocklist at call time).
- `permissions`: `{ writeFile: 'allow-after-first-ask', ... }` — ask / allow-after-first-ask / deny;
  executeCommand is coerced to 'ask'.

**`data/user-profile.json`** (git-tracked) — name/title/customRole/setupComplete/
sandboxRiskyCommands/clipboardHistory/clipboardPersist/defaultWorkspaceType/locale/accentColor/
scanAllFolders/explorerViewMode/permissionMode ('default'|'ask', round-6 audit). Sanitized
server-side; clipboard + sandbox toggles take effect live.

**Gitignored runtime stores** — `data/tuning.json` (knob overrides), `data/schedules.json`,
`data/notifications.json` (webhooks are secrets), `data/watch-rules.json`, `data/auto-start.json`,
`data/collisions.json`, `data/dev-urls.json`, `data/editors.json` (machine-specific editor commands),
`data/snippets.json`, `data/registry-config.json`, `data/telemetry/*`, `data/near-misses/*`,
`data/distillations/*`, `data/learned-intents.json`, `data/backups/`, `data/workspace-exports/`,
`data/clipboard-history.json`, `data/general-workspace/`.

---

## 21. Persisted data layout

- `<project>/.console/` — auto-gitignored: `sessions/<id>.json` (meta) + `<id>.ndjson` (log),
  `chat-log.md`, `memory.md`, `notes.md`, `project-memory.json`, `action-history.jsonl`,
  `code-index.json`.
- `data/conversations/index.json` — fast session lookup index (self-healing).
- `data/telemetry/<projectId>.jsonl` — match telemetry (confidence model training data);
  `confidence-model.json`; `thresholds.json`.
- `data/near-misses/<projectId>.jsonl` — near-miss learning log.
- `data/distillations/<projectId>.jsonl` — AI-exchange → config suggestions.
- `data/schedule-log.md`, `data/auto-start-log.md` — unattended-run transcripts (capped).
- All durable rewrites use `writeFileAtomicSync` (tmp + rename) so a torn write can never silently
  reset learned state; appends stay plain appendFileSync (a torn append loses one line, never the
  whole file).

---

## 22. Development, testing & CI

```powershell
npm run lint              # tsc --noEmit
npm test                  # node:test: 482 tests (349 matcher + 133 WS case tables)
npm run test:coverage     # same suite with server-wide coverage
npm run check-intents     # exact/near-duplicate phrase scanner (1/7/82 baseline)
npm run check-matcher     # matching-pipeline regression battery (349 inputs)
npm run check-indexer     # codebase indexer regression battery (103)
npm run check-tools       # sandbox/gate/tool regression battery (182)
npm run check-handlers    # intent-handler coverage + dispatch checks (260)
npm run check-ws-cases    # frontend WS case tables + CLI parity (133)
npm run check-docs        # command-catalog ↔ README sync (70 catalog + 136 generated)
npm run build             # vite build + esbuild server bundle -> dist/
```

- The matcher batteries live in `server/scripts/batteries/matcherBatteries.js` — the single shared
  source used by both `npm test` and `npm run check-matcher`. Recalibrate with
  `npm run check-matcher -- --probe`.
- CI (`.github/workflows/ci.yml`) runs lint + all check-* on every push/PR to main.
- **Gotchas**: `dist/server.js` shadows source under `start.bat` when present (prefer `npm run dev`);
  Vite watches `data/`/`.cache/`/`*.console/` — keep the ignore lists in sync in `server/index.js`
  and `vite.config.ts`; every new WS type needs a web case + a CLI case; `BUILTIN_INTENTS`
  membership + check-handlers rows; no file over ~400 lines (split by concern); `node --check` +
  lint after server edits.

---

## 23. Desktop app, publishing & installing

**Desktop shell** (`desktop/`): a self-contained Electron wrapper with its own package.json (the
root install never pulls Electron). It reuses the launchers' port rule (3000–3019, attaches instead
of starting a duplicate), spawns the server as a child process, waits for the bound port, shows the
console in its OWN native Electron window (a splash page covers the server's cold-boot, then the
window loads the console — external https links opened from the UI go to the system browser, the
console itself never does), and adds a tray icon whose Quit stops the server child cleanly. Closing
the window quits the app (which stops the server). `npm install &&
npm start` runs it; `npm run dist` builds an NSIS Windows installer; `.dmg` (macOS) and `.AppImage`
(Linux) build in CI (`.github/workflows/desktop-build.yml`, macos-latest + ubuntu-latest matrix,
`CSC_IDENTITY_AUTO_DISCOVERY=false`, artifacts uploaded per OS).

**Packaging architecture (round-5 audit, 2026-08-24 — the original packaging could never work)**:
- `desktop/scripts/stage-server.mjs` stages a runnable server runtime into `desktop/stage/`: the
  server source, `bin/`, an EMPTY `data/` (fresh installs start like a new user — no developer
  data, onboarding wizard on first run), the vite-built frontend INSIDE `server/` (production
  mode serves static files from `__dirname`), and `npm ci --omit=dev` node_modules.
- `electron-builder` `extraResources` copies `stage/` into `resources/`; the
  `desktop/scripts/after-pack.cjs` hook re-adds node_modules (electron-builder excludes
  node_modules from extraResources by default).
- `desktop/main.cjs` resolves the server root as `process.resourcesPath` when packaged and spawns
  it with `ELECTRON_RUN_AS_NODE=1` — without it, `process.execPath` is the Electron binary and the
  "server" relaunches as another app instance (live-probed: crash-loop with hundreds of helper
  processes).
- **Icons (round-6 audit)**: the designed brand icon ships in `desktop/build/` as `icon.png`
  (1024×1024 master, Linux), `icon.ico` (16–256 multi-size PNG-embedded, Windows NSIS) and
  `icon.icns` (ic07/ic08/ic09/ic10 PNG entries, mac dmg) — all generated from the source JPEG by
  the audit's conversion script. The NSIS installer + unpacked exe embed the icon (verified
  pixel-identical to the source).

**Publishing** (from this repo): `npm login` → `npm version patch` → `npm run build` →
`npm publish`. `package.json` `"files"` ships only `bin/`, `dist/`, `server/`, `README.md`,
`LICENSE` — `data/` and personal config never publish. `npx local-project-console` / global
`local-project-console` both open the web UI; add `cli` for the terminal chat. Needs Node ≥20
(`engines` field, matches CI) and, for AI mode, a local Ollama.

---

## 24. Differentiation & positioning

Why this project is built the way it is (all claims verified, round-5/round-6 audits):

- **Trigger-mode-first**: deterministic intent matching drives every message by default. AI is an
  opt-in layer ON TOP of the same pipeline — a bare install answers "run the tests", "git status",
  "what is this project" with no model involved. The console is not an LLM-to-shell translator; it
  is a command dispatcher that happens to have an AI mode.
- **Zero-network-floor (verified)**: every outbound fetch in `server/` is one of: AI-mode-only
  (ollama, webSearch, deepResearch), admin-command-gated (packRegistry, updateChecker),
  localhost probing (livenessProbe, toolProcess), or the boot-time embedding download (cached,
  degrades gracefully to fuzzy/NLP matching). Trigger-mode chat makes ZERO outbound calls —
  offline behavior is identical to online behavior, and that's a tested invariant, not a claim.
- **Layered safety, not AI-gated safety**: the blocklist, command-risk classifier, confirm gate,
  git checkpoints, sandbox, allowlist, SSRF guards, and action-history journal all hold in trigger
  mode. The AI path adds the tool gate + Ask mode on top; it never weakens the base.
- **Verifiable behavior**: each user message persists `meta.match` (stage/intent/confidence) so
  "why did it do that" has a recorded answer; the Repo Map panel shows the exact structure the AI
  prompt receives; `--dry-run`/`--explain` (CLI) resolve what a message WOULD do without doing it.
- **Capability probe** (`server/capabilityProbe.js`): boot-cached presence map of npm/yarn/pnpm/
  bun/python/node/git/docker/flutter/dart/cargo/go; run-suggestions surface yarn when both it and a
  scripts-bearing project exist — no assumptions about what's installed.
- **Offline-first privacy posture**: `data/` runtime stores are gitignored (except the user
  profile, by design); clipboard history is double-opt-in; webhook URLs are masked over REST;
  nothing phones home.

## 25. Repo layout

```
├── server/                  Express + WebSocket backend (155 JS files)
│   ├── index.js             Thin orchestrator: routes, WS init, discovery, startup sweeps
│   ├── state.js             Shared mutable state (scan dir, caches, pending confirmations, port)
│   ├── matcher.js           matchInput() pipeline orchestrator (297 lines)
│   ├── semanticMatcher.js   Embedding + Fuse.js matching (236 lines) + init/projects leaves
│   ├── intentRegistry.js    BUILTIN_INTENTS dispatch gate + workspace eligibility
│   ├── intentsData.js       Merges all intents/* phrase files (148 intents, 2,907 phrases)
│   ├── intents/             Per-domain phrase files (16 files)
│   ├── routes/              REST route modules (23 files, one per surface)
│   ├── wsHandlers/          WS connection logic + builtin intent handlers (59 files)
│   ├── schedules/           scheduleStore/parser/scheduler + reminder delivery (6 files)
│   ├── codeIndex/           Persisted semantic code index (5 files)
│   ├── notify/              Notification channels/store/events (3 files)
│   ├── scripts/             check-* harnesses + batteries (6 files + batteries/)
│   ├── test/                node:test suite entry (matcher.test.js)
│   └── tools.js, toolGate.js, toolSandbox.js, executor*.js, gitSafety.js,
│       dangerousPatterns.js, commandRisk.js, urlSafety.js, actionHistory.js,
│       ollama*.js, aiGuardrails.js, verifyHarness.js, projectScanner.js,
│       codebaseIndexer.js, codebaseGraph.js, conversationStore.js, memoryStore.js,
│       notesStore.js, learningEngine.js, confidenceModel.js, distillation.js,
│       projectMemory.js, sessionExport.js, cli-client.js, capabilityProbe.js, ...
├── src/                     React 19 + Vite + Tailwind v4 frontend
│   ├── hooks/               useConsole orchestrator + per-domain hooks (23 files)
│   ├── components/          Terminal, panels, dashboard, deck, explorer (69 tsx files)
│   ├── utils/               apiFetch, greetings, sessionLocation, appStorage (12 files)
│   ├── tours.ts             Tour step definitions (7 sections)
│   └── types.ts             Shared type definitions
├── bin/cli.js               npm binary entry (server+browser, cli, launcher, init modes)
├── scripts/                 Cross-platform daemon (daemon.mjs) + PowerShell daemon scripts
├── desktop/                 Self-contained Electron shell (own package.json)
│   ├── main.cjs             Spawns the server child (ELECTRON_RUN_AS_NODE), tray, port rule
│   ├── scripts/             stage-server.mjs + after-pack.cjs (packaging pipeline)
│   └── build/               icon.png / icon.ico / icon.icns (designed brand icon)
├── .github/workflows/       ci.yml (lint + check-* on push) + desktop-build.yml (dmg/AppImage)
├── start.bat                Windows launcher (W/C/Q menu, ASCII-only, port-probing)
├── features.md              This file — the self-contained repo map
└── CLAUDE.md                Living developer knowledge (split by module)
```

Per-directory purpose: `server/routes/` is the REST surface, `server/wsHandlers/` owns the WS
protocol + every intent handler, `server/intents/` is pure phrase data, `server/schedules/` the
autonomous triggers, `server/codeIndex/` the semantic code-content store, `server/notify/` the
out-of-band alert channels, `server/scripts/` the committed regression harnesses. The frontend
follows the same split: `hooks/` owns state + WS routing, `components/` renders, `utils/` holds
pure helpers.

---

*This document is the self-contained repo map (rewritten 2026-08-24, round-6 audit — every count
re-measured by running code, not reused). It was generated from a full read of the codebase
(server core, all WS handlers, all route modules, all tool/AI/safety layers, every panel, every
frontend hook/component/util, the automation + infra + harness scripts) plus the living knowledge
in CLAUDE.md and the audit trail in `audit/`. Keep it in sync when features change.*
