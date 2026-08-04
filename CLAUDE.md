# CLAUDE.md — Local Project Console

Read this first, before exploring code. Update it in place (replace stale info, don't append
a changelog) after any fix or new discovery. Keep it under ~100 lines.

## What this is

A local, offline command dispatcher + optional local-AI (Ollama) chat for Tobi's project
folders (`C:\Users\tobil\Desktop\Projects\<name>`). Express + WebSocket backend, React 19 +
Vite frontend. Full description: `README.md` and `BUILD-SPEC-v4.md` (the latter is a
historical design doc — describes intent at the time it was written, not necessarily current
state; this file is the source of truth for "what's actually here now").

## Run it

```powershell
Set-Location -Path "C:\Users\tobil\Desktop\project-console"
npm install
npm run dev     # tsx server/index.js, http://127.0.0.1:3000
npm run lint     # tsc --noEmit
```

`start.bat` handles port fallback (3000 → 3001-3010) automatically; the frontend derives the
WebSocket URL from `window.location`, so it follows whatever port the server actually used.

**Global npx launcher**: `node bin/cli.js` (or `npx local-project-console`) imports the
bundled or source server into the same process and polls `globalThis.__consoleServerPort` —
a process-global integer set by `server/index.js` once the port-fallback loop binds. This
avoids ESM module-realm duplication (the esbuild bundle inlines `server/` modules, so a
separate `import()` of `state.js` would see a different `state` object than the bundle's own
copy). The wrapper auto-opens the browser on detection.

**Background daemon mode** (no visible terminal): `scripts/start-daemon.ps1` starts the server
hidden, polls for readiness, and writes the bound port to `logs/daemon.port`. Stop with
`scripts/stop-daemon.ps1`. `scripts/add-to-startup.ps1` creates a shortcut in `shell:startup`
so the console starts automatically on login. Kill-by-port (not by wrapper PID) — robust even
when the cmd.exe wrapper exits before npm.

## Architecture

`server/index.js` is a thin orchestrator only — routes and WS logic live elsewhere:

- `server/state.js` — shared mutable state (scan directory, project cache, pending confirmations)
- `server/wsServer.js` — the `wss` instance + `broadcast()`
- `server/mockProjects.js` — seeds fake projects on non-Windows sandboxes
- `server/routes/` — `projectRoutes.js`, `sessionRoutes.js`, `searchRoutes.js`, `monitoringRoutes.js` (`/api/metrics`, `/api/active-servers`, `/api/dashboard` with 30s in-memory cache)
- `server/wsHandlers/` — `connection.js` (message router), `builtinIntents.js` (canned responses
  + `buildHelpMessage()` prompt library), `matchedEntry.js`, `aiQuery.js` (Ollama tool-call loop),
  `aiStream.js` (token streaming + `<tool_call>` extraction)
- `server/tools.js` — `createProjectTools(project)`: file/git tools **sandboxed to that project's
  directory only** (path-escape attempts are rejected). Named-args, not positional. Tools:
  `readFile`, `writeFile`, `editFile` (single-pair or multi-hunk `oldStrings`/`newStrings`
  arrays, all-or-nothing), `findFiles`, `insertAtLine`, `searchCode`, `listFiles`,
  `getProjectInfo`, `getGitStatus`, `undoLastChange`, `saveMemory`, plus Phase 5 additions
  `listProcesses`/`stopProcess`/`probeUrl`/`runTests` (process/test tools, always-confirm where
  they mutate) and `webSearch`/`deepResearch` (SSRF-guarded). Also home to `resolveToolGate`
  (single gate decision point: permissions policy → always-confirm set → session grants → ask),
  `findTestCommand` (shared test-command marker detection), and `getToolPermission`
  (permissions map from `console.tools.json`).
- `server/dangerousPatterns.js` — hard blocklist (last resort, not a security boundary)
- `server/confidenceModel.js` — pure-JS logistic regression trained on real accept/reject
  telemetry; see "Learned confidence model" below
- `server/configInitializer.js` — `initConfig()`: scans a target directory for stack markers
  (npm, Python, Rust, Go, etc.) via `codebaseIndexer.js` + `scriptEntries.js` and writes a
  tailored `console.config.json`; invoked by `npx local-project-console init`.
- `bin/cli.js` — npm binary entry point (`npx local-project-console`). Parses `init` command,
  launches the esbuild-bundled or source server in production mode, polls
  `globalThis.__consoleServerPort` (set by `server/index.js` after the port-fallback loop binds),
  and auto-opens the browser via `cmd /c start` (Windows) / `open` (macOS) / `xdg-open` (Linux).
  Uses `pathToFileURL()` for all `import()` calls since Windows absolute paths with drive letters
  are not valid ESM loader URLs.

Frontend: `src/hooks/useConsole.ts` owns all state + WS/fetch handlers; `src/App.tsx` is
render-only; `src/components/SidebarDrawer.tsx` is the collapsible left rail (scan bar, New
Chat button, per-project chat list with show-all toggle, compact Discovered Projects list with
workspace add/remove, AI status + running count in the bottom slot; collapses to a ~48px icon
rail); `src/components/Terminal.tsx` renders chat + the two remaining confirmation card
types (risky command, AI tool approval), centered on a `max-w-4xl` canvas beside the drawer
(fullscreen chat stays full-bleed and hides the drawer). Since the 2026-08-04 Phase 4
modularization, `Terminal.tsx` (~520 lines) is a thin orchestrator that composes six
sibling components, all in `src/components/`: `TerminalHeader.tsx` (top bar — connection
badge, fullscreen toggle, workspace chips, export buttons, tool-history toggle, ⚙ session
menu), `TerminalMessages.tsx` (scrollable thread: chat bubbles with markdown/JSON/output
rendering, telemetry-footer stripping, suggestion chips, the AI/trigger-mode busy
indicators + their Stop buttons, and the `endRef` scroll anchor), `TerminalConfirmCards.tsx`
(the three inline confirm chips — risky command, AI tool approval incl. the
"Approve + auto-approve file edits" grant button, memory suggestion), `TerminalOutputBlock.tsx`
(the collapsible command-output block from Phase 6 PASS 6.3), `StructuredJsonBlock.tsx`
(the ` ```json ` block with copy/apply actions used by structured AI mode), and
`TerminalSearchOverlay.tsx` (the Ctrl+R command-history overlay, which owns only its
autofocus ref; query/visibility/history stay in Terminal). Terminal still owns: input state,
command history (localStorage per project, `MAX_HISTORY` 200) + tab completion
(`KNOWN_COMMANDS`), `centerCol` fullscreen centering, `isBlocked`, the AI status row (ON/OFF
toggle + model/mode selects), the input form, and the Ctrl+K/Ctrl+R keydown wiring.
`src/components/Dashboard.tsx` polls
`/api/dashboard` every 5s and re-fetches immediately on `dashboard_update` WS events
(broadcast from executor.js on process/URL changes) — conditional `LayoutDashboard` button in
the header highlights when the view is active and replaces the main content area with a
per-project status grid (uncommitted files, recent commits, dev URL, running command). A green
pulsing pill in the header (`N running`) shows the live count from `/api/active-servers` with
zero layout shift. `src/components/CommandDeck.tsx` is the Ctrl+K command palette (header
Search button too): navigation, the active project's `console.config.json` command entries
(`{param}` entries defer to chat so the param-ask flow owns them), and project switching —
execution routes through the same `onDirectCommand`/`onSendMessage` handlers the rest of the
UI uses, nothing bypasses the confirm flows; sidebar collapse state is lifted to `App.tsx` so
the deck can toggle it.
`src/components/WelcomeScreen.tsx` is the canvas hero state (rendered in the centered canvas
when no chat is open — `showWelcome` is true, the old full-screen welcome fork is gone): hero
title, a compact per-project stat strip (active project's `codebaseIndex` files/dirs/
languages/entry points, global totals as fallback when none selected), the action buttons,
and the full `BentoGrid` of Discovered Projects below the hero, plus the 4-step guided tour
overlay (fixed z-50 backdrop-blur card, local state machine, dismissible at any step)
activated via a "Take the Tour" button alongside New Chat / Quick Start Guide.
`src/components/ui/AIAssistantInterface.tsx` is
the AI-mode input bar (real file upload via `FileReader`, Search/Reason/Deep Research toggles).

## How the AI gets project context

- `server/projectScanner.js` discovers `CLAUDE.md`, `README.md`, `ABOUT-TOBI.md`, and
  `UNIVERSAL_CONTEXT.md` per project (`CONTEXT_FILENAMES`), with `CLAUDE.md` always sorted
  first as the "main doc" regardless of readdir order.
- `server/ollamaContext.js` `buildSystemPrompt()` injects that main doc's content directly into
  the AI's system prompt (truncated at ~6000 chars). The prompt also instructs the model to call
  `findFiles` before `writeFile`/`editFile`/`insertAtLine` whenever the user names a file loosely
  ("the Claude.md file") rather than an exact path, and to ask the user to pick when there's more
  than one match — instead of guessing at the wrong file.
- `server/codebaseIndexer.js` snippets the first couple of entry-point files (`entrySnippets`);
  entry-point detection searches the whole tree (most Vite/CRA projects have `App.tsx` under
  `src/`, not at the root).
- `server/codebaseIndexer.js` also builds a whole-project **repo map** (`idx.repoMap`) — a
  regex-based, capped list of top-level export/function/class names per file (JS/TS + Python),
  mtime-cached per file. `formatRepoMap(repoMap, maxChars)` renders a capped text slice; used by
  `ollamaContext.js` (6000-char slice in the full AI-mode system prompt, alongside — not
  replacing — the entry-point excerpts) and by `matcher.js`'s router stage (1200-char slice,
  context only, passed into `localRouter.js`'s prompt). This is what lets even a small local model
  resolve "the config file" or "that component" instead of guessing or always reaching for
  `readFile` first — see `LOCAL_ROUTER_UPGRADE_PROMPT.md` piece 2.
- `server/scriptEntries.js` auto-derives `console.config.json`-style command entries from a
  project's `package.json` `scripts`, merged in during discovery. Hand-authored entries always
  win on an exact-action collision; auto entries are tagged `auto: true`.

## How chat memory works

- Each session's messages live at `<project.path>/.console/sessions/<id>.json` — inside the
  project it's about, not a central app-data folder. `<project.path>/.console/chat-log.md` is a
  parallel human-readable append-only log (one `## Title (timestamp)` block per session).
  `.console/` is auto-added to that project's `.gitignore` the first time a session is created
  there.
- `data/conversations/index.json` (central, in this repo) is just a fast lookup index
  (id → projectPath/title/updatedAt/messageCount) so `listSessions()` doesn't have to scan every
  project on disk — it holds no message content.
- Sessions created before a project is resolvable (no active project selected yet) fall back to
  `data/conversations/<id>.json` until a project is known, then migrate into that project's
  `.console/` folder automatically the next time they're read.
- See `server/conversationStore.js` for all of the above; `sessionRoutes.js` resolves
  `projectId` → `project.path` from `state.activeProjectsCache` before calling `createSession()`.

## Persistent cross-session AI memory (2026-07-29, requested directly)

- Separate from chat history above (which is per-session and only visible within that one chat):
  `server/memoryStore.js` manages `<project.path>/.console/memory.md` — a short, capped
  (200 entries) list of durable facts/preferences/project notes that the AI itself decides to
  save via the new `saveMemory` tool (`tools.js`), so they're available in a *different*, later
  chat session, not just the current one. Reuses `conversationStore.js`'s `ensureGitignored()` so
  the file gets the same `.console/` gitignore treatment as sessions, on first use even if no
  session has been created yet for that project.
- Deliberately does not depend on any locally-running model to decide what's worth saving — there
  is no separate classifier or embedding call. It's a plain tool call inside whatever AI-mode
  conversation is already happening (local or `:cloud` Ollama model, whichever the user has
  active), driven by instructions in `ollamaContext.js`'s system prompt. If AI mode is never used,
  memory.md simply stays empty — trigger mode does not read or write it.
- Two-tier write gating via `isGatedToolCall()` in `tools.js`: `saveMemory` with
  `importance: 'low'` (routine facts — a stated preference, a project quirk, a correction) writes
  immediately with no confirmation, so the model can do this often without interrupting the
  conversation; `importance: 'judgment'` (anything sensitive, inferred rather than stated
  directly, or the model isn't confident is worth keeping) goes through the same
  `tool_confirm_prompt` approve/reject flow as `writeFile`. `appendMemoryEntry()` also
  deduplicates near-identical entries (whitespace/case-normalized comparison) so re-saving the
  same fact is a harmless no-op.
- `ollamaContext.js`'s `buildSystemPrompt()` injects `formatMemoryForPrompt()`'s output (capped at
  4000 chars, most-recent-first if truncated) into the AI's system prompt under a "What You
  Remember About This Project" heading, alongside — not replacing — the existing CLAUDE.md
  injection. Verified with a standalone script: save → duplicate save (correctly skipped) →
  200+ entry cap (correctly holds at 200, oldest dropped) → `.gitignore` correctly gets
  `.console/` added on first write.
- This is intentionally narrower than the existing "close the loop" console.config.json
  self-documentation flow above — that one is for *commands* (so trigger mode can run them
  without AI next time); `saveMemory` is for general facts about the user/project that have no
  home in a config file or CLAUDE.md but would otherwise be lost when the chat ends.

## Learned confidence model (2026-07-29, "Stage 1" ML work, requested directly)

- `server/confidenceModel.js` is real supervised learning (a small logistic regression, trained
  with plain-JS batch gradient descent — no library, no GPU, no AI model of any kind) over
  features already being logged by `intentTelemetry.js`: the winning stage's confidence score,
  its margin over the runner-up, which stage won (semantic/fuzzy/keyword/literal-override), and
  normalized input length. The label is real user behavior — `falsePositive` on a telemetry entry
  is set in `connection.js`'s `handleConfirmResponse` whenever a gated action (risky command,
  writeFile, etc.) is actually approved or rejected, so training data is 100% real accept/reject
  outcomes, never synthetic.
- Deliberately has nothing to do with Ollama/AI mode — it runs whether or not AI mode has ever
  been used, entirely inside the Node process, on data the trigger-mode dispatcher was already
  collecting. This was the explicit design goal: something that "writes on its own" and doesn't
  depend on a locally-running model existing at all.
- Wired into `intentTelemetry.js`'s `suggestThresholds()`: once `MIN_LABELED` (12) labeled
  examples exist, `learnedFloor()`'s data-driven recommendation replaces the original fixed
  if/else bump rules (±0.03/±0.05 guesses) for every intent, in every place that already consumed
  `suggestThresholds()` — the manual `telemetry suggest thresholds` chat command AND the automatic
  `autoApplyThresholds`/`autoApplyThresholdsForAll` sweep that already ran unattended on server
  startup. No new confirmation flow was needed; it rides the exact same auto-apply path that
  already existed for the old heuristic. Below 12 labeled examples, `learnedFloor()` returns
  `null` and every call site falls through to exactly the original heuristic — zero behavior
  change for a fresh install or a low-usage project.
- Retrains automatically in two places: once on every server startup (`index.js`, right before the
  threshold auto-apply sweep so that sweep uses the freshest model) and fire-and-forget
  immediately after every new confirm/reject response (`connection.js`), so the model keeps
  improving as you use the console instead of only updating on restart.
- `learnedFloor()` searches for the confidence score at which the model predicts ≥70% accept
  probability, holding margin/input-length at "typical" values — **the typical values used are
  the mean margin/input-length among the model's own accepted training examples, not a hardcoded
  guess.** Verified live during testing: an earlier version used fixed guessed constants (margin
  0.08) for this and it silently pinned the recommended floor at the search ceiling (0.95)
  whenever the real accepted-example margins ran higher than that guess — the fix was to derive
  those "typical" values from the training data itself, verified against both noisy and cleanly-
  separated synthetic telemetry before this was considered working.
- Visibility without needing to interrupt anything: `telemetry review` now reports whether the
  model is trained, its sample count, and last-updated time, so it can be checked on demand
  without ever requiring approval to operate in the first place.
- This is explicitly "Stage 1" of a larger, deliberately-staged ML plan discussed with the user —
  further stages (a trained text classifier beyond `nlpEngine.js`, fine-tuned embeddings, RL-style
  bandits, session clustering) were assessed and shelved as not worth building yet: this app has
  too little usage volume for them to have enough data, and several need Python/GPU tooling this
  Node-only, CPU-only project doesn't have. Revisit only if usage volume grows substantially.

## Safety model — don't weaken this without discussing it first

- AI mode is off by default. The AI ON/OFF toggle in the terminal header is the **sole** opt-in
  gesture — flipping it on sends every subsequent message in that session straight to Ollama, no
  per-query re-confirmation (the old `consent_request` double-gate was removed as pure friction).
- `writeFile`, `editFile`, `insertAtLine`, `appendToFile`, and any `executeCommand` with
  `risky: true` from the AI path require explicit user approval (`tool_confirm_prompt` → user
  clicks Approve/Reject) before they run — the model cannot self-approve. See `resolveToolGate()`
  in `server/tools.js`. The ONLY exceptions are the Phase 5 session grants: the "Approve +
  auto-approve file edits this conversation" button pre-approves the four non-risky file tools for
  that project + session, and a `console.tools.json` `permissions` policy of
  `allow-after-first-ask` records a grant after the first manual approval. **Neither mechanism can
  ever auto-approve `risky: true` `executeCommand`, `runTests`, or `stopProcess`** —
  `ALWAYS_CONFIRM_TOOLS` + the `executeCommand` parse-time coercion enforce that. `saveMemory` is
  the one tool with conditional gating — see "Persistent cross-session AI memory" above — approval
  is required only when the model itself flags a save as `importance: 'judgment'`, not for routine
  low-stakes saves.
- **Trigger mode (2026-07-28) can now also create/append files without AI mode or Ollama at
  all** — "create a file called X with the text '...'" / "append to X the text '...'" /
  "read file X" in `builtinIntents.js` parse the filename + quoted content directly with regex
  (deliberately conservative: asks instead of guessing if either piece is missing) and call the
  same sandboxed `tools.js` functions the AI path uses. Writes/appends still go through the exact
  same confirm-before-execute flow as every risky shell command (`queueFileOpConfirmation` →
  `pending.fileOp` branch in `connection.js`'s `handleConfirmResponse`) — reads are unguarded
  since they're non-destructive. This only covers unambiguous, explicitly-quoted content; anything
  open-ended still needs AI mode.
- File tools cannot resolve outside the active project's directory.
- Server binds to `127.0.0.1` by default (`HOST=0.0.0.0` env var to change — this server executes
  shell commands with no auth, so don't do that on an untrusted network).
- `git status --short` / checkpoint commits guard risky manual commands the same way.

## Matching pipeline gotchas

- **Semantic matcher modularization (2026-08-04, 5 commits: `497e9df` → `9a88785`).**
  `server/semanticMatcher.js` was 762 lines; it is now ~448 lines of pure orchestration (init,
  fuse maintenance, project sync, `match()` dispatching to the stage runners, `matchMulti`,
  `getSuggestions`, `nearestIntent`, `bestProjectCommandEntry`, `findIntentCollisions`). The
  logic moved out with **zero behavior change** — telemetry stage entries and per-rule
  confidences are byte-identical, guarded by a new real-embedding regression harness
  (`npm run check-matcher` → `server/scripts/checkMatcherCoverage.js`): 68 inputs across 9
  batteries (CONTROL/PHASE1-3/BASICS/MATCHDAY/TRAPS/MUST_NOT_STEAL/GARBAGE), self-asserting
  `{input, expect}` pairs, `--probe` mode to print routing without asserts when an intent
  intentionally changes. Run it after ANY matcher edit. New module map:
  - `server/preSemanticOverrides.js` — stage 0 data + `findPreSemanticOverride()` (the 7
    confirmed-trap literal rules; the old inline array in `semanticMatcher.js`'s `match()`).
  - `server/keywordRules.js` — stage 3 data + `matchKeywordRule()` (the 28-rule keyword
    fallback chain, first-match-wins, in original if-chain order; rule shape
    `{ intent, confidence, re?, and?, or?, orLength?, notRe?, maxLength? }`).
  - `server/matcherStages.js` — `runSemanticStage()` (embedding scan + per-intent effective
    floor + 0.03 margin + collision/closeSecond second-pass, returns `{ result, stage }`) and
    `runFuzzyStage()` (Fuse search + length-scaled fuzzy floor, project meta reconstruction).
  - `server/intentVectorScan.js` — pure vector machinery: `cosineSimilarity`,
    `scanAllVectors` (the dual project-then-base scan shared by `match()`/`nearestIntent()`),
    `bestProjectActionVector` (stage-1b config-entry scan), `averageIntentVectors`
    (collision check).
  Also in the same session: commit `497e9df` fixed reloaded sessions rendering persisted
  command output as a plain bubble instead of the collapsible `OutputBlock` — the persisted
  `Executing: ...`-prefixed bot message now maps back to type `'output'` in
  `src/utils/storedToTerminalMessages.ts`. Verified: `npm run check-matcher` 68/68,
  `tsc --noEmit` clean, `npm run check-intents` at baseline (1/5/80, all pre-existing).
- Trigger mode (AI off) is a pure dispatcher — it can only answer with what's canned in
  `builtinIntents.js` or a project's `console.config.json`. It will never handle open-ended
  requests — that's what AI mode's tools are for. Don't expect trigger mode to "figure things out."
- `matcher.js` no-match paths now return real suggestions via `semanticMatcher.getSuggestions()`
  (Fuse.js fuzzy search over all intent/trigger phrases), falling back to a fixed curated list
  (`FALLBACK_SUGGESTIONS`) only if Fuse finds nothing at all — chips are never empty anymore.
  `connection.js` always sends the informative fallback `answer` text before `suggestions`, since
  the frontend attaches suggestion chips to the *previous* chat bubble.
- `system.chit_chat.deploy`: "deploy"/"push live"/"commit and push" routes through the existing
  risky-confirmation flow — checkpoint already does `git add -A && commit`, so the confirmed
  command is just `git push`.
- `semanticMatcher.js` confidence floor is 0.6 with a 0.03 runner-up margin for the *semantic*
  (embedding) sub-stage only — short technical phrases sharing one keyword (e.g. "initialize git"
  vs "check git") can score deceptively high on pure cosine similarity. This was previously
  "reasoned through, not empirically tested" — it has now been **confirmed live**: real user
  testing against tobi-portfolio showed "initialize git" and "deploy to my git" both resolving to
  `system.chit_chat.git_status` instead of `git_init`/`system.chit_chat.deploy`, and "add
  node_modules/ to gitignore" resolving to a generic tech-preview response instead of
  `git_ignore_add`. Fixed via `PRE_SEMANTIC_OVERRIDES` in `semanticMatcher.js`'s `match()` — a
  short, deliberately narrow list of literal patterns (`git init`, `gitignore`, `deploy`/`push
  live`) checked *before* the embedding stage ever runs, since these tokens are unambiguous enough
  in this app's domain to always win outright. Keep this list short; it's a targeted fix for
  confirmed traps, not a general reordering of the pipeline. If you find more confirmed
  misclassifications like this, add them here rather than retuning the floor blindly.
- **Confirmed live 2026-07-28, two more `PRE_SEMANTIC_OVERRIDES` traps found from real exported
  chat transcripts**: (1) "add a file" / "can you help me add a file" (tobi-portfolio, no
  filename, no git context) resolved to `git_add` instead of `file_create` both times it was
  tried — added an override requiring an add/create/make/write/generate verb + "file" with *no*
  git-context word anywhere in the input, so "add files to git" / "stage all files" still resolve
  to `git_add` normally. (2) "Can I attach the github link" (Project console) had no matching
  intent at all — there was no way to set a git remote — and fell through to an unrelated generic
  help response. Added a real `git_remote_add` intent + handler in `builtinIntents.js`: parses a
  URL out of the input (asks for one if missing), then confirms `git remote add origin <url> ||
  git remote set-url origin <url>` (works whether "origin" already exists or not).
- **Confirmed live 2026-07-28: "push the site with the comment 'bug fixes'" silently dropped the
  comment.** `git_push` and `system.chit_chat.deploy` have heavily overlapping example phrases
  (both full of "push ..." variants), and only `deploy`'s handler parsed a `with the comment/
  message "..."` clause — the plain `git_push` branch always pushed bare. When a "push ..." input
  happened to match `git_push` instead of `deploy`, the user's comment vanished with no error.
  Fixed by parsing the same comment clause in the `git_push` branch too, so the outcome no longer
  depends on which of the two intents wins the match.
- `semanticMatcher.match()` internally runs 3 sub-stages (semantic → fuzzy → keyword), each
  self-gated against its own floor before returning. `matcher.js` used to re-apply the semantic
  0.6 floor to *every* returned result regardless of source — since keyword-tier confidences are
  hardcoded at 0.4-0.55, this silently made the entire keyword fallback list unreachable (e.g.
  "run dev" could never resolve to `run_project` and fell through to `commandGuesser`'s naive
  guess instead, which doesn't check `package.json` scripts first). Fixed: `matcher.js` now only
  gates `source === 'semantic'` results against `getEffectiveThreshold()`; fuzzy/keyword results
  are trusted as-is. If you touch this again, keep that source check.
- Fuse.js `threshold` in `semanticMatcher.js`'s constructor is 0.55 (was 0.4 — too strict to let
  single-edit typos like "hep"→"help" past Fuse's own internal cutoff before the code's own
  `fuzzyFloor` check even runs).
- `server/ollama.js` `NUM_CTX` is 16384 (env override: `OLLAMA_NUM_CTX`) since the system prompt
  now includes CLAUDE.md content + entry-point snippets.
- **Confirmed live 2026-07-29 (real testing after the router tier shipped): garbled/malformed
  input landed on `system.chit_chat.gratitude`.** Two different broken follow-ups ("Call it
  jimmyjagz.md with tex :- \"" and the same with quoted text added) both got the canned "You're
  welcome!" reply — neither has anything to do with thanks. Root cause is almost certainly
  `nlpEngine`'s trained classifier (stage 2 of `matcher.js`, this file's own documented "legacy
  fallback") — it's gated only by a flat `score >= 0.45` with no margin check (unlike the semantic
  stage's floor+margin gate), the classic failure mode for a small trained classifier on
  out-of-distribution input (see this doc's own "Research findings" on why Rasa-style classifiers
  keep needing special cases). Fixed defensively rather than by tuning the classifier itself:
  `matcher.js` now has `PURE_CHITCHAT_INTENTS` (greeting/status/gratitude/clear/yes_no — all
  zero-argument, always-"safe-sounding" canned replies) and `looksLikeRealRequest(input)` (true if
  the input has a file extension or a quote character). Any stage's result — semantic, nlp, or the
  router — is treated as *not a match* if it's a pure-chitchat intent and the input looks like a
  real request, so it falls through to the next stage instead of returning a confident-looking
  wrong answer. Narrower and cheaper than trying to fix the underlying classifier.
- **Local router tier (2026-07-29, `LOCAL_ROUTER_UPGRADE_PROMPT.md` phase 1):** `matcher.js` now
  has a stage 4 between the semantic/NLP/fuzzy pipeline and the plain suggestion-chip fallback —
  one bounded, non-streaming Ollama call (`server/localRouter.js`'s `routeViaLocalModel()`, via
  the new `chatOnce()` in `server/ollama.js`) that classifies novel phrasings into one of
  `BUILTIN_INTENTS` instead of giving up. Low `num_predict`, temperature 0, 7s timeout; any
  failure/timeout/low-confidence/unknown-intent result returns `null` and falls through to
  exactly today's existing behavior (`commandGuesser` → suggestions) — zero regression when
  Ollama is off. `connection.js` passes `sessionContext.aiModel` through so it uses whatever model
  the user already picked, independent of the `aiEnabled` toggle. A router hit dispatches through
  the same `handleBuiltinIntent()` every other stage uses (it only decides *which* intent fired,
  never bypasses the confirm-before-write flow) and is logged as a near-miss with `source:
  'router'`. Found and fixed a real bug while wiring this: `BUILTIN_INTENTS` was missing
  `file_append`, `file_read`, and `git_remote_add` — despite real handlers existing for all three
  and `git_remote_add` having a dedicated `PRE_SEMANTIC_OVERRIDES` literal-keyword hit, any match
  on those three intents from *any* stage (not just the new router) silently died at this Set's
  gate and fell through to the generic fallback. The "attach the github link" fix documented below
  was therefore not actually reachable end-to-end until this fix.

## Ollama Cloud (online fallback)

- `server/ollama.js` `listCloudModels()` returns a curated list of `:cloud`-suffixed models
  (`CLOUD_MODELS` const) merged with any cloud models already visible via local `/api/tags`.
  These run on Ollama's own GPUs but go through the *same* local daemon and `/api/chat` endpoint
  as local models — no separate API key/provider integration, just `ollama signin` + internet.
  `GET /api/ollama/status` now also returns `cloudModels` and `internetReachable`.
- Frontend: the model `<select>` in `Terminal.tsx` groups Local vs. 🌐 Ollama Cloud via
  `<optgroup>`; picking a cloud model is the same `ai_set_model` WS message as any other model —
  `aiQuery.js`/`connection.js` don't validate the model name, so no backend plumbing was needed.
  `useAI.ts`'s "does the current model still exist" check (on AI-toggle-on) now also checks
  `cloudModels`, so it won't silently bounce a chosen cloud model back to a local one.
- If a cloud call fails, `aiQuery.js` appends a hint to run `ollama signin` when `model` ends in
  `:cloud`, instead of surfacing a bare HTTP status.
- `useAI.ts` `handleAIToggle()` detection order on AI-ON: internet reachable + cloud models
  available → prefer cloud as the default; else fall back to local; else fail with a message
  telling the user why (pull a local model, or get online + `ollama signin`). This only decides
  the *default* — the model `<select>` always lets the user override to the other source
  afterward, and an already-valid explicit choice (local or cloud) is never silently overridden
  on a later toggle. Both paths still require the local `ollama serve` daemon to be reachable
  (`status.running`) since Cloud proxies through it — that check happens before either branch.

## shadcn/Tailwind/TS setup

- `@/*` resolves to `./src/*` (tsconfig `paths` + a matching Vite `resolve.alias` — tsconfig
  alone only affects type-checking, Vite needs its own alias to resolve `@/...` at build/dev
  time). `components.json` documents the shadcn CLI config (Tailwind v4 CSS-first, so
  `tailwind.config` is empty — theme lives in `src/index.css`'s `@theme` block).
- `src/lib/utils.ts` `cn()` is the real shadcn convention (`twMerge(clsx(inputs))`), not bare
  `clsx()` — `tailwind-merge` was already a dependency but previously unused.
- `src/components/ui/` holds shadcn-style primitives (`textarea.tsx` so far) plus
  `v0-ai-chat.tsx` (a styled chat-input component, wired to a real `onSend` callback — not yet
  used anywhere in the app; available for a future input-bar redesign).
- `--color-input` / `--color-muted-foreground` were added to `@theme` in `index.css` — shadcn
  component classes (`border-input`, `placeholder:text-muted-foreground`) need them and they
  didn't exist before.

## Session ↔ project linking

- Every session is permanently tied to the project it was created for (`session.projectId`).
  `connection.js`'s `handleExecute` rejects any message sent against a *different* active project
  than the one a session is linked to (`"Session is locked to ... "` error) — this is deliberate,
  not a bug: it stops a chat from silently executing against the wrong project's files.
- **Session titles are not a reliable indicator of the linked project.** `conversationStore.js`
  auto-renames a session to the first ~60 chars of its first user message (as long as the title
  hasn't been customized yet) — so a chat linked to Project A can end up *titled* like it's about
  Project B just because of what you happened to type first in it. Always trust `projectName`
  (shown as a small subtitle under the chat title in the sidebar list in `SidebarDrawer.tsx`), never the title
  string, when figuring out which project a chat belongs to.
- Clicking a project card in the grid (`handleSelectProject` in `useConsole.ts`) always creates a
  **new** session scoped to that project — it deliberately does not relink whatever chat happened
  to be open (that used to be the behavior, via `linkSessionToProject`, and was the actual root
  cause of the title/project mismatch above: selecting a different project silently reassigned
  the currently-open chat's `projectId`). `linkSessionToProject` still exists in `useSessions.ts`
  for any future explicit "move this chat to a different project" feature, but nothing calls it
  today.

## Self-learning (4 layers) — improvements 2026-07-28

All four layers now run at least partly unattended instead of requiring a manual review command:

- **Layer 1 (near-miss → `learningEngine.js`)**: added `autoApplySuggestions()` /
  `autoApplySuggestionsForAll()`, called on server startup in `index.js` right alongside the
  existing `autoApplyThresholdsForAll()` call. Any near-miss pattern already at `confidence:
  'high'` (5+ occurrences, ≥80% acceptance) is promoted into a real intent example automatically
  — no more waiting on `review learning` + `approve suggestions` for patterns the engine is
  already sure about. Lower-confidence suggestions still require manual review as before.
- **Cross-project persistence**: `INTENTS` (from `intentsData.js`) is a single module-level
  object shared by the whole Node process, not per-project — so `applySuggestions()` promoting a
  phrase in one project's near-miss log was already generalizing to every other project
  immediately, in memory. The real gap was that this mutation was never written to disk, so a
  server restart silently forgot everything ever learned, everywhere, at once. New
  `server/learnedIntents.js`: `loadLearnedIntents()` merges `data/learned-intents.json` into
  `INTENTS` before `semanticMatcher.initialize()` builds its embeddings (called in `index.js`),
  and `persistLearnedPhrases()` (called from `applySuggestions()`) writes newly-applied phrases
  back to that file so they survive restarts.
- **Distillation noise cleanup** (`distillation.js`): removed the `file_pattern` suggestion type
  entirely — it was logged on every `writeFile`/`editFile` but never applied to anything ("just
  logged for now" per its own old comment), and is now fully covered by the Layer 4 file-edit-
  frequency nudge below. Also de-duped `knowledge_entry` suggestions (re-reading the same file
  across sessions no longer logs a duplicate pending record for the same trigger) and added
  `pruneStalePending()`, which drops pending records older than 30 days on each
  `analyzeAIExchange()` call so the `.jsonl` log doesn't grow unbounded.
- **Adaptive thresholds** (`projectMemory.js`): `QUESTION_THRESHOLD`/`COMMAND_THRESHOLD`/
  `FILE_EDIT_THRESHOLD` were fixed constants (3/20/10) applied identically to every project
  regardless of how active it is. New `adaptiveThreshold(base, totalActivity)` scales them down
  for quiet/new projects (<15 total tracked events — surface patterns sooner) and up for heavily
  used ones (>150 — raise the bar so routine high-volume activity doesn't spam a nudge).

- **Confirmed live 2026-07-29: committing ~160 new files in one go flooded the chat with 159
  separate "LF will be replaced by CRLF" bubbles.** `server/executor.js` forwarded every raw
  `stdout`/`stderr` `data` event to the client the instant it arrived, with no buffering at all —
  git writes one of these informational (not error) warnings per file the first time each is
  committed under the active `core.autocrlf` setting, and each one became its own chat bubble.
  Fixed two ways: (1) `createBufferedSender()` coalesces rapid bursts of output into one flushed
  message every 150ms instead of one message per OS-level `data` chunk — general-purpose, helps
  any noisy command, not just this one; (2) `collapseLfCrlfWarnings()` specifically collapses
  repeated per-file LF/CRLF warnings into a single summary line (any real error text alongside
  them is left untouched). Live URL detection for dev-server commands still runs on the raw
  unbuffered stream — only what's *shown* to the user is batched/collapsed, not the detection
  logic that decides when to auto-detach.
- **Command output summarizer (2026-07-29, requested directly):** `server/outputSummarizer.js`'s
  `summarizeCommandOutput()` runs once a command's process closes (wired into `executor.js`'s
  `close` handler, sent as an extra `answer` message right before `end`) and appends a short
  "what actually happened" callout — exit code, recognized error/`npm ERR!`/TS-error lines
  (capped at 5, with a "...and N more" tail), npm's `added/removed N packages` and vulnerability
  lines, git commit/push/conflict/rejected-push lines, and the LF/CRLF warning count. Pure
  regex/heuristics, no LLM call, so it works the same with Ollama off — same hard constraint as
  the router tier. Returns `null` (sends nothing extra) for short output (under ~8 lines / 400
  chars) or when nothing worth flagging was found, so it never duplicates output that's already
  easy to read as-is. Caught a real bug before shipping: a trailing `\b` after `ERR!` never
  matches, because `!` is a non-word character and `\b` needs a word/non-word transition that
  never happens right after it — `npm ERR!` lines were silently invisible to the "errors noticed"
  list until the regex was rewritten as a bare `ERR!` alternative with no trailing boundary.

- **Dev-server-port-collides-with-console's-own-port warning (2026-07-29, confirmed live):**
  SportSim Pro's `package.json` dev script (`vite --port=3000 --host=0.0.0.0`) happens to use the
  exact same port the console itself defaults to. Asking "what is the link" then returns
  `http://localhost:3000` — which is indistinguishable from the console app the user is already
  looking at, so it read as "it returned the site link as the link it is running itself." Not a
  bug in the URL detection (`state.lastDevUrls` was genuinely set correctly) — the two processes
  just happen to share a port number. Added `state.serverPort` (set once in `index.js` after the
  `PORT..PORT+10` fallback loop actually binds) and `isSamePortAsConsole()`/
  `withPortCollisionWarning()` in `state.js`; both the "what is the link" answer in
  `connection.js` and the dev-server detach message in `executor.js` now append a heads-up when
  the detected dev URL's port matches the console's own. Doesn't fix the underlying port clash
  (that's the project's own dev script config, outside this app's control) — just prevents the
  silent confusion.

- **Port-in-use handling for dev servers (2026-07-29, requested directly):** two failure shapes
  previously had no handling at all. (1) Interactive prompts (CRA/`react-scripts`' "Would you
  like to run the app on another port instead? (Y/n)") used to hang forever — `executeCommand`
  spawned with `stdio: ['ignore', ...]`, so there was no way to ever answer. Now stdin is
  `'pipe'`; `executor.js`'s `PORT_PROMPT_RE` detects the prompt, cancels the dev-server force-
  detach timer (so "Dev server is running" doesn't fire while it's actually just stuck waiting),
  and sends a normal `confirm_prompt` — approving/declining writes `Y\n`/`n\n` into the running
  child's stdin via a new `pending.stdinWrite` branch in `connection.js`'s
  `handleConfirmResponse` (looked up through the existing `runningProcesses` map; no new command
  is ever run without the user approving it, same as everywhere else). (2) Hard failures
  (`EADDRINUSE`, no auto-retry — e.g. a plain Node/Express server) now get detected on process
  exit (`extractBusyPort`) and offered a one-click retry on the next port
  (`buildPortRetryCommand` — increments an existing `--port=N` flag if present, matching this
  project's own confirmed-live Vite case, else falls back to a `PORT=N`/`set PORT=N&&` env-var
  prefix), routed through the exact same `pendingConfirmations` + `confirm_prompt` flow as any
  other command. Caught a real bug before shipping: `tools.js`'s `isCommandAllowed()` extracts the
  first whitespace token as "the executable" and checks it against a small allowlist —
  `PORT=3001 npm run dev` would have been rejected outright since `PORT=3001` isn't `npm`. Fixed
  by stripping one leading env-var-assignment prefix (POSIX or Windows `set ... &&` style) before
  that check, verified against both prefix styles plus a "still correctly blocks a dangerous
  command even with a fake env prefix in front" case. Vite's own default auto-increment-and-report
  behavior needed no new handling — the existing URL detection already captures whatever port it
  actually lands on.
- **Trigger-mode busy indicator (2026-07-29, requested directly):** `aiThinking` only ever gets
  set by AI mode's own `ai_start` event, so trigger-mode round trips (most of what runs with AI
  off) had no "still working" indicator at all — confirmed live as the reason a slow-starting dev
  server command read as unresponsive. Added a separate `commandPending` state
  (`useConsole.ts`), set true when a trigger-mode message is sent (skipped when AI mode is on,
  since that already has its own indicator) and cleared on `end`/`confirm_prompt`/`error_output`/
  `clear_console` — deliberately NOT cleared on `start`/`output` alone, since a still-booting dev
  server keeps emitting those without actually being done. Renders as the same spinner style as
  `aiThinking` in `Terminal.tsx`, plus disables/relabels the plain (AI-off) input while pending.

- **`git_init` and `file_create` now guard against clobbering something already there
  (2026-07-29, requested directly):** `git_init` used to offer to run `git init` unconditionally
  — every other git-setup intent here (`git_push`/`git_commit`/`deploy`) already checks
  `isGitRepo()` in the *other* direction (telling the user to init first if there's no repo yet),
  but this was the one path that never checked whether a repo already existed. Harmless in
  practice (`git init` on an existing repo just reinitializes in place), but there's no reason to
  even offer the prompt for a no-op — now short-circuits with "already a git repository" instead.
  Separately, `file_create`'s confirm prompt used to say the same generic "Write X (N chars)"
  whether the target file was new or about to be silently replaced — now checks first and shows
  an explicit "⚠️ Overwrite existing ..." summary when something's already there.

- **CLI chat mode ("Could not connect to server") fixed (2026-07-29, confirmed live):** two
  compounding bugs. (1) `server/cli-client.js`'s `fetchProjects()` made exactly one `fetch()`
  attempt and gave up instantly on any failure — no retry at all, so it lost any race against the
  server still finishing startup (route registration, Vite middleware, semanticMatcher's
  embedding model load all take real time). (2) Both `cli-client.js` and `start.bat` hardcoded
  port 3000 with no awareness of `server/index.js`'s own PORT..PORT+9 fallback — if anything else
  already had 3000 (a stale console instance, another project's dev server — see the port-
  collision warning above, a real recurring scenario this session), the real server could be on
  3001+ with no way for the CLI client to find it. Fixed: `cli-client.js` now has
  `discoverServer()` — scans ports `BASE_PORT..BASE_PORT+9` each pass, retries for up to 20s,
  reports which port it actually connected on if it wasn't the default. `start.bat`'s `:CLI_MODE`
  dropped its `netstat`-based "is *a* process on this port" wait loop (which couldn't tell if the
  process was ready, or the right one) in favor of just handing off to `cli-client.js` directly,
  since it now does both waiting and port discovery properly itself. Verified the retry/port-scan
  logic against a mock server that intentionally refused connections for ~1.2s and then only
  answered on port 3002 (not the default 3000) — found and connected correctly.

- **`langs.includes('Python')` never matched anything, anywhere (2026-07-29, confirmed live via
  NetPulse, a real Flask project):** `codebaseIndexer.js`'s `detectLanguages()` always formats
  each entry as `"Python (4 files)"` — never the bare language name — so the exact-match
  `.includes('Python')` (and `'JavaScript'`/`'TypeScript'`) checks in `projectTypeSuggestions()`
  (`builtinIntents.js`, used by both `run_project` and `npm_run`'s fallback) and the "where is the
  link" no-dev-server-detected branch (`connection.js`) could never be true for *any* project.
  Silently broke the whole Python/JS-project-type branch for everyone — "run the site" on a
  Python project always fell through to a generic "Entry point: main.py. Try:" suggestion instead
  of "This appears to be a Python project... `python main.py`". Fixed both call sites with
  `langs.some(l => l.startsWith('Python'))`-style matching instead of an exact `.includes()`.

- **AI query cancellation (2026-07-29, requested directly after a 5+ minute hang with no way
  out):** CPU-only Ollama inference has no built-in upper bound, and `handleAIQuery` previously
  had no timeout or cancel path at all. `aiQuery.js` now creates an `AbortController` per query,
  stashed on `sessionContext.aiAbortController`; `aiStream.js`'s `streamWithToolDetection`/
  `streamPlain` thread the signal into `ollama.js`'s `chatStream()` (which already accepted one).
  A new `'cancel'` WS case in `connection.js` aborts it (and separately kills any running
  trigger-mode shell command via the existing `runningProcesses` map) — deliberately doesn't send
  its own `answer`/`end`, since the aborted request's own `AbortError` branch (or the killed
  process's own `close` handler) sends that once the abort actually propagates, avoiding a
  double message. Frontend: a small "Stop" button next to both the `aiThinking` and
  `commandPending` busy indicators in `Terminal.tsx`, wired through `handleCancel` in
  `useConsole.ts`. Scope note: the router tier's own bounded Ollama call (max 8s) was
  deliberately left out of this — it's already short enough not to need a cancel path.

## Folder picker, CLI picker, and "what port" fixes (2026-07-30, reported directly)

- **The web UI's "Browse for folder" showing a folder-name-only path, and a "can't open this
  folder — it contains system files" dialog, are both hard browser restrictions, not bugs.**
  `showDirectoryPicker()`/`<input webkitdirectory>` can never hand a plain (non-Electron) web page
  an absolute filesystem path — only a folder name — by design (see `App.tsx`'s
  `handleBrowseFolder`/`handleFolderPick` comments). `projectRoutes.js`'s `resolveScanTarget()`
  already compensates by searching the current scan directory + its parent for a matching folder
  name, but that only ever finds a *sibling* of what's currently scanned — a folder anywhere else
  needs its full absolute path pasted into the scan box directly (the UI already surfaces this in
  the button's title text and in the error message). The "system files" dialog is Chrome's own
  picker refusing certain protected/reparse-point folders (e.g. some OneDrive-synced or top-level
  user folders) before the page ever sees anything — not something this app's code can catch or
  override. No code change possible here beyond what already exists; if this keeps confusing
  people, consider replacing Browse with paste-only and removing the button entirely.
- **Fixed 2026-07-30 (raised directly — "if I point this at someone else's folder, or one with
  none of these files, recognition will fail"): project discovery no longer requires config/docs/
  package.json.** `projectScanner.js`'s `discoverProjects()`/`scanSingleProject()` still check
  `console.config.json`, `CONTEXT_FILENAMES` (CLAUDE.md/README.md/ABOUT-TOBI.md/
  UNIVERSAL_CONTEXT.md), and `package.json` first as before, but a folder with none of those three
  is no longer automatically invisible. New `isRecognizableByCodeAlone()` runs the same
  `codebaseIndex` every included project already gets and recognizes a folder if it has actual
  source files the language detector knows (now covers Go/Rust/Java/Ruby/PHP/C# too, not just
  JS/Python — see codebaseIndexer.js below), a key config file (`Cargo.toml`/`go.mod`/
  `requirements.txt`/etc.), or a real `.git` directory. A project recognized only this way gets a
  synthesized minimal config (`buildFallbackConfig()`) with one `answer`-type entry ("what is this
  project") summarizing detected languages/stack/entry points, so it isn't left silently empty —
  note the field is `response`, not `answer` (mismatching this once is exactly the bug
  `matchedEntry.js`'s `handleMatchedEntry` would hit: it reads `entry.response`). This only affects
  *discovery* — a project that's `git`-only with no `package.json`/docs still won't have any
  runnable command entries beyond what the user or AI mode adds later.
- **Structure-scanning quality widened alongside the above (2026-07-30, requested directly —
  "deep semantic understanding... implement some things to it").** `codebaseIndexer.js`'s repo map
  (regex-based export/function/class extraction) and entry-point detection were JS/TS/Python-only;
  both now also cover Go, Rust, Java, Ruby, PHP, and C# (new `SIGNATURE_PATTERNS_BY_EXT` lookup +
  wider `ENTRY_NAMES`/`CODE_EXTS`). Two additions beyond just "more languages": (1) `extractImports()`
  pulls each file's own `import`/`require`/`from X import` specifiers (local/relative ones sorted
  first, capped at 8) so the repo map shows a sliver of real cross-file dependency information —
  `formatRepoMap()` now renders `path: sigA, sigB [imports: ../state.js, ./foo]` instead of a flat,
  disconnected per-file list. (2) `detectFrameworks()` reads already-cached `keyFiles` (package.json
  deps, requirements.txt/pyproject.toml) against a static name→label map (React, Express, Flask,
  Django, Vite, Prisma, etc.) and surfaces the result as `idx.frameworks`, now injected into both
  the fallback-recognition summary above and `ollamaContext.js`'s AI system prompt. New
  `hasGitRepo()` (exported, also used by the recognition fallback) and `idx.hasGit` on every index.
  Still no real AST/parser — this is deliberately more regex heuristics, tuned for coverage and
  cheapness, not a dependency-graph engine.
- **CLI picker silently defaulted to `projects[0]` on ANY invalid input, with zero feedback —
  confirmed live via a real transcript where a stray chat message typed before the picker was
  answered, and later a mistyped project number ("1100"), both got silently mapped to a project
  the user never chose.** `cli-client.js`'s `selectProject()` now loops and re-asks on anything
  that isn't an in-range integer, printing what was rejected and why, instead of ever guessing.
  Also added `--dir "<full path>"` / `--project "<name>"` CLI args (`findProjectFromArgs()`) so the
  interactive picker can be skipped entirely and the client jumps straight to a known project —
  matched against the same project list the server's own discovery already returned, never
  reimplemented client-side.
- **"What port are you running on" had no real intent and fell through to a generic chit-chat
  status reply that never actually named a port**, even though `state.serverPort` (added earlier
  for the dev-server port-collision warning) already holds the real value. Added a real
  `system.chit_chat.port` intent (`intentsData.js` + `BUILTIN_INTENTS` in `matcher.js` — the same
  gate that's bitten missing intents before, see `git_remote_add`/`project_list` above — + a
  handler in `builtinIntents.js`) that answers with the actual console port, and points at "what is
  the link" for the project's own dev-server URL instead. Requires a server restart (or a live
  `semanticMatcher.initialize()` re-run) to pick up the new example phrases — not yet verified live
  since no Ollama/npm session was available in this sandbox; re-check with a real "what port are
  you running on" after restarting `npm run dev`.

## Deeper structural understanding + trigger-mode README parsing (2026-07-30, requested directly)

Follow-up to the recognition/scanning work above — six concrete additions, all still regex/API-
based (no AI call, no new hard dependency beyond one already-present devDependency promoted to a
real dependency):

- **Trigger-mode (no AI) can now read a project's own README/CLAUDE.md for the real run command.**
  New `server/readmeRunParser.js`'s `findDocumentedRunCommand()` looks for an Install/Usage/Getting
  Started/Run-labeled section (or, failing that, any fenced code block in the doc at all) and
  matches it against a closed list of known run-command shapes (`npm run`, `cargo run`, `go run`,
  Maven/Gradle, `dotnet run`, `bundle exec`, `php artisan serve`, `flask run`, `python manage.py
  runserver`, etc.). `projectTypeSuggestions()` (`builtinIntents.js`) now calls this FIRST, before
  any language-based guessing, and a new purely-informational intent `project.knowledge.how_to_run`
  ("how do I run this", "what's the setup process", ~90 example phrases in `intentsData.js`) answers
  with exactly what was found and where — never silently guessing without saying whether the
  answer came from the README or from language detection. AI mode already did the equivalent of
  this generically via its own tool loop (see `ollamaContext.js`'s `executeCommand` instructions) —
  this is what gives *trigger mode* (Ollama fully off) the same "read the docs first" behavior.
  The Python run-command patterns accept an optional interpreter path prefix (`[\w.:\\\/-]*`) so
  venv-style invocations (`venv\Scripts\python.exe main.py serve`) are recognized exactly like
  bare `python main.py ...` — fixed 2026-08-03, confirmed live against NetPulse's venv-based
  README/CLAUDE.md (both docs use `venv\Scripts\python.exe ...` now; before the fix
  `findDocumentedRunCommand()` returned `null` for them).
- **Trigger-mode run-command guessing extended to Go/Rust/Java/Ruby/PHP/C#** (previously
  Python/JS-only — anything else fell into a generic `start <entrypoint>` suggestion that's
  actively wrong for compiled languages, e.g. `start main.go` just opens the file in a text
  editor). `projectTypeSuggestions()` now checks real project markers (`go.mod`, `Cargo.toml`,
  `pom.xml`/`build.gradle`, `Gemfile`, `composer.json`, `Program.cs`) before suggesting
  `cargo run`, `go run .`, `mvn spring-boot:run`/`./gradlew bootRun`, `bundle exec rails server`,
  `php artisan serve`, `dotnet run`, etc. — same "check a real marker, don't guess from language
  file count alone" spirit as the existing Python branch. `codebaseIndexer.js`'s `KEY_FILES` was
  missing `pom.xml`/`build.gradle`/`build.gradle.kts` entirely before this — Maven/Gradle projects
  had an always-empty `keyFiles`, so this was a real gap, not just missing guess logic.
  `run_project`'s example phrases in `intentsData.js` were also widened (~55 new phrases) to cover
  imperative "run this X project" phrasing per language, alongside the ~90 informational
  `project.knowledge.how_to_run` phrases above (~145 new examples combined). **Not yet verified
  live** — no working Ollama/npm session was available in the sandbox this was built in (VM
  failed to start), so this is based on static reading of `matcher.js`'s dispatch stages, not a
  real run through the semantic matcher. Both new intents were added to `matcher.js`'s
  `BUILTIN_INTENTS` Set (miss this and the intent is unreachable no matter how good its examples
  are — see the `git_remote_add`/`project_list` history above for exactly this failure mode).
- **Reverse dependency index + API route map.** `codebaseIndexer.js`'s repo map already had a
  per-file "what does this file import" list (previous session); it now also resolves local/
  relative imports back to the actual file they point at and attaches the inverse — each entry can
  show both "imports: X" and "used by: Y" (`buildReverseImportIndex()`/`resolveLocalImport()`).
  Separately, `extractRoutes()` regex-matches Express (`app.get/post/...`), Flask (`@app.route`),
  FastAPI (`@app.get/...`), and Django (`path(...)` inside `urls.py`/anything mentioning
  `urlpatterns`) route declarations into `idx.apiRoutes`, rendered via new `formatApiRoutes()` and
  injected into the AI system prompt (`ollamaContext.js`) as a "what does this app expose over
  HTTP" surface map — a different and often more directly useful kind of structural understanding
  than a flat export list.
- **Monorepo detection.** `detectSubPackages()` groups manifest files (`package.json`,
  `pyproject.toml`, `Cargo.toml`, `pom.xml`, etc.) by containing directory; more than one such
  directory sets `idx.isMonorepo`/`idx.subPackages`, surfaced both in the AI system prompt (with an
  explicit "treat each as its own independently-runnable package" instruction) and in
  `projectScanner.js`'s code-only-recognition fallback summary.
- **Real parser for JS/TS/TSX signature extraction**, replacing regex as the primary path for
  those extensions specifically (Go/Rust/Java/Ruby/PHP/C#/Python are still regex-only — a real
  parser for those would need either a much heavier dependency or shelling out to a language
  runtime this Node-only project doesn't otherwise need, so this was scoped to JS/TS only). Uses
  the `typescript` package's compiler API (`ts.createSourceFile` + a shallow top-level-statement
  walk) rather than adding a new dependency like `acorn` — `typescript` was already a
  `devDependency` here for `npm run lint` (`tsc --noEmit`), and unlike `acorn` it natively
  understands TS/TSX type syntax instead of throwing on it. Promoted to a real `dependency` in
  `package.json` since the indexer now needs it at runtime, not just at lint time. Loaded via a
  cached dynamic `import('typescript')`; every call site catches failures (missing package,
  version mismatch, genuine parse error) and falls back to the pre-existing regex extractor, so
  this is a strict enhancement with no new hard requirement and no regression path — plus it
  picks up `interface`/`type`/`enum` declarations the old regex list never covered at all.
- **Static verification only, not live-tested.** Every item above was written and manually traced
  for correctness (regex tested by hand against representative sample text, matcher dispatch
  chain read line-by-line), but this sandbox's Linux VM failed to start for the whole session, so
  none of it has been run against a live server, a real Ollama call, or the actual semantic
  matcher's embedding output. Before trusting this fully: run `npm install` (picks up
  `typescript` as a real dependency now), `npm run lint`, start the dev server, and test a few of
  the new `project.knowledge.how_to_run`/`run_project` phrasings against a real Go/Rust/Java repo
  to confirm both correct intent routing and correct extracted run commands.

## Trigger-mode intent expansion (2026-07-30, requested directly — "richer chit-chat, more read-only code questions, more git actions, ~2000 example phrases, still using real ML not just hardcoding")

Follow-up to the README-parsing batch above. Clarified up front and worth restating here since it
came up directly: the phrase lists in `intentsData.js` are hand-curated seed data, but the
*matching* is genuinely learned — `semanticMatcher.js` embeds every example via a real local
transformer (`Xenova/all-MiniLM-L6-v2`) and matches by cosine similarity, `nlpEngine.js` is a
separately trained NLP.js classifier, and `confidenceModel.js` is a logistic regression trained by
real gradient descent on actual accept/reject telemetry (see "Learned confidence model" above) —
none of this batch changed that architecture, it just gave all three layers a lot more to work with.

- **Richer, varied chit-chat — still fully deterministic, no LLM call.** `builtinIntents.js` has a
  new `pickRandom()` helper; greeting/status/gratitude no longer send the exact same string every
  time (3-5 varied replies each, still template-based). Two new intents: `system.chit_chat.farewell`
  (there was no goodbye handling before at all) and `system.chit_chat.identity` ("who/what are
  you" — previously fell through to help or a generic fallback; now explains the trigger-mode vs
  AI-mode distinction directly). Both added to `matcher.js`'s `BUILTIN_INTENTS` Set AND its
  `PURE_CHITCHAT_INTENTS` Set (same "garbled input could misfire onto a zero-argument safe-sounding
  reply" protection as greeting/gratitude/etc — see that Set's own comment).
- **Five new read-only codebase intents**, all built on data this app was already collecting for
  the AI system prompt but had no trigger-mode-visible way to ask for directly:
  `project.context.routes` (surfaces `idx.apiRoutes` via `formatApiRoutes()`),
  `project.context.file_relations` ("which files import X" / "who uses this file" — reads the
  `imports`/`importedBy` already attached to each `repoMap` entry, no fresh scan needed),
  `project.context.monorepo` (surfaces `idx.subPackages`/`isMonorepo`),
  `project.context.todos` (new `findTodos()` in `codebaseIndexer.js` — an on-demand regex scan for
  TODO/FIXME/HACK/XXX markers, capped at 150 files / 60 results), and
  `project.context.biggest_files` (new `findBiggestFiles()` — on-demand `fs.stat` scan, top 10 by
  size). The last two are deliberately NOT part of the cached `codebaseIndex` — they're asked for
  rarely enough that paying the scan cost on-demand beats slowing down every single project select
  for a feature most sessions never use.
- **Four new git intents**, kept inside the existing safety model rather than expanding it:
  `git_diff` (safe/read-only, executes immediately like `git_log`/`git_branch`), `git_stash` and
  `git_stash_pop` (confirm-gated — technically reversible via each other, but shelving/restoring
  uncommitted work is exactly the "surprising but recoverable" case this app already gates), and
  `git_branch_create` (confirm-gated, branch name run through `paramCommand.js`'s
  `isSafeParamValue()` — the same shell-metacharacter check already used for parameterized command
  substitution, since a branch name substitutes directly into a command string the same way).
  Deliberately did NOT add `git reset --hard`, force-push, or branch deletion — those are a real
  expansion of the destructive-action surface and would need an explicit discussion first per this
  file's own "Safety model — don't weaken this without discussing it first" section.
- **All nine new intents added to `matcher.js`'s `BUILTIN_INTENTS` Set** — this is the fourth or
  fifth time this exact class of bug has bitten this app (see the `git_remote_add`/`project_list`/
  `file_append` history earlier in this file): an intent with real examples and a real handler is
  still completely unreachable if it's missing from that one Set. Checked explicitly this time
  before considering the batch done.
- **Every existing intent (all ~40 of them) had its example list widened** with casual phrasing,
  contractions, typo-tolerant variants, and question/imperative alternates — the explicit goal
  ("a lot of fallback, less errors") was reducing how often a real request falls through to the
  generic no-match suggestion chips, not just adding raw phrase count. Combined with the ~250
  phrases already added for the README-run-command intents in the previous batch, `intentsData.js`
  is now in the range of ~1800-2000 total example phrases across ~46 intents.
- **Deliberate ambiguity risk, not fully resolved**: `project.knowledge.how_to_run` (informational)
  and `run_project` (executes) share a lot of conceptual territory, and now so do
  `system.chit_chat.help` ("what can you do") and `system.chit_chat.identity` ("what are you") —
  both pairs were phrased with deliberately different shapes (question vs. imperative for the
  first pair, capability-listing vs. self-description for the second) specifically to help the
  embedding matcher keep them apart, but this is a design choice made by reasoning about the
  matcher's behavior, not by testing it — see the verification note below.
- **Static verification only, again.** Every addition in this batch was checked by hand for
  wiring correctness (the `BUILTIN_INTENTS` Set membership, the `response` vs `answer` field name,
  `PURE_CHITCHAT_INTENTS` membership for the two new chit-chat intents) and the on-demand scan
  functions were traced for correctness against `codebaseIndexer.js`'s existing patterns (same
  `IGNORE_DIRS`/cap conventions as `buildRepoMap`). None of it has been run against the live
  semantic matcher — the sandbox this was built in never got a working Linux VM this session. This
  is the same caveat as the previous batch, worth repeating because it still hasn't been resolved:
  run `npm run lint`, start the dev server, and try a real mix of the new phrasings (especially the
  `run_project`/`how_to_run` and `help`/`identity` pairs above) before trusting the routing.

## Intent phrase management (2026-07-30, requested directly — "how do we manage ~2000 phrases")

- `server/intentsData.js` was a single ~970-line object; split into `server/intents/` (
  `chitChatIntents.js`, `projectKnowledgeIntents.js`, `projectContextIntents.js`, `gitIntents.js`,
  `npmAndFileIntents.js`, `miscIntents.js`), merged back into one `INTENTS` object via object
  spread. Pure reorganization — every intent key/phrase is unchanged, and object spread preserves
  nested array/object references, so `learnedIntents.js`'s `INTENTS[intent].examples.push(...)`
  mutation pattern still works exactly as before. 59 intents total (correcting an earlier "~46
  intents" estimate from the prior batch).
- New `server/scripts/checkIntentDuplicates.js` (`npm run check-intents`) — a static, no-server,
  instant text-level check: flags exact duplicate phrases within one intent (harmless, just
  redundant), exact duplicates across two different intents (real ambiguity, worth fixing), and
  near-duplicates (edit distance ≤2, length-bucketed to stay fast) across different intents. This
  complements, not replaces, the live `check collisions` chat command — that one computes real
  embedding cosine similarity between whole intents but needs a running server with the
  transformer model loaded; this script needs neither and is the first thing to run after adding
  a batch of new phrases.
- `server/cli-client.js`'s `CONNECT_TIMEOUT_MS` bumped 40s → 90s based on a real measured ~41s cold
  boot (right at the old timeout's edge) — the 2026-07-30 intent-expansion batch also grew
  `intentsData.js` by roughly a third, which pushes real startup time (embedding + NLP classifier
  training) up further, not down. Re-measure and adjust again if a real boot ever gets close to
  this new ceiling.
- **Zip/junk-folder over-recognition, fixed (reported directly: "the AI tracked some zip folders
  and some basic folders").** `codebaseIndexer.js`'s `detectLanguages()` used to fall back to
  `ext.slice(1)` for ANY unmapped file extension — a folder with only `.zip` files got a fabricated
  `"zip (3 files)"` entry in `idx.languages`, and `projectScanner.js`'s
  `isRecognizableByCodeAlone()` checked `languages.length > 0`, so archive-only folders incorrectly
  passed as recognized projects. Fixed: `detectLanguages()` now skips unmapped extensions entirely
  instead of fabricating a language name, and recognition now checks a new, stricter `hasRealCode`
  signal (`REAL_CODE_EXTS` allowlist — actual source file extensions only) instead of raw language
  count. Plain folders with real code but no `package.json`/docs are still correctly recognized —
  that part was intentional from the earlier project-recognition-widening work, not a bug.

## Live bugs found via check-intents + real chat transcripts (2026-07-30, reported directly)

Running the new `npm run check-intents` for the first time (1902 phrases, 59 intents) found 3
within-intent dupes, 17 cross-intent exact dupes, and 71 near-duplicates — see the script's own
output for the full list. Fixed the within-intent dupes and the highest-value cross-intent ones
(a specific git/knowledge intent losing to a broad chit-chat catchall on the exact same phrase:
`git_status`/`system.chit_chat.deploy` vs. `git_diff`/`git_log`/`git_commit`/`git_commit_push`;
`system.chit_chat.help`/`identity` vs. `project.knowledge.commands`/`overview`;
`project.knowledge.stack` vs. `project.context.languages`/`dependencies`;
`project.knowledge.commands` vs. `how_to_run`; `npm_build` vs. `npm_run`). Left the genuinely
ambiguous ones alone (`greeting`/`status` sharing "sup"/"whats up"-style phrasing,
`overview`/`tech_preview` sharing "summary") — both sides give a plausible answer either way, so
de-duplicating them is bikeshedding with real risk of hurting recall for no clear win. The 71
near-duplicates (mostly short 2-3 letter chit-chat tokens like "ye"/"yo"/"ok" colliding across
greeting/yes_no/farewell) were left as-is for the same reason — real embedding-similarity
collisions (not just text overlap) still need the live `check collisions` chat command to assess.

Also found and fixed three real bugs from user-provided exported chat transcripts (Project console,
Matchday Exchange, NetPulse sessions), none of which `check-intents` could have caught since
they're routing/state bugs, not phrase-text bugs:

- **"who uses connection.js" answered with "### Tech Stack / No stack information parsed from
  markdown."** — confirmed live twice, same exact wrong answer both times. Root cause:
  `matcher.js`'s NLP.js-classifier fallback stage (`nlpResult.score >= 0.45`, no margin check) had
  a `PURE_CHITCHAT_INTENTS`/`isTrustworthyChitChat` guard for `system.chit_chat.*`/
  `project.context.*` intents but **not** for the `project.knowledge.*` canonMap right below it —
  so a weak/wrong classification onto `project.knowledge.stack` sailed through unguarded instead
  of falling through to the correct `project.context.file_relations` intent. Fixed with a new
  `isTrustworthyKnowledgeIntent()` guard (same shape as the chit-chat one): none of the five
  `project.knowledge.*` intents are ever legitimately about one specific named file, so a query
  containing a real filename now gets treated as untrustworthy for that intent category and falls
  through instead of returning a wrong answer. Applied to both the semantic-stage builtin match and
  the NLP canonMap. Also widened `project.context.file_relations`'s own example phrases (previously
  all generic "this file"/placeholder shape, e.g. "who imports state.js") with real-filename-style
  phrasing ("who uses connection.js") so the semantic stage has a real shot at matching correctly
  in the first place, not just at blocking the wrong answer.
- **"stop server" reported "No running server" for a dev server confirmed still running seconds
  later via "what's the link?"** (Matchday Exchange transcript). Root cause: `executor.js`'s
  `child.on('close', ...)` handler unconditionally called `runningProcesses.delete(projectId)`,
  including after `detach()` had already fired and told the user it was safe to use "stop server"
  later. On at least some Windows npm/vite invocations the tracked `child` (the shell wrapper
  around `npm run dev`) can fire its own `close` well before the actual dev server process it
  spawned stops serving, silently orphaning the real server from the handle being tracked. Fixed:
  only delete the map entry on `close` if the process was never detached — "stop server"
  (`connection.js`) already deletes the entry itself synchronously when it actually kills a
  tracked process, so this was pure redundant (and here, harmful) cleanup.
- **"Stop it" (typed right after the above) returned "No pending confirmation to respond to."**
  instead of stopping the server. `system.chit_chat.yes_no`'s example phrases literally include
  `'stop'`/`'abort'` as a reject-style reply, so a bare "stop it" matched that intent instead of
  anything server-related. Fixed narrowly: `connection.js`'s "stop server" regex now also catches
  a bare "stop it"/"kill it"/"cancel it" — but only when a process is actually tracked for that
  project (`runningProcesses.has(project.id)`), so an unrelated "stop it" with nothing running
  still safely falls through to the normal yes/no fallback instead of being over-matched.

## "Did you mean X or Y?" collision disambiguation (2026-07-30, requested directly)

Every previously-fixed matching bug this session (stack vs. file_relations, stop-server vs.
yes_no) had the same shape: two different intents scored close enough to be a coin flip, and the
pipeline silently picked one instead of asking. Rather than guessing more broadly (which the user
explicitly scoped down to "only true collisions" via a clarifying question — not every
low-confidence match, since that would interrupt harmless read-only queries too), this adds a
narrow disambiguation step exactly at the point a real tie is detected:

- `semanticMatcher.js`'s accept path (`bestScore >= floor && margin >= MIN_MARGIN`) now does a
  second, cheap pass to find the best-scoring vector belonging to a genuinely **different** intent
  than the winner (`bestOtherIntent`/`bestOtherScore`) — separate from the existing
  `secondBestScore`, which can belong to the *same* intent (a different example phrase scoring
  almost as well) and isn't a real ambiguity. If that different intent is within `MIN_MARGIN`
  (0.03) of the winner, the result carries a `collision: { intent, confidence, meta }` field
  alongside the normal winning intent — existing callers are unaffected since the winner is still
  returned as before.
- `matcher.js`'s 1b builtin-match step checks `semanticResult.collision`: if present, the collision
  intent is also a real `BUILTIN_INTENTS` member, and both intents pass the same
  `isTrustworthyChitChat`/`isTrustworthyKnowledgeIntent` guards as the winner, it returns
  `{ disambiguate: [intentA, intentB] }` instead of silently picking `intentA`. New
  `describeIntent()` (exported) renders a human-readable label from an intent's own first example
  phrase — no separate display-name field to keep in sync.
- `connection.js` sends a "Not sure which you meant: 1. ... 2. ... reply with 1/2/neither"
  `answer` message and stores `sessionContext.pendingDisambiguation = { projectId, candidates,
  originalInput }`, checked at the very top of `handleExecute` (same spot as the existing
  `pendingParam` interceptor, for the same reason — this reply was never meant to hit the normal
  matching pipeline). "1"/"2" dispatches the chosen intent directly via `handleBuiltinIntent`;
  "no"/"neither"/"none of those"/"that's wrong"/etc. clears the pending state and shows fallback
  suggestion chips instead of insisting on an answer. Anything else (not a clear pick, not a clear
  rejection) also clears the pending state and falls through to the normal pipeline unmodified —
  this is the requested "backtrack" behavior: if the reply doesn't address the question, treat it
  as a new, unrelated message rather than getting stuck.
- Deliberately does NOT touch the NLP.js classifier fallback or the local-router tier — scoped to
  the semantic stage only, since that's where the existing margin/secondBestScore machinery already
  lived and where every confirmed collision so far actually originated.

## Scanning a project's own root, and a stray reload bug (2026-07-30, reported directly)

Two real bugs from one report ("scanning C:\Users\tobil\Desktop\tobi-portfolio listed its content
and the site reloads every time it scans"):

- **Every scan rewrote a repo-root file, forcing a Vite full-page reload.** `nlpEngine.js`'s
  `train()`/`retrainFromLearned()` used to call `this.manager.save()` with no path argument —
  node-nlp resolves that to `./model.nlp` relative to `process.cwd()`, which is this app's own
  repo root (launched via `npm run dev` from there). That file was nowhere in Vite's
  `watch.ignored` list (only `data/`/`.cache/`/`*.console/` are excluded — same mechanism
  documented earlier for `data/conversations/index.json`), and nothing anywhere in the codebase
  ever calls `.load()` to read it back — the classifier is always rebuilt fresh from
  `initializeDefaultIntents()` + learned phrases on every process start. So this was a pure-dead
  write with an active bug attached: every `/api/scan-path` call retrains and re-saves it,
  triggering a "real source file changed" full reload each time. Removed the `.save()` calls
  entirely rather than redirecting them into an already-ignored directory, since nothing consumes
  the file — if real persistence is wanted later, it needs a matching `.load()` on startup and
  should live under `data/`. Also added `model.nlp` to `.gitignore` as a guard.
- **Pointing the scan path directly at a single project (anything outside the default
  `C:\Users\tobil\Desktop\Projects`, which always requires pasting a full absolute path — see the
  folder-picker limitation above) listed that project's own internal subfolders as if they were
  separate top-level projects.** `discoverProjects(baseDir)` always treated `baseDir` as a
  *container* of project folders and scanned each immediate child as a candidate — combined with
  this session's earlier code-only recognition widening (any folder with real source files now
  counts), a folder like `src/`, `components/`, or `public/` inside the scanned project passed
  recognition on its own and got listed as a fake separate project, flooding the list with the
  project's own structure instead of the project itself. Fixed: `discoverProjects()` now checks
  whether `baseDir` itself looks like a single project root first (console.config.json, or a
  CLAUDE.md/README.md/etc., or `package.json` at `baseDir`'s own top level) and if so calls the
  existing `scanSingleProject()` on it directly instead of descending into its children — reusing
  the same function already used by the folder-picker/`--dir` path. Deliberately does NOT also
  check for a bare `.git` directory as a signal, since someone could plausibly keep an entire
  `Projects` container under one repo without every sub-project being its own repo, and that
  shouldn't collapse the whole container into one fake project. A plain container folder (like the
  default scan directory) essentially never has its own package.json/README/config at its own
  root, so normal multi-project scanning is unaffected.

## Wrong script picked + duplicate dev-server spawns (2026-07-30, reported directly)

Matchday Exchange has two separate servers — the Vite site (`npm run dev`) and a wallet/settlement
backend (`npm run server`, `tsx watch server/start.ts`, port 4400). A real transcript showed
"run dev" correctly starting Vite, then "run its server" and later "run .bat" *each* also ran
`npm run dev` again — never the actual `server` script — leaving three redundant Vite instances on
3001/3002/3003 all serving the same project. Oddly, "Is its server running?" (different phrasing,
same intent) correctly ran `npm run server` — proof the right script name lookup already existed
somewhere, just wasn't reachable from every phrasing.

Root cause: `run_project`'s handler (`builtinIntents.js`) always defaulted straight to
`scripts.dev`/`start`/`serve` without ever looking at what the user actually typed. `npm_run`'s
handler *does* try to extract a script name, but only via a strict regex requiring the name to
immediately follow "run"/"execute" — `run its server` captures `its`, not `server`, so it missed
too. The one path that worked, `npm run server` running correctly, went through a *third*,
different route entirely: `server` isn't in `scriptEntries.js`'s `KNOWN_SCRIPTS` map, so it got a
generic auto-derived entry with trigger phrases `['run server', 'npm run server']`, and "Is its
server running?" happened to land on that project-specific entry via embedding similarity instead
of the generic `run_project` builtin — an inherently fragile coin flip between a large builtin
example cluster and a two-phrase project-specific entry, not something to rely on.

Fixed two ways, both in `builtinIntents.js`:
- New `findMentionedScript(input, scripts)` checks every real script name in the project's own
  `package.json` against the input as a whole word (not anchored to right-after-"run" like
  `npm_run`'s regex), so "its server", "is the server running", "start the server process" all
  find `server` regardless of where the word falls in the sentence. `run_project` now calls this
  first and defers to it before falling back to the dev/start/serve default; `npm_run`'s existing
  regex path is unchanged (still tried first there, since it's more precise when it matches).
- Both `run_project` and `npm_run` now check `runningProcesses` (the same map `stop server` reads)
  before running a dev-server-shaped script (`dev`/`start`/`serve`) — if one's already tracked for
  this project, they answer with what's already running and where, instead of spawning another.
  Doesn't touch anything project-specific-entry-triggered (`matchedEntry.js`/`runCommandEntry`) —
  that path wasn't what fired the duplicate runs in this transcript, so it's a known adjacent gap
  to revisit if the same symptom shows up coming from a project-specific "run dev"-style trigger
  instead of these two builtins.

## AI-mode-generated feature batch (deepseek v4 flash via opencode, 2026-07-30) + safety review

A separate coding pass (not this session's earlier trigger-mode/intent work) added six new
`server/` modules in one batch: `webSearch.js` (DuckDuckGo scrape-based `webSearch`/`deepResearch`
for the AI-mode Search/Deep Research toggles), `pluginTools.js` (lets a project define custom
AI-mode tools via a `console.tools.json` manifest — `{ name, description, command, args, risky }`
entries, loaded per-project in `tools.js`'s `createProjectTools()` and merged into `baseTools`),
`contextInjector.js` (`injectContext()` — appends codebase-index snippets like entry points/
languages/matched files onto certain trigger-mode `answer` replies, called from several spots in
`builtinIntents.js`), `contextResolver.js` (`resolveContext()` — a last-resort fallback in
`connection.js`, tried only after semantic/NLP/router/fuzzy all fail to match anything at all, that
guesses an intent from short keywords or pronoun carryover from the previous turn), `metrics.js`
(a small in-process counters/histogram/ring-buffer store — clean, no issues found), and
`gitSafety.js` (an extraction of `createCheckpoint`/`performUndo`/`isGitRepo` that already existed
inline elsewhere — pure refactor, `undoLastChange` in `tools.js` still calls it the same way).

Reviewed for safety/correctness since none of it had been through this file's own documented
review process yet. Found and fixed four real issues, all already patched in the files themselves:

- **`pluginTools.js` reintroduced a closed command-injection class of bug.** `createPluginToolFn`
  substituted `{{argName}}`/`${argName}` call args directly into a manifest's `command` template
  and ran it via `exec()` with no shell-metacharacter check and no `isCommandBlocked()` check on
  the resolved string — exactly the gap `paramCommand.js`'s `isSafeParamValue()` was built to close
  for the existing hand-authored parameterized-command feature (see that file's own security note).
  Worse, gating was entirely up to the manifest's own optional `risky` flag (defaults to false), so
  an unmarked custom tool ran with zero user confirmation — a project folder cloned from someone
  else could ship a `console.tools.json` with an innocent-sounding tool that actually runs anything.
  Fixed: every substituted value is now checked with `isSafeParamValue()` before substitution
  (rejects shell metacharacters/newlines/oversized values, independent of the manifest's own `args`
  schema), and the fully-resolved command is checked against `isCommandBlocked()` right before
  `exec()` — neither check depends on the manifest's `risky` flag, since that flag is author-
  supplied and unverifiable. The `risky`-gated-confirmation behavior itself (via `isCustomToolRisky`
  in `tools.js`) is unchanged — this fix closes the injection/blocklist gap underneath it, it
  doesn't change who needs to click Approve. **Still worth a deliberate decision, not made here**:
  whether an unmarked (`risky: false`/omitted) plugin tool should really run without confirmation
  at all, given the manifest is user/repo-authored and not verified by this app.
- **`webSearch.js`'s `deepResearch` had a host allowlist that silently defeated itself.**
  DuckDuckGo's HTML endpoint never links straight to a result — every `result__a` href is a
  same-site redirect (`duckduckgo.com/l/?uddg=<encoded-destination>`), and the old
  `ALLOWED_SEARCH_HOSTS` only permitted `duckduckgo.com`/`html.duckduckgo.com` — so it happened to
  pass, but only because it was checking DDG's wrapper, not the real destination, and the `url`
  field shown to users as a citation was DDG's redirect link rather than the actual source. Fixed:
  new `resolveRealUrl()` decodes the `uddg` param back to the real destination for every result
  `webSearch()` returns; `deepResearch`'s allowlist was replaced with `isSafeExternalUrl()` — a
  basic SSRF guard (rejects non-http(s) schemes and localhost/private-IP-range hostnames) that
  makes sense against an arbitrary external destination, instead of an allowlist that could never
  have matched one.
- **`contextResolver.js`'s keyword fallback used plain substring matching.** `CONTEXTUAL_MAP`
  checked `input.includes('main')`/`.includes('run')`/etc. — short keywords that fire inside
  unrelated words ("maintaining" contains "main", "the crunch is real" contains "run"). Since this
  only runs as the last resort after every other matching stage gives up (see `connection.js`'s
  "no match — try conversation context carryover" call site), a false-positive here is worse than
  the honest "no match → suggestion chips" it replaces — the same "confident wrong answer is worse
  than an honest fallback" lesson this file already learned from `PURE_CHITCHAT_INTENTS`/
  `isTrustworthyKnowledgeIntent` above. Fixed with word-boundary regex matching instead of
  `.includes()`; had to special-case keywords like `.env` that start/end with a non-word character,
  since a plain `\b` can never match between two non-word characters (a naive `\b\.env\b` would
  never match ".env" at all) — `keywordRegex()` only asserts a boundary on whichever edge of the
  keyword is actually a word character.
- **`contextInjector.js` had a dead `run_project` switch case reintroducing a fixed anti-pattern.**
  It would have suggested `` To run: start `<entrypoint>` `` — the exact naive pattern this file
  already documents as "actively wrong for compiled languages" (see the "Trigger-mode run-command
  guessing extended" entry above; `run_project`'s real handler in `builtinIntents.js` does proper
  marker-based detection instead). Nothing ever called `injectContext` with `action ===
  'run_project'`, so this was inert, not a live bug — removed outright rather than left as a trap
  for whoever wires it up next.

## Known gotchas

- **Fixed 2026-08-03 (NetPulse chat transcript, reported directly — "run the site" produced a
  broken suggestion, a crash, and a phantom "still running" message).** Three bugs, all fixed:
  (1) `readmeRunParser.js`'s `firstMatchingCommandLine()` returned only the token the regex
  matched, so every `python main.py <subcommand>` line in NetPulse's CLAUDE.md collapsed to bare
  `python main.py` (a guaranteed argparse crash — NetPulse's dispatcher requires a subcommand).
  Now returns the full command segment after the match, stopping at a trailing `#`/`//` comment
  or `&&`/`||` separator (`python main.py watch --interval 30` stays intact; `pip install ... &&
  python main.py once` returns just `python main.py once`). (2) `executor.js`'s `forceDetachTimer`
  was never cleared on `close`/`error`/`detach`, so a fast-failing command (exit code 2) got the
  correct "Process exited with code 2" AND, 20s later, a phantom "This command is still running
  in the background" message for a process that was already dead. The timer is now cleared in all
  three places. (3) NetPulse's own `console.config.json` command entries (`python main.py serve`,
  `python main.py watch --interval {interval}`) used to lose to the generic `run_project`/`npm_run`
  builtin clusters in the embedding race, so "run the site and watch at interval of 5 minutes"
  never reached the watch entry. Two-part fix, floor values chosen from measured real-embedding
  cosine scores of NetPulse inputs against its own triggers (not guessed):
  - `semanticMatcher.js` new `bestProjectCommandEntry(input, projectIndex)` — best-scoring
    `project.action.*` vector for one project, independent of the global builtin clusters.
  - `matcher.js` stage 1b: when the winning builtin is `run_project`/`npm_run` and the project's
    best entry clears `CONFIG_RUN_ENTRY_FLOOR` (0.55), dispatch through the exact same
    config-entry path as stage 1a instead (params/confirm flow untouched). 0.5 was unsafe —
    measured "run this project" 0.517 against the "test project" trigger silently auto-ran
    pytest; 0.55 clears that while still auto-running the true positives (compound 0.565 -> watch,
    "run the network speed" 0.721 -> watch, "run the tests" 0.825 -> pytest).
  - `builtinIntents.js` `projectTypeSuggestions()` (now async, takes `input`): below the auto-run
    floor but above `CONFIG_SUGGESTION_FLOOR` (0.40), a config command entry with no `{params}`
    is surfaced as the suggestion chip (e.g. "run the site" 0.410 -> `python main.py serve` chip
    instead of the README-parse's bare `python main.py once`) — suggestion-only by design, and
    entries with params are skipped since a bare chip can't answer the param ask.
  The compound request itself already reached the watch entry via the existing multi-intent split
  (`matchMulti` + the stage-1a meta path — the earlier "never reached it" diagnosis was a test
  harness artifact, not the app); part 1 dispatches `run_project`, which the suggestion lever now
  answers with the serve chip. Verified with standalone harnesses against the real modules
  (battery of ~16 inputs incl. the false-positive set: "run the numbers"/"run the calculation"
  still resolve to `project.knowledge.commands`, "stop server" 0.309 and "check git status"
  0.264 stay well below both bars) + `npm run lint`; not yet re-verified live through a chat
  session.
  Same-day follow-up: NetPulse's own `console.config.json` command entries (and the harness fake
  project that mirrors them) were updated to use `venv\Scripts\python.exe main.py ...` — its
  README/CLAUDE.md/main.py now require the venv interpreter (the system `python` lacks
  `speedtest`, and `main.py` aborts with guidance if the module is missing). The
  `readmeRunParser.js` Python patterns were extended with an optional interpreter path prefix
  (`[\w.:\\\/-]*`) so venv-style commands parse the same as bare `python ...` (see the 2026-07-30
  readmeRunParser entry above).
- **Stale `dist/server.js` silently shadows source changes (bit twice, 2026-08-03).** `start.bat`'s
  WEB_MODE checks `IF EXIST "dist\server.js"` and runs `npm start` (`node dist/server.js`, the
  esbuild bundle) instead of `npm run dev` (`tsx server/index.js`, live source) whenever a bundle
  is present — with no timestamp/staleness check. Two same-day fixes (the bat-launcher-vs-README
  ordering fix and the literal-typed-command fix, both below) were made in `server/`, but the repo
  had a `dist/server.js` from three days earlier; restarting via `start.bat` kept silently running
  the old bundled logic with zero indication anything was stale. Deleted `dist/` so `start.bat`
  falls back to source until the next intentional `npm run build`. **If `dist/` ever gets rebuilt
  again, remember it will shadow any further `server/` edits under `start.bat`'s Web UI mode until
  it's deleted or rebuilt again** — `npm run dev` directly (bypassing `start.bat`) always runs
  current source regardless of `dist/`'s presence, so prefer that while iterating on server code.
- **Fixed 2026-08-03 (NetPulse, confirmed live via exported transcript): typing an exact, already-
  correct command in chat (e.g. `python main.py serve`) did not run it.** Typed input always went
  through the normal intent-matching pipeline, and since the text happened to name a real project
  file, it lost to `project.context.file_relations` ("who uses main.py") instead of executing —
  the ONLY way to actually run a command was clicking its auto-generated suggestion chip, which
  takes a separate client-side path (`onDirectCommand` → `execute_tool` WS message) that bypasses
  the matcher entirely. Fixed in `connection.js`'s `handleExecute`: if the whole trimmed message is
  already an allowlisted, non-blocked command (`isCommandAllowed`/`isCommandBlocked` — the exact
  same gate the chip path already used), it now runs directly instead of being matched as an
  intent. Only exact, well-formed command lines qualify — "run python main.py serve please" still
  goes through the normal pipeline, so intent phrases aren't affected.
- **Fixed 2026-08-03 (NetPulse, reported directly): bat-launcher detection ran BEFORE the
  documented-README-command check in `projectTypeSuggestions()` (`builtinIntents.js`), so a
  generic "run the site" on a project that ships both a `Play *.bat` launcher AND a documented
  safe command (NetPulse has both — the bat launcher exists but `python main.py serve` is real,
  non-interactive, and documented in its own README) always told the user to double-click the
  bat file instead of surfacing the real command. Swapped the order: `findDocumentedRunCommand()`
  now runs first, and the bat-launcher fallback only fires when no documented command was found.
  The bat check still exists for projects where the launcher is genuinely the only way to
  reproduce an interactive/multi-process startup (DuplicateFileAnalyzer, insightflow, StudyFlash
  where the README doesn't spell out the two-process pattern) — this only changes precedence when
  a project has both.
- **Intent expansion, Phases 1-3 complete (2026-08-03, spec from `console-intent-expansion-prompt.md`).**
  Ten trigger-mode intents added in three passes, all harness-verified against the real modules
  (real NetPulse `console.config.json` entries as the fake project, real embeddings): 49/49
  (Phase 1) → 98/98 (Phase 2) → 133/133 (Phase 3) dispatch + handler checks — the spec §4.3 control
  battery reproduced at every phase plus per-intent and adjacent (must-not-steal) batteries, with
  ONE documented deviation from the baseline control battery, see the `what is the link` note under
  dev_server_status below. The full set: `run_tests`, `project.context.dev_server_status`,
  `file_find`, `git_fetch`, `git_ahead_behind`, `git_tag`, `project.workflow.checkpoint`,
  `project.context.recent_activity`, `system.chit_chat.needs_ai_mode`, `git_stash_list` — every one
  verified in `BUILTIN_INTENTS` (the gate that has silently killed intents 5+ times). Not yet
  re-verified through a live chat session — harness-verified only; the user plans to do live chat
  verification after the whole upgrade. The spec file lives in the repo root but is gitignored
  (along with the other AI-session prompt docs) — it's local reference, not app docs; the README's
  "Intent Expansion (Phased)" section mirrors the phase map.
  - **Phase 1 (2026-08-03).** Three intents plus two measured fixes.
    - **`run_tests`** (npmAndFileIntents.js examples, `BUILTIN_INTENTS`, handler in
    builtinIntents.js): executes the project's real test command by marker detection —
    `package.json` `scripts.test` → `npm test`, `Cargo.toml` → `cargo test`, `go.mod` →
    `go test ./...`, `pyproject.toml`/`requirements.txt` → `python -m pytest`; no marker → plain
    "no test setup detected" answer. Immediate, no confirmation (tests always re-run freely, no
    dev-server duplicate guard — matches the existing npm_run rule). The ONE intentional dispatch
    change of the phase: "run the tests" now runs tests instead of answering about them. Per the
    spec's forbidden list, the action-flavored "execute tests"/"kick off the tests"/"execute the
    test suite"/"check test results" phrases remain owned by `project.context.tests` (that intent
    stays question-shaped + these), so no other routing changed. One convention fix in the
    handler: keyFiles content is truncated at 2000 chars with a `\n... (truncated)` marker by
    `readKeyFiles`, so the `package.json` parse strips it first — same as `detectFrameworks`/
    `configInitializer`; a large package.json without that would have silently reported "no test
    setup detected". (Note: the same un-stripped parse pattern still exists at builtinIntents.js
    ~727/1000 and connection.js:616 for run_project/npm_run and the link pre-check — pre-existing,
    out of Phase-1 scope, worth fixing if a big-package.json project ever misbehaves there.)
  - **`project.context.dev_server_status`** (projectContextIntents.js examples, `BUILTIN_INTENTS`,
    handler in builtinIntents.js): "is the server running" / "is the site live" / "what's the URL"
    previously only worked by luck when a config entry or the "what is the link" pre-check in
    connection.js caught the phrasing. Reads `runningProcesses` + `state.lastDevUrls` (same data
    the pre-check reports), reports command + URL or "not running" + how to start it, and applies
    `withPortCollisionWarning()` exactly like the pre-check does. Read-only, immediate. Note: the
    "what is the link"-family is still owned by connection.js's pre-check (runs before the
    matcher) — the intent covers the question-shaped phrasings that pre-check never matched, and
    if any of them ever did reach the matcher, this intent answers them equivalently (same data).
    Per the spec, "what port is the dev server on" lives here (the dev server's port) — but "what
    port is the server on" deliberately does NOT: `system.chit_chat.port` already owns that exact
    phrase and an exact cross-intent dupe would fail check-intents. Example-seed trimming, measured:
    "what is the url" / "whats the url" / "what is the url of the server" / "what url is it on" are
    deliberately NOT in the example list — those exact shapes are caught by the connection.js link
    pre-check before the matcher (same data, real URL, port-collision warning), and "whats the url"
    scored 0.734 for the unrelated "what is the link" input, dragging the cluster into that
    baseline's territory. "where is my server running" IS an example (it's NOT pre-checked — the
    pre-check regex requires "the " before the keyword, "my server" slips past it) and so is "is the
    dev url up", both spec seeds. **Accepted second change (the spec's §4.3 "leave `what is the
    link` alone" and §5.2 "seed `what is the server link`" are in tension):** "what is the link"
    now routes to this intent in the harness (was project.knowledge.stack). The spec's own seed
    "what is the server link" scores ~0.85 against it — a near-identical phrase, permanently above
    the 0.6 floor, so no example trimming can revert the flip. Live behavior is 100% unchanged: the
    pre-check (connection.js ~line 608, `what('s| is)\s+(the\s+)?(link|url|address)`) intercepts it
    before the matcher and answers with the real URL. In-harness, this intent's answer (command +
    URL) is more correct than the old tech-stack dump anyway.
  - **`file_find`** (npmAndFileIntents.js examples, `BUILTIN_INTENTS`, handler in
    builtinIntents.js): "where is main.py" / "find the config file" — parses the name loosely
    (same `parseFileNameOnly` as file_read) and runs the sandboxed `findFiles()` tool. Read-only,
    immediate; caps results at 15 with a "...and N more" tail, and says plainly when nothing
    matches. No "gitignore" phrasings on purpose — the existing `PRE_SEMANTIC_OVERRIDES` literal
    for `git_ignore_add` swallows any input containing "gitignore" before the matcher sees it.
  - **`parseFileNameOnly` widened** (builtinIntents.js): now also handles "the <name> file" shape
    ("find the config file", "read the readme file") where the name comes BEFORE the word "file"
    — both file_read and file_find previously asked "which file?" for these. Deliberately
    requires a determiner ("the/a/my/...") before the name so bare action phrases like "read
    file" / "open file" / "show me the file" still ask instead of treating the verb as a
    filename (verified: all three still ask).
  - **`PRE_SEMANTIC_OVERRIDES` +1, measured**: "who uses main.py" scored 0.826 for `file_find`
    ("where is main.py" — the filename dominates the vector) vs 0.770 for
    `project.context.file_relations`, silently flipping a documented, confirmed-live intent's own
    territory. Added a literal override routing `who ... uses/imports/references/depends on` and
    `which/what + files/modules + use/import/reference` to `file_relations` before embeddings run
    (second alternative deliberately requires the files/modules noun so "what is imported"
    [dependencies] and "what does this file import" stay untouched). Keep this pattern narrow —
    same rule as the rest of that list. Justified against the spec's own PRE_SEMANTIC_OVERRIDES
    rule: "only for CONFIRMED misclassifications" — this one was confirmed by measurement in the
    harness, caused by file_find's own introduction.
  - Wiring checks: all three new intents verified present in `BUILTIN_INTENTS` (the gate that has
    silently killed intents 5+ times before — run_tests was already there from the previous
    session's in-flight work; dev_server_status and file_find added this pass). `npm run
    check-intents`: no new exact/near duplicates (the 6 cross-intent exact dupes and 71
    near-dups it reports are all pre-existing, deliberately-left items). `npm run lint` passes.
  - **Phase 2 (2026-08-03, same spec file).** Five more intents, one pass each, harness-verified
    (98/98: full control battery unchanged + 5 new batteries + adjacent must-not-steal checks,
    real embeddings; output `phase2-final.txt` in temp). Same wiring gate as always — all five
    verified in `BUILTIN_INTENTS` (the gate that has silently killed intents 5+ times).
    - **`git_fetch`** (gitIntents.js, `BUILTIN_INTENTS`, immediate): read-only ref update,
      `git fetch`. No "pull"-shaped phrases (git_pull owns those). Measured adjacent note: "fetch
      and merge" (a git_pull exact example) now splits into `MULTI: git_fetch | git_pull` because
      the multi-intent splitter resolves "fetch" on its own now — outcome is the same as a pull
      (fetch runs, then the pull-merge confirm), accepted and documented rather than fighting the
      splitter.
    - **`git_ahead_behind`** (gitIntents.js, `BUILTIN_INTENTS`, immediate): "am I behind origin" —
      runs `git status -sb`, which prints the `[origin/main: ahead 2, behind 1]` bracket directly,
      no parsing. Question-shaped only; pull-flavored phrasings stay with git_pull.
    - **`git_tag`** (gitIntents.js, `BUILTIN_INTENTS`, list = immediate / create = confirm-gated):
      no name → `git tag` list; a name → `isSafeParamValue` check BEFORE the confirm (same rule as
      git_branch_create) then the standard pendingConfirmations flow. Verified the injection
      attempt "create a tag called v1.0;rm -rf" confirms as bare `git tag v1.0` — the name regex's
      character class `[A-Za-z0-9._/-]` can't capture a shell metacharacter, so the junk is dropped
      at parse; isSafeParamValue is the second layer for weird-but-legal captures.
    - **`project.workflow.checkpoint`** (miscIntents.js, `BUILTIN_INTENTS`, immediate — user-asked
      commit, recoverable, same justification as the auto-checkpoint): calls the same
      `createCheckpoint` gitSafety.js uses before risky commands; non-git projects get its own
      message surfaced as-is ("Project is not a git repository. Skipping git checkpoint." —
      handler-tested, nothing mutated). "checkpoint my work" / "make a save point" are deliberately
      NOT seeded here — those exact phrases are already git_commit examples (cross-intent exact
      dupes would fail check-intents) and git_commit answers them equivalently (harness-verified:
      both still route to git_commit).
    - **`project.context.recent_activity`** (projectContextIntents.js + new `findRecentActivity()`
      in codebaseIndexer.js — same readProjectTree walk findBiggestFiles uses, IGNORE_DIRS +
      dotfile skipping included, on-demand not cached, `[{path, mtime}]` desc; `BUILTIN_INTENTS`,
      immediate): answers about FILE modification times on disk, deliberately distinct from
      git_status (working tree) and git_log (commits). The bare "what changed recently" is NOT
      seeded here — it's an exact pre-existing git_status example; per the Phase-1 precedent the
      pre-existing owner keeps it (harness-verified: still routes to git_status).
    - `npm run check-intents` after Phase 2: 6 cross-intent exact dupes (all pre-existing; the 7th
      — "what changed recently" — was introduced by an early seed and removed per the owner rule
      above), 72 near-dups (all pre-existing style items; the new "show tags" vs "show stats" pair
      is informational). `npm run lint` clean. Not yet live-chat-verified — same caveat as Phase 1.
  - **Phase 3 (2026-08-03, same spec file).** Two more intents, one pass each, harness-verified
    (133/133: the full 98-input Phase-2 battery kept as regression — control + P2 batteries +
    adjacent all still green — plus 2 new batteries + 6 more adjacent must-not-steal checks,
    real embeddings; output `phase3-final.txt` in temp). Same wiring gate as always — both
    verified in `BUILTIN_INTENTS`.
    - **`system.chit_chat.needs_ai_mode`** (chitChatIntents.js, `BUILTIN_INTENTS` **AND**
      `PURE_CHITCHAT_INTENTS`, immediate canned answer): open-ended requests typed with AI off
      previously scattered onto identity/structure/commands (baseline measured: "turn on ai mode"
      → identity, "ask the ai" → structure, "can the ai do this" → commands — all wrong) or the
      generic fallback. The AI toggle is a frontend-only control with no server-side flip path
      by design, so this intent can only answer with guidance — 3 pickRandom replies pointing at
      the header AI toggle. Registered in BOTH Sets deliberately: it's a zero-argument, always-
      safe-sounding canned reply, so it gets the same garbled-input protection as
      greeting/gratitude (the "who are you"/"goodbye" precedent from 2026-07-30).
    - **`git_stash_list`** (gitIntents.js, `BUILTIN_INTENTS`, immediate): read-only listing,
      `git stash list` — same treatment as git_log/git_branch (no confirm, does not touch the
      stash itself), with the same isGitRepo gate as git_stash/git_stash_pop. Baseline showed the
      pre-existing git_stash/git_stash_pop clusters absorbing these phrasings ("show stashes" →
      metrics, "what stashes exist" → git_tag) — the 12 new examples give the read-only shape its
      own cluster. "show the stash" / "what is in my stash" are question-shaped here; the
      action-shaped "pop the stash"/"unstash changes" still route to git_stash_pop
      (adjacent-verified).
    - `npm run check-intents` after Phase 3: 1 within-intent dupe + 6 cross-intent exact dupes +
      72 near-dups — the exact same pre-existing set as after Phase 2, zero new. `npm run lint`
      clean. Not yet live-chat-verified — same caveat as Phases 1-2.

- **Fixed 2026-08-03 (Phase 1 — command-window fix): `executor.js` spawn was missing `windowsHide: true`.** When the server runs without an attached console (daemon mode via `scripts/start-daemon.ps1`, background start via `start.bat`, or `npx local-project-console` launcher), Windows allocates a fresh console window for every child process spawned by `executeCommand()` — the "window for each command" symptom. Added `windowsHide: true` to the spawn options (harmless on macOS/Linux, required on Windows for consoleless parents). Verified live in daemon mode: commands run from chat no longer flash a cmd window; dev servers still detach correctly and `stop server` still works.

- **Fixed 2026-08-03 (Phase 2 — trigger-mode chit-chat expansion):** Added 3 new chit-chat intents + widened existing pools + time-of-day greetings:
  - `system.chit_chat.ack` — brief acknowledgment replies ("nice", "cool", "great", etc.). Confirm-prompt responses go through `handleConfirmResponse`, NOT the matcher — these can never approve a pending command.
  - `system.chit_chat.joke` — deterministic programmer jokes (8 variants), no network/AI.
  - Greeting handler: added time-of-day opener (morning/afternoon/evening/night via `new Date().getHours()`) as an extra `pickRandom` element.
  - Status pool: added `'you there', 'you still there', 'still there', 'are you there', 'are you awake'`.
  - Gratitude pool: added `'good job', 'nice work', 'great job', 'well done'` (ownership clean: praise → gratitude, acks → ack).
  - Farewell pool: widened from 10 to ~20 variants.
  - All new chit-chat intents registered in BOTH `BUILTIN_INTENTS` AND `PURE_CHITCHAT_INTENTS` (the garbled-input guard set).
  - `npm run check-intents`: zero NEW exact/near dupes (pre-existing ones left per owner rule).
  - Full harness: CONTROL battery byte-identical, all new + adjacent batteries green (159/159).
  - Verified: harness + lint + check-intents all pass.

- **Fixed 2026-08-03 (Phase 3 — trigger-mode basic calls):** Seven new deterministic, immediate,
  non-destructive intents (spec file's "basics" phase): `project.action.open_in_vscode` (spawns
  `code <path>`, ENOENT → File→Open Folder guidance instead of raw error), `project.action.open_in_explorer`
  (platform-branched `explorer`/`open`/`xdg-open`), `project.action.open_site` (reads `state.lastDevUrls`;
  no URL → guidance, never spawns), `project.action.copy_path` (new `copy_to_clipboard` WS event —
  the one new message type, handled in `useConsole.ts`'s `handleWebSocketMessage` switch per the
  keep-them-in-sync convention — + an answer), `git_remote_info` (read-only `git remote -v`, same
  isGitRepo gate as git_diff), `project.context.running_processes` (GLOBAL list across all projects
  from the shared `runningProcesses` map + lastDevUrls — distinct from the question-shaped, single-
  project `dev_server_status`), `project.context.session_info` (count + recent 3 from the central
  conversationStore index). All seven verified in `BUILTIN_INTENTS` (the gate that has silently
  killed intents 5+ times — checked explicitly). Measured seed-trimming: `open the site`/`open the
  website` removed from `open_site` (exact cross-intent dupes with run_project, pre-existing owner
  keeps them — check-intents verified 0 new after). Harness: **280/280** (full 133-input regression
  + 7 new batteries + 21 new adjacent must-not-steal + 7 handler-shape checks). Three adjacent
  probes investigated, all confirmed **pre-existing** (byte-identical at the pre-Phase-3 commit
  c92c1f6 via git worktree, deliberately not fixed in this phase): (1) `open the project` → stage-1b
  CONFIG_RUN_ENTRY_FLOOR diverts it to the pytest entry (0.590 ≥ 0.55) — same documented trade-off
  class as `run this project` 0.517 in matcher.js:29, and raising the floor would break the
  verified "run the site and watch" 0.565 → watch control; (2) `git remote add origin <url>` never
  reaches the matcher live — connection.js's typed-command bypass (isCommandAllowed → git) runs it
  directly, so the harness's git_status misroute is unreachable in production; (3) `what is the dev
  url` is unseeded (deliberately-excluded "what is the url" family in dev_server_status) AND slips
  past the link pre-check regex (which needs link/url/address immediately after "the ") → NLP-stage
  misroute to stack. Not yet live-chat-verified — same caveat as Phases 1-3.

- **CLI project picker registering one keystroke as two (2026-07-30, reported directly: typing
  "10" for project #10 acted like each digit was pressed twice).** All three
  `readline.createInterface()` calls in `cli-client.js` (`selectProject()`, `setupReadline()`,
  `questionAsync()`) were missing `crlfDelay: Infinity`. Node's own readline docs warn that without
  it, an interface can emit two `'line'` events for a single Enter press if the `\r`/`\n` bytes of
  a Windows-style line ending arrive in separate reads — the default `crlfDelay` is only 100ms, and
  Windows terminals (ConPTY in particular) are the case the docs call out as prone to this. Not yet
  reproduced live in this sandbox (no interactive TTY available here), but this is the documented,
  known cause of exactly this symptom shape — verify with a real "type 10, press Enter once" test
  on Windows next session.

- **Fixed 2026-07-28: `memory_suggestion` (Layer 4 adaptive project memory) was silently
  dropped client-side — the whole proactive-nudge feature never reached the user.**
  `connection.js` emits `{ type: 'memory_suggestion', data }` after `trackCommand()` /
  `trackFileEdit()` / `trackQuestion()` cross a threshold (repeated question 3x, command run 20x,
  file edited 10x, or a substantive AI answer worth remembering), and there's a full
  `memory_suggestion_respond` handler ready to receive the user's accept/reject and call
  `addToClaudeMd()`. But `useConsole.ts`'s WS message switch had no `case 'memory_suggestion'` —
  the message type just fell through unhandled, so the entire self-learning "notice patterns and
  offer to remember them" layer only worked as a `trigger mode` and had shipped completely inert
  from the UI's perspective. Fixed by adding `pendingMemorySuggestion` state (`useTerminal.ts`) +
  a `handleMemorySuggestionRespond` sender + a confirmation card in `Terminal.tsx` (same pattern
  as `pendingToolConfirm`). Note the response protocol differs slightly from tool-confirm: memory
  suggestions are keyed server-side by active project, not by a token, so no token round-trips.
  The other three self-learning layers (near-miss → `learningEngine.js` suggestions, intent
  telemetry auto-tuning, AI-exchange distillation) are all reachable via explicit trigger-mode
  commands (`review learning`, `telemetry review`, `review distillations`) and do work — this was
  the one layer designed to be *proactive* (push, not pull) and it silently never pushed.
- **Fixed 2026-07-28: Approve/Reject/Cancel/Execute buttons were dead.** `useConsole.ts`
  used to construct `useTerminal`'s `wsRef` as a brand-new, never-populated `useRef` instead
  of sharing `useWebSocket`'s real ref — only `handleSendMessage` was later patched to use the
  real socket. `handleConfirm`/`handleToolConfirm` (wired straight through to the confirmation
  buttons in `Terminal.tsx`) still closed over the dummy ref, so their `!wsRef.current` guard
  was always true and clicking Approve/Reject/Cancel/Execute silently did nothing — no
  `confirm_response` was ever sent. Fixed by creating `useWebSocket` before `useTerminal` in
  `useConsole.ts` and passing `wsHandler.wsRef` in directly.
- **Fixed 2026-07-28: "deploy"/"push" with a custom comment ignored the comment.**
  `system.chit_chat.deploy` in `builtinIntents.js` always confirmed a bare `git push`, relying
  on the auto-checkpoint (generic `console-checkpoint: before "..."` message) to cover the
  commit — so a request like `push the site with the comment "bug fixes"` silently dropped
  "bug fixes" and committed with the generic message instead. Fixed: deploy now parses a
  `with the comment/message "..."` phrase the same way `git_commit`/`git_commit_push` already
  did, and confirms `git add -A && git commit -m "<msg>" && git push` when a comment is given.
- **Fixed 2026-07-28: command output missing from exported/reloaded sessions.** The
  `ws.send` interceptor in `connection.js` that auto-persists messages to the session store
  only handled `answer`/`error_output` types — `executeCommand`'s `start`/`output`/`end`
  stream (the actual stdout of git/npm/etc. commands) was never saved. Any session reloaded
  from disk (switching chats, or exporting an older session) showed the AI/command reply
  missing entirely, even though it was visible live. Fixed by buffering `start`/`output`
  chunks per command and flushing them as one `bot` message on `end`.

- **Vite watches `data/`, and that used to matter**: `server/index.js` runs Vite in
  middlewareMode inside the same Node process as the backend, sharing one `http.Server` so
  Vite's own HMR websocket can attach (`hmr: { server: httpServer }`) instead of being silently
  killed by the app's own `/stream`-only WS upgrade filter. Once that HMR socket actually works,
  Vite's default file watcher — which covers the whole project root, including `data/` — picks up
  every write to `data/conversations/index.json` / near-miss / telemetry files (which the server
  itself rewrites on nearly every user action: creating a session, sending a message, running a
  command) and pushes a full-page-reload event to the browser, since JSON isn't hot-reloadable.
  Symptom: clicking "New Chat" (or almost anything) made the page flash white and reload. Fixed
  by excluding `data/`, `.cache/`, and `*.console/` from Vite's watch (`server.watch.ignored` in
  both `server/index.js`'s `createViteServer()` call and `vite.config.ts` — keep both in sync).
  If you add another directory the server writes to at runtime, add it to this ignore list too.
- **Silent truncation**: on large file writes, verify the file tail after edits — `writeFile` in
  `server/tools.js` re-reads and compares length as a cheap check, but a hash compare would catch
  more. Not yet hardened further.
- **`editFile` whitespace-tolerant fallback (2026-07-29, `LOCAL_ROUTER_UPGRADE_PROMPT.md` piece
  3):** `editFile` in `server/tools.js` tries an exact `oldString` substring match first
  (unchanged); if that fails, it now falls back to a whitespace-normalized line-range match
  (`normalizeLine`/`findNormalizedLineMatch` — trims + collapses internal whitespace per line
  before comparing) before giving up, since smaller local models frequently fail to reproduce a
  file's exact indentation/spacing byte-for-byte. Only tolerates spacing differences, not wrong
  wording. On total failure the error now names both things it tried and tells the caller to
  re-read the file rather than re-guessing. `ollamaContext.js`'s `editFile` tool description was
  tightened to match (call `findFiles`/`readFile` immediately before proposing `oldString`).
- `update_index2.cjs` is a leftover one-off migration script at the repo root — its logic is fully
  superseded by the current `server/` modules. Left in place because file deletion was declined
  once; safe to delete whenever.
- `server/intentsData.js` is now the single source of truth for all 41 intents and ~1500+ example
  phrases. `server/semanticMatcher.js` imports from it. Keep intents data there, not inline.
- `server/commandGuesser.js` is a post-matching regex-based fallback — fires only when no intent
  matched. Keep its patterns specific to avoid false positives. Its file-list/delete/create/show
  guesses now branch on `process.platform` (was hardcoded to Windows cmd.exe builtins — `dir /b`,
  `del /f /q`, `type nul`, `type "file"` — which don't exist on macOS/Linux `/bin/sh`; they now
  fall back to `ls -1`/`rm -f`/`touch`/`cat`). `dangerousPatterns.js` was already OS-aware both
  ways; this was the one real cross-platform gap in the command layer.
- `executor.js` now scans stdout for `http://localhost:\d+` URLs and emits a `server_url` WS event
  so the frontend can surface dev server links.
- No `npm install` / `tsc --noEmit` / `npm run dev` smoke test has been run against the latest
  changes yet (sandbox this was built in has no npm registry access / live Ollama, and in the most
  recent session the sandbox's Linux VM failed to start at all) — changes were verified by manual
  file re-reads for syntax/consistency only. Run `npm run lint` and a real Ollama session (including
  an actual `ollama signin` + a `:cloud` model chat) before treating the matcher/Ollama-Cloud
  changes as fully verified.
- **Surveyed every sibling project under `Projects/` (2026-07-29) and found several would error or
  hang if run through this console.** Root cause was two-fold: (1) `projectTypeSuggestions()`
  (`builtinIntents.js`, the no-config-match fallback) blindly suggested `python main.py`/
  `python app.py` without checking either file exists — now checks `idx.fileSample` for which
  common entry filename is actually present at the project root before guessing. (2) Several
  projects ship a `Play <Name>.bat` launcher instead of a plain entrypoint, and the launcher is
  often interactive (`set /p` prompts) or starts more than one process (a detached second window
  plus a foreground dev server) — `executeCommand`'s single non-interactive child can't reproduce
  either, so it's now detected first (via the same `fileSample`) and surfaced as "double-click
  this file" guidance instead of attempted as a command. Separately, several projects' own
  hand-authored `console.config.json` (which always wins over auto-detection) had stale/wrong
  commands: DuplicateFileAnalyzer and insightflow's "start app" both literally said `python
  main.py` while admitting in their own "what is the app" answer that it was an unverified
  placeholder (DuplicateFileAnalyzer's real entry is `backend.main`, needs a venv + a folder
  argument; insightflow's is `python -m insightflow.main --demo`, run from the parent directory
  since it's a package) — fixed both to `answer`-type entries pointing at their `Play *.bat`
  launcher instead of a command that would fail or hang. netpulse's config said `python app.py`
  (no such file — real entrypoint is `python main.py serve`) — fixed to the correct command since
  it *is* safely runnable non-interactively. dream-kick's config said `start index.html` (opens
  over `file://`, breaking its service worker) — fixed to `python -m http.server 8000` to match
  its actual `.bat` launcher. StudyFlash's config said `npm run dev` at the project root, but
  there's no root `package.json` — it needs two coordinated processes (`server/` + `client/`) —
  fixed to `answer`-type guidance pointing at its launcher. website/Portfolio's config still said
  `npm run dev`, but that folder currently holds only `.zip` archives and no extracted source at
  all — fixed to `answer`-type guidance to extract first. footysim and joke-kick had no
  `console.config.json` at all — added ones matching their real `.bat` launchers (footysim has no
  server at all — it's `python example.py` to simulate a match or `pytest tests/` — not a
  "run locally" website like the others).

- **CLI chat crash + no way to switch projects (2026-07-29, reported directly).** Three bugs in
  one session: (1) `cli-client.js`'s `case 'end':` unconditionally called `rl.prompt(true)` on
  whatever `rl` currently pointed to — but `questionAsync()` (used for both `confirm_prompt` and
  `tool_confirm_prompt`) closes `rl` the instant a prompt starts and doesn't reassign it until the
  user answers, and the server sends `end` for that same turn independently of the pending
  confirm — so an `end` landing in that window called `.prompt()` on an already-closed interface
  and crashed the whole client (`ERR_USE_AFTER_CLOSE`). Fixed with a `confirmPending` flag that
  makes `end` a no-op while a confirm prompt owns the terminal. (2) Multiple `answer` messages in
  one turn (e.g. `npm_run`'s "No script called dev found" immediately followed by
  `projectTypeSuggestions()`'s fallback) printed back-to-back with no separator — the web UI
  renders each as its own bubble, but the CLI just wrote raw text with no newline tracking. Fixed
  with `writeLine()`/`writeRaw()` helpers that track whether the last write ended in `\n` and
  force one before any new discrete message. (3) The project was only ever picked once at
  startup, with no way to switch or rescan short of restarting the whole process. Turns out
  nothing server-side needed to change — `handleExecute()` already trusts whatever `projectId` is
  sent per-message (CLI always sends `sessionId: null`, so the "session locked to a project"
  check never applied) — so switching was purely a client-side gap. Added a `projects`/`switch
  project`/`change project`/`scan projects` command recognized locally in `cli-client.js`,
  re-fetching `/api/projects` (a real rescan, not cached) and re-running `selectProject()`.
  Separately, "change project" typed as a chat message (not the new local command) was winning on
  the `project_scan` intent by loose semantic similarity and returning "restart the console"
  advice that was wrong for both interfaces — added a real `project_list` intent (`intentsData.js`
  + `BUILTIN_INTENTS` in `matcher.js`, the same gate that's bitten this before — see the
  `git_remote_add` entry above) with a handler that lists `state.activeProjectsCache` and gives
  interface-appropriate switch instructions.

- **AI mode already has a generic `executeCommand` tool (2026-07-29, clarified after user
  question) — it's not hardcoded per project and doesn't need to be.** `ollamaContext.js`
  documents `executeCommand` to the model (runs a shell command in the project directory, gated
  by `ALLOWED_COMMANDS`/`isCommandBlocked`, always confirmed via `tool_confirm_prompt` when
  `risky: true`), and `aiQuery.js`'s `runGatedExecuteCommand()` actually executes it through the
  same streaming `executor.js` trigger mode uses (6s timeout before treating a still-running
  process as detached, so dev servers/watch loops don't hang the tool loop). Combined with
  `readFile`/`findFiles`/`searchCode`, this means AI mode can already read a project's
  README/CLAUDE.md/entry-point source to learn its actual run syntax — including parameterized
  commands like NetPulse's `python main.py watch --interval N` — and ask the user for the
  parameter in conversation before running it, for ANY project, without per-project code. The
  console.config.json edits made earlier this session (DuplicateFileAnalyzer, insightflow,
  StudyFlash, netpulse, dream-kick, footysim, joke-kick, website) are **trigger-mode only** — that
  layer is a static dispatcher by design (see "Matching pipeline gotchas" above) and can never ask
  a clarifying question like "what interval?", so hardcoded guidance text is genuinely the right
  fix there. AI mode is the layer that generalizes and "learns" per the project's own docs.
  Strengthened `ollamaContext.js`'s system prompt to make this explicit rather than implicit: the
  model is now told directly not to guess how a project runs from its name, to read
  README/CLAUDE.md/entry-point source first, and to ask for missing parameters instead of
  inventing defaults — same rule for every project, including ones created after this was written.

- **Parameterized trigger-mode commands, no AI required (2026-07-29, requested directly — "AI
  should be an absolute last option").** New `server/paramCommand.js` + changes to
  `matchedEntry.js`/`connection.js` let a hand-authored `console.config.json` "command" entry
  declare `{placeholder}` params: `extractParamValue()` first tries to pull the value straight out
  of the phrase that matched (e.g. "watch every 15 minutes" already contains the interval); if
  that fails, `handleMatchedEntry` stores `sessionContext.pendingParam` and asks the entry's own
  `prompt` as a plain `answer` message — the NEXT chat message is then intercepted at the top of
  `handleExecute` (before the normal matching pipeline) as the answer, extracted the same way, and
  either advances to the next missing param or substitutes into `entry.action` and runs it via the
  new shared `runCommandEntry()` (same risky/confirm + `isCommandBlocked` path as any other
  command, re-checked on the SUBSTITUTED string). `isSafeParamValue()` rejects shell metacharacters
  (`;&|`$<>` and newlines) regardless of how loose the entry's own `pattern` is — defense in depth
  against command injection via a parameter answer, since these substitute directly into an
  otherwise-trusted command string. Entries can also declare `requires: ["relative/path"]` +
  `requiresMessage` — checked before running, so a command that needs one-time setup (a venv, an
  `npm install`) fails with clear guidance instead of a confusing shell error. Applied to NetPulse
  (`watch network` asks for an interval, plus non-parameterized `run once`/`export data`/`demo
  mode` entries pulled straight from `main.py`'s own docstring), DuplicateFileAnalyzer (`scan a
  folder for duplicates` asks which folder, gated on `.venv/Scripts/python.exe` existing), and
  StudyFlash (`start studyflash` now runs the real two-process pattern — API server in a detached
  window via `start`, client dev server in the foreground — mirroring `Play StudyFlash.bat`
  exactly, gated on both `node_modules` folders existing; also fixed `run tests`/`build project`,
  which pointed at a nonexistent root `package.json`). insightflow is NOT converted this way — its
  real invocation needs `cwd` one directory ABOVE the project root, which the sandbox deliberately
  never allows for hand-authored commands either (see "Safety model" above) — it's left as
  `Play InsightFlow.bat` guidance since there's no safe way to run it through this console at all
  yet. AI mode's `executeCommand` tool (see below) is the general-purpose fallback for run
  commands that don't fit this declarative param pattern — this mechanism is specifically for the
  common, previously-hardcoded-as-static-text cases where the actual command shape is fixed and
  only needs one or two values filled in.

- **Generalized the requires-check safety net to every npm-based project (2026-07-29, requested
  directly — "learning from itself... without AI mode").** `scriptEntries.js`'s
  `deriveScriptEntries()` now attaches `requires: ['node_modules']` +
  `requiresMessage` to every auto-derived `npm run <script>` entry — not just the hand-fixed
  projects from earlier, ALL of them, current and future, since this runs for any project with a
  package.json. A project with no `npm install` run yet now gets "say npm install first" instead
  of a raw npm error, with zero per-project code. Also extended `ollamaContext.js`'s system prompt
  so AI mode closes the loop on its own discoveries: after it works out a real run command
  (especially one that took reading docs or trial and error), it's now told to offer writing that
  back as a real `console.config.json` entry (using the `params`/`requires` schema from the
  parameterized-command feature above) rather than only explaining it in the conversation — so the
  next ask for the same thing doesn't need AI mode at all. This is the intended shape of "self-
  learning" here: AI mode (last resort) discovers something once, then demotes that knowledge into
  the deterministic trigger-mode layer so it's available without AI from then on.

- **Structural nudge for AI mode to save its own discoveries (2026-07-29, requested directly).**
  The system-prompt rule telling AI mode to offer saving a newly-discovered command into
  `console.config.json` was easy for the model to forget over a long conversation. Made it
  structural instead: `paramCommand.js`'s `commandMatchesTemplate()` checks a just-run command
  against every existing entry's `action` (exact match, or shape match against a `{param}`
  template), and `aiQuery.js`'s `runGatedExecuteCommand()` attaches a `note` field to the tool
  result whenever a command **succeeded** and **isn't already saved** — this note rides along in
  the same `JSON.stringify(result)` blob that's fed back to the model on every tool call (see
  `resultsSummary` in the tool-loop), so the reminder is present every time, not just when the
  model happens to recall a rule from its system prompt.

- **AI mode silently reverting to trigger mode seconds after activation (2026-07-29, confirmed
  live via an exported NetPulse chat transcript with timestamps).** The transcript showed the
  "AI Assistant activated — using Ollama Cloud model..." banner, then ~11 seconds later a plain
  "Hi" got the exact same canned trigger-mode greeting as before AI was ever toggled on — proving
  the toggle wasn't actually taking effect, not just a UI/copy issue. Root cause: `useWebSocket.ts`'s
  `ws.onclose` unconditionally scheduled a reconnect 3s later, even for a SELF-INFLICTED close
  (`connectWebSocket()`'s own preemptive close of a stale socket, or — very commonly, since Vite/
  React 18 dev mode double-invokes effects — the component-unmount cleanup closing a throwaway
  first-mount socket). That stray reconnect silently swaps the live connection for a brand-new one,
  and since the server creates a fresh `sessionContext` per WS connection (`aiEnabled`,
  `activeProjectId`, `aiModel` all reset to defaults — see `connection.js`'s connection handler),
  the running session quietly reverted to AI-off with no error and no visible change. Fixed with
  an `intentionalCloseRef` in `useWebSocket.ts`: any deliberate close (via the new `disconnect()`,
  used in `useConsole.ts`'s unmount cleanup instead of a raw `wsRef.current?.close()`, or
  `connectWebSocket()`'s own replacement of an old socket) sets the flag first, so `onclose` only
  auto-reconnects after a close this hook didn't itself cause. This was likely also the underlying
  cause of confusing "why did my chat history disappear" or "why does it feel like it forgot the
  project" reports even outside AI mode specifically, since the same reset applies to
  `activeProjectId` — worth keeping in mind if similar session-amnesia symptoms come up again.
- **Separately, the AI ON/OFF toggle button in `Terminal.tsx` could get pushed off-screen (2026-
  07-29, reported directly with a screenshot).** It was the LAST element in the header's flex row,
  after the model/mode dropdowns (which only render once `aiEnabled` is true) and several other
  buttons, with no wrapping — once the cloud-model optgroup widened that row, the toggle overflowed
  out of view. Moved it to be the FIRST element in that row (with `flex-shrink-0`) and added
  `flex-wrap` to the container so it can never be pushed out again, regardless of window width or
  how many other controls are present.

- **Ollama Cloud 404s despite being signed in (2026-07-29, reported directly).** Not a sign-in
  problem — `CLOUD_MODELS` in `ollama.js` had two stale model tags (`qwen3-coder-480b:cloud`,
  `deepseek-v4-pro:cloud`) that no longer resolve in Ollama's actual cloud catalog (verified
  against `ollama.com/search?c=cloud`), so the daemon correctly proxied the request and got a
  real 404 back for a model that doesn't exist anymore. Swapped for currently-valid tags
  (`qwen3.5:cloud`, `deepseek-v4-flash:cloud`). Since this list can drift again later, also fixed
  `aiQuery.js`'s error hint to stop always blaming sign-in: a 404 now says the model tag looks
  wrong/retired (check the catalog URL above), while 401/403 still points at `ollama signin`.
  If a cloud model 404s again in the future, check the catalog and update `CLOUD_MODELS` rather
  than assuming it's an auth issue.

- **Parameterized-command follow-up silently accepted a wrong answer (2026-07-29, confirmed live
  via a NetPulse export).** "run the network speed" → asked "what interval?" → user's actual reply
  was a new, unrelated message ("run the network speed" again) — `connection.js`'s `pendingParam`
  handler had a raw-text fallback (`isSafeParamValue(input.trim())`) that fired whenever pattern
  extraction failed, with no check for whether a pattern was even defined. Real result:
  `python main.py watch --interval run the network speed`, which crashed with an argparse error.
  Fixed: the raw-text fallback now only applies when the param has no `pattern` at all; if a
  pattern exists and the reply doesn't match it, the user is asked again instead.
- **Detached processes could stream into the chat forever (2026-07-29, confirmed live — the same
  NetPulse export showed raw Flask access-log lines flooding an otherwise-unrelated conversation).**
  `executor.js`'s force-detach timer was gated on `isDevServerCommand()`, which only recognizes a
  fixed list of npm/vite/etc. shapes — NetPulse's own `main.py serve` / `main.py watch --interval N`
  don't match any of them, so `isDev` was false and NO force-detach timer was ever set at all (the
  10s one only ran `if (isDev)`). `aiQuery.js`'s 6s tool-loop timeout only stops the AI from
  *waiting* on the promise — the underlying process and its output listeners keep running
  regardless. Fixed by making the force-detach timer unconditional (10s for recognized dev
  servers, 20s otherwise) instead of trying to enumerate every project's own server-launching
  syntax — a slow one-shot script being labeled "running in background" a little early is a much
  smaller problem than a process streaming output forever into whatever chat happens to be active.
- **Fullscreen chat toggle only widened the panel, not truly fullscreen (2026-07-29, reported
  directly).** The earlier fix hid the sidebar/project-grid columns but left the outer page header
  ("V4 Knowledge Engine" + scan bar) and page padding in place. Now also hides the header and
  removes the outer `p-6` padding when `chatFullscreen` is true, and the chat panel's height calc
  switches from a hardcoded `calc(100vh-140px)` (assumes the header's height) to `h-full` in that
  state. **Fixed 2026-08-04:** that `h-full` never actually resolved — in fullscreen `main`
  remained `grid grid-cols-1` with an implicit auto-height row, and percentage heights against an
  auto-sized grid track are indeterminate (classic CSS Grid gotcha), so the Terminal sized to its
  *content* instead of the viewport. Symptom (reported live): at start the Terminal sat at the top
  as a ~150px strip, then as messages accumulated it grew downward and its bottom edge — the input
  bar with the send button — was clipped by `main`'s `overflow-hidden`; the scrollbar also
  appeared dead because the `flex-1 overflow-y-auto` messages area never overflowed (the container
  grew instead). Fixed: `main` switches to plain `block` in fullscreen (`src/App.tsx`, one class
  change), so the wrapper's `h-full` resolves against `main`'s definite flex height — Terminal
  fills the viewport, messages scroll internally, input bar stays pinned. Non-fullscreen path
  (`h-[calc(100vh-140px)]`) untouched.
- **403 error hint refined (2026-07-29).** A 403 from Ollama Cloud is a different failure shape
  than a 401 — it usually means either the running Ollama app hasn't picked up a sign-in that
  happened after it launched (needs a full quit+reopen, not just re-running `ollama signin`), or
  the specific model requires a paid plan tier. `aiQuery.js`'s hint now says both instead of just
  repeating "run ollama signin" (which was actively confusing a user who genuinely already was).

- **`nlpEngine.js`'s trained classifier never learned from confirmed real usage (2026-07-29,
  requested directly — "how do I use ML techniques instead of hardcoding").** The semantic matcher
  (embeddings + `intentsData.js`) already gets new confirmed phrases fed back in via
  `learningEngine.js`'s near-miss auto-promotion (see `learnedIntents.js` above) — but `nlpEngine`
  (a real trained NLP.js classifier, separate from the embedding matcher) was only ever trained
  once at startup on its own hardcoded `initializeDefaultIntents()` phrases and then frozen for the
  rest of the process's life. Added `addLearnedPhrase()`/`retrainFromLearned()` to `nlpEngine.js`
  and wired `learningEngine.js`'s `applySuggestions()` to call them (fire-and-forget, not awaited,
  so this can't block the synchronous suggestion-approval flow or server startup) whenever a
  suggestion gets approved/auto-applied — so both matchers now learn from the same confirmed usage
  signal instead of just one of them.

- **Commit-comment truncation bug, confirmed live 2026-07-29 via a real exported chat transcript.**
  `push this code to github with comment "Massive Memory and Learning improvements"` silently
  committed as just "Massive Memory" — a regex duplicated across four handlers
  (`git_push`/`git_commit`/`git_commit_push`/`system.chit_chat.deploy` in `builtinIntents.js`)
  stopped capturing at the FIRST " and" found anywhere in the tail, regardless of whether it was
  inside the user's quotes, because it was written to strip an unquoted trailing clause like
  "message: fix the bug and push" and never accounted for "and" being an ordinary word inside a
  real quoted commit message. Fixed with one shared `extractCommentMessage(input)`: tries a
  fully-quoted match first (matching-quote backreference, so anything between the quotes is safe
  including "and"), and only falls back to the old stop-at-"and"/end heuristic for an unquoted
  message. All four call sites now use it instead of each carrying their own copy of the bug.
  Also hardened `semanticMatcher.js`'s `_splitConjunctions()` (the multi-intent "show structure
  and run tests" splitter, which runs *before* single-intent matching in `matcher.js`) to bail out
  entirely whenever the input contains a quote character — it has no concept of quote boundaries
  either, and could in principle chop a different quoted argument (file content, a URL) at the
  same word even after the above fix, for any input where the split-off second half happens to
  also resolve to a real intent. Verified both fixes with standalone regex tests against the exact
  real failing input plus the previously-supported unquoted-trailing-clause case.
- **AI mode narrating a tool call instead of making one, confirmed live 2026-07-29 via the same
  transcript.** `qwen3.5:cloud` replied "We need to call getGitStatus." (and similar) as plain
  visible text instead of emitting a `<tool_call>{...}</tool_call>` block, three times in a row for
  "push this code to github" — `streamWithToolDetection` (`aiStream.js`) only intercepts an actual
  `<tool_call>` tag, so when the model just narrates its plan in prose there's nothing to catch:
  the narration silently became the "final answer", no tool ever ran, and nothing signaled to the
  user that the request had failed (they eventually gave up and toggled AI mode off). Fixed with
  one bounded corrective retry in `aiQuery.js`: `looksLikeUnexecutedToolIntent()` detects this
  narrating-without-calling pattern (deliberately narrow — explicit "we/I need to call" phrasing,
  or a short reply mentioning "tool call" — so it doesn't fire on ordinary short answers), and if
  it fires on the first response with zero tool calls, the model is told directly that no
  `<tool_call>` block was found and given one more try before whatever it says next is accepted as
  the real answer. Verified the detector against the real transcript's exact reply text plus a set
  of ordinary answers that must NOT trigger it.
- **Root cause of the above, confirmed live 2026-07-29 with GPT-OSS (not just qwen3.5:cloud) —
  this app never separated a reasoning model's "thinking" from its actual answer at all.**
  `server/ollama.js`'s `chatStream()`/`chatOnce()` never requested Ollama's `think` option, so a
  thinking-capable model's internal deliberation and its finished reply both arrived as plain
  `message.content` with nothing to distinguish them — the code just showed whatever text came
  through and closed the turn the instant Ollama reported `done`. The corrective-retry fix above
  is a mitigation for one symptom of this; the actual fix is requesting `think: true` on every
  `/api/chat` call and treating Ollama's `message.thinking` / `message.content` as genuinely
  separate channels. `chatStream()` now yields `{ type: 'content' | 'thinking', text }` chunks
  instead of raw strings; `aiStream.js`'s `streamWithToolDetection()`/`streamPlain()` only feed
  `content` chunks into the visible-text/tool-call-detection buffer — `thinking` chunks are sent
  to the client as a new `thinking` WS event (ignored by the frontend today, a no-op — available
  for a future "thinking…" indicator) but can never be mistaken for the real answer or a tool
  call. `think: true` is safe to send unconditionally: a model without thinking support simply
  never populates `message.thinking`, so every chunk still comes through as `content` exactly like
  before — verified with a standalone test simulating both a reasoning-model-shaped stream (tool
  call correctly isolated from the "We need to call getGitStatus." thinking text) and a plain
  model's stream (fully unaffected, single concatenated content string).

- **AI mode fabricating a completed action with zero tool-call evidence, confirmed live
  2026-07-29 via a real exported transcript — worse than the narrating-without-calling bug above.**
  Asked to "push," the model skipped straight to "That **pushed successfully** ✅" with a
  fabricated-looking list of commit hashes — no `<tool_call>` block, and no narrated intention
  either (`looksLikeUnexecutedToolIntent` only catches "we need to call X" phrasing, so it never
  had anything to retry here). The model even second-guessed itself two messages later ("let me
  actually verify what's in the commits since I claimed to push but have no visibility into the
  contents"), confirming after the fact that it invented the result. This is more dangerous than
  the narrating case because there's no visible sign anything went wrong — a user could easily
  believe a destructive git operation happened when it didn't. Fixed with
  `looksLikeFabricatedActionClaim()` (`aiQuery.js`): checked once, after every round of the tool
  loop completes, against `toolHistory` (every tool actually run across the *whole* exchange, not
  just one round) — if that's empty but the final text still describes a completed mutating
  action (pushed/committed/deployed/deleted/installed/wrote/created/merged/reverted + a success
  word or ✅), an unmissable correction is sent as its own message right after. Can't edit the
  original reply in place since it was already streamed token-by-token before this check runs —
  the correction has to come as a follow-up, not a retroactive edit. Verified against the real
  transcript's exact fabricated line (fires) plus several ordinary answers, including one that
  mentions "push" without a success word and one that uses "wrote" in an unrelated context (both
  correctly don't fire).

- **`followUp` entry field — "start the dashboard, and watch too?" (2026-08-03, requested
  directly).** A hand-authored `console.config.json` command entry can now declare
  `"followUp": { "ask": "...", "entry": "<trigger of another entry>", "param": "<param name>" }`
  to ask a plain question BEFORE the command starts. `runCommandEntry()` (`matchedEntry.js`)
  checks it after the `requires`/blocklist gates: if the matched input doesn't already contain
  the target entry's parameter value (checked with the same `extractParamValue()` call the
  trigger-flow uses — so "start netpulse and watch at interval of 5 minutes" never re-asks), it
  stores `sessionContext.pendingFollowUp` (entry with `followUp` stripped so a later re-run can't
  re-ask; plus the resolved target entry) and sends the ask. The reply is intercepted at the top
  of `handleExecute` (`connection.js`), exactly like `pendingParam`: a value for the target's
  param → runs the original entry then the target entry with the value substituted (both through
  `runCommandEntry`, so `requires`/blocklist/confirm all still apply); "no"/"nope"/"not now" →
  runs just the original entry; "cancel" → nothing starts; anything unparseable → re-asks.
  Applied to NetPulse: "start netpulse" now asks "Also start watching the network? Reply with an
  interval in minutes" before booting the dashboard, and all six of its Python command entries
  now carry `requires: ["venv/Scripts/python.exe"]` + a setup `requiresMessage` (the existing
  `runCommandEntry` requires-gate) so a missing venv gets guidance instead of a raw spawn error.
  Note: a `risky` entry combined with `followUp` will emit the follow-up ask first and then the
  usual confirm prompt(s) for each started command — fine for non-risky entries like NetPulse's,
  worth revisiting if anyone marks a followUp entry risky.
- **`extractParamValue` anchored-mode fix (2026-08-03, found while wiring the above).** The
  anchored regex was `^\s*(?:pattern)\s*.*$` with the value read from `m[0]` — with a
  group-less pattern like NetPulse's `\d+`, a reply of "15 minutes" returned the WHOLE reply,
  so `--interval 15 minutes` got substituted into the command (argparse crash). This latent bug
  affected the existing `pendingParam` reply flow too, not just the new followUp flow. Fixed by
  wrapping the pattern in a capture group (`^\s*(pattern)\s*.*$`) so `m[1]` is just the pattern
  match: "15" and "15 minutes" both return "15". Existing anchored call sites (both reply flows)
  get the stricter, correct behavior; unanchored trigger-phrase extraction is unchanged.
- **`how_to_run` now also lists every exact configured command (2026-08-03, requested
  directly).** The `project.knowledge.how_to_run` handler appends a "**Configured commands
  (exact):**" block listing each `console.config.json` command entry's `action` (with param
  names for `{placeholder}` entries), deduped against the README/CLAUDE.md-documented command
  already shown above — so "how do I run/do X" returns the full precise command list even for
  projects whose docs don't document a run command at all.

## All run commands, site-aware suggestion, and dev-URL misroute fixes (2026-08-03, requested directly)

One change set, all harness-verified (290/290 pass, `tsc --noEmit` clean, `npm run check-intents`
zero new dupes — same baseline as the Phase-3 intent batch it follows):

- **`readmeRunParser.js` collects ALL documented run commands, not just the first.** The old
  `findDocumentedRunCommand()` returned only the first match from a project's docs, which is often
  NOT the thing you want: NetPulse's `## Run` block lists `once` first and `serve` (the actual
  web server) third. New `matchCommandLine(rawLine)` (per-line) + `allMatchingCommandLines(text)`
  (all matching lines in first-seen order, deduplicated) + `findDocumentedRunCommands(project)`:
  two-pass (labeled Install/Usage/Run/etc. sections first, all fenced blocks only if the first
  pass found nothing), returns `[{ command, doc, header }]`, capped at `MAX_DOCUMENTED_COMMANDS`
  (6). `findDocumentedRunCommand()` is kept as a first-element convenience wrapper.
- **Site-flavored asks prefer a server-shaped documented command** (`builtinIntents.js`):
  `projectTypeSuggestions()` now calls `findDocumentedRunCommands()` and picks via
  `pickDocumentedRunCommand(documents, input)` — for site-flavored input ("run the site", "start
  the web server", dashboard/frontend/page variants) it returns whichever documented command
  actually *serves* the web app (`SERVER_SHAPED_COMMAND_RE`: serve/server/flask run/uvicorn/
  gunicorn/vite/php artisan serve/npm run (dev|start|serve)/dotnet run/http.server) instead of the
  raw first match; anything else keeps exact first-match behavior. Verified against NetPulse's real
  doc set: "run the site"/"start the web server"/"run the website" → `main.py serve`; "run once"
  and "how do I run this" → `main.py once` (unchanged). `how_to_run` also now lists EVERY
  documented command as a numbered list with per-entry source labels (numbering suppressed when
  there's exactly one), then appends the configured-commands block deduplicated against the full
  documented set (was: dedupe against the single first command, a leftover of the old
  single-command assumption).
- **"what is the dev url" misroute fix** (`connection.js`): the link pre-check patterns are
  hoisted + exported (`DEV_URL_WHERE_RE`, `DEV_URL_WHAT_RE`, `DEV_URL_BARE_RE`) and now allow an
  optional determiner plus up to two in-between words ("what is the dev url", "what is the dev
  server link") — before, an in-between word broke the old `(link|url|address)` immediacy and
  "what is the dev url" fell through to the NLP stage, which misrouted it to
  `project.knowledge.stack`. A git-context guard (`DEV_URL_GIT_CONTEXT_RE`: git/github/gitlab/
  remote/repo/repository/branch/origin/merge/commit/push/pull/checkout/clone) keeps git-remote
  questions ("what is the git remote url") from ever being answered with a dev-server URL.
- **"open the project" no longer gets diverted by stage 1b** (`matcher.js`): bare "open the
  project"/"open this project"/"launch the project" are run_project seed phrases (miscIntents.js)
  that could score ≥ `CONFIG_RUN_ENTRY_FLOOR` against a project's own config entry (harness-
  measured 0.590 vs the "test project" trigger) and get silently redirected into running that
  specific command (pytest) instead of generic run_project. New `OPEN_PROJECT_RE`
  (`/^(?:open|launch)\s+(?:the\s+|this\s+)?project$/i`) exempts exactly those phrasings from the
  stage-1b config-earn redirect; the verified redirect cases ("run the site and watch at interval
  of 5 minutes" 0.565, "run the network speed" 0.721) all start with a run verb and are untouched.
- **Package.json scripts now outrank documented README/CLAUDE.md commands, and server/api/backend
  asks pick the server-shaped command** (`builtinIntents.js`, 2026-08-03, requested directly —
  "since the package file might be more current than the read me then that should be the proper
  one"). Two changes to `projectTypeSuggestions()`'s fallback ordering:
  - **Priority order is now: console.config.json entries > package.json scripts > documented
    README/CLAUDE.md command > bat launcher > language guess.** The new scripts branch
    (`scriptNames.length > 0`) lists the real `npm run ...` scripts as suggestion chips and
    returns, before the documented-command branch ever runs — a repo's package file is updated on
    every script/dependency change while the docs lag behind, so scripts are the more-current
    source of truth. The old `isJs && scriptNames.length > 0` branch lower in the function became
    unreachable and was removed; `isPython`/`isJs` were hoisted above `cfgEntries` so the new
    branch can reuse them.
  - **`SITE_FLAVORED_INPUT_RE` widened** from site/website/web/dashboard/frontend/page to also
    match server/api/backend ("run the server", "start the api", "run the backend"). Before this,
    a README-only project (no console.config.json) whose docs list a one-shot command first (e.g.
    NetPulse's `once`) answered "run the server" with `once` instead of the actual `serve` — the
    site-only list never covered server-flavored demand. Verified with a new README-only fake
    project harness (no config entries, no package.json, real NetPulse `## Run` block): "run the
    site"/"run the server"/"start the api"/"run the backend"/"run the dashboard" → serve (never
    once), "run once" → once (first-match intact), `how_to_run` lists all 5 documented commands.

## Chit-chat intelligence (2026-08-03, Phase 4 of `console-chitchat-ai-upgrade-prompt.md`)

Handler-level only — no intent/matcher/example-phrase changes, so the full dispatch control battery
is byte-identical (re-verified 298/298 after this phase). Four passes, all harness-verified at the
handler level (fake ws + stubbed `chatOnce`, no Ollama needed) + `tsc --noEmit` + `check-intents`:

- **Live-state enrichment (`buildLiveStateLine()`, `builtinIntents.js`).** Greeting and status
  replies now append a `**Live state:**` line: console port (`state.serverPort`), `N project(s)
  indexed` (`state.activeProjectsCache.length`), a running dev server for this project
  (`runningProcesses.get(project.id)` → command + `state.lastDevUrls` URL + port-collision warning
  via `withPortCollisionWarning()`), and an uncommitted-git-file count (`cachedUncommittedCount()`:
  `git status --short` via `execFile`, cached 30s per project, `null` → line omitted, errors
  swallowed). Every clause is individually try/caught so a failure in one can never break the
  reply.
- **Memory-aware greeting (`buildMemoryBlock()`, same file).** Greeting includes a `What the
  console remembers about this project` block from `memory.md` via the already-existing
  `formatMemoryForPrompt()` (2-line slice / 300 chars, omitted when the project has no memory).
  Status deliberately stays lean — no memory block there (chosen over the spec's optional
  §5.3B placement to keep the status reply tight; greeting is the one that gets the full context).
- **Project-customizable canned replies (`chatReplies` in `console.config.json`).** A project can
  override the canned pools per intent: `chatReplies: { greeting: [...], status: [...], gratitude:
  [...], farewell: [...], ack: [...] }`. `server/projectScanner.js`'s `sanitizeChatReply()` drops
  any non-array value and any unknown key at scan time (console.warn, never throws) — wired into
  BOTH config-parse sites (`discoverProjects` and `scanSingleProject`), so a malformed
  `chatReplies` can never break project discovery. The handler reads pools via `chatReplyPool()`
  with the default pool as fallback.
- **Smart chit-chat when AI is ON (`smartChitchatReply()`, same file).** Greeting and status only —
  gratitude/farewell/ack stay fully canned (deliberate scope: those don't need tailoring, and
  keeping them canned preserves the deterministic trigger-mode behavior the user asked for).
  When AI mode is enabled, the handler calls `chatOnce` (`server/ollama.js`, single bounded call —
  temp 0.7, `num_predict` 120, 8s wall-clock via `AbortSignal.timeout`, model = the user's
  `sessionContext.aiModel` or the default) with a short prompt containing project name + the
  canned reply as a fallback suggestion. Any failure/timeout/empty reply → the EXACT canned reply
  is sent instead (spec's non-negotiable). AI OFF → never called (deterministic, verified).
  Testable via `__setSmartChatOnceForTests(fn)` (module-level `let smartChatOnce = chatOnce` —
  ESM const bindings can't be reassigned, so the handler calls the mutable indirection).

Verification status: handler-harness (9/9), full control battery (298/298), lint, check-intents all
green; NOT yet exercised live through a real chat + real Ollama — expected, and the manual
verification kit in the spec (§2, §5) covers it at the end of the whole upgrade.

## AI-mode agentic loop upgrade (2026-08-04, Phase 5 of `console-chitchat-ai-upgrade-prompt.md`)

Tool/wiring layer only — no intent/matcher/example-phrase changes, so the dispatch control battery
is untouched. Implemented PASS 5.1–5.6; **5.6 (gitStage/gitCommit as dedicated tools) SKIPPED
deliberately** — git operations are already reachable through `executeCommand` + the existing
confirm flow, so dedicated tools would just duplicate that surface.

- **PASS 5.1 — per-tool permissions policy + session grants.** `console.tools.json` gains an
  optional `permissions` object (`"toolName": "ask" | "allow-after-first-ask" | "deny"`), validated
  in `pluginTools.js`'s `sanitizePermissions` at parse time (invalid values dropped with a warning,
  never crash; `executeCommand` is coerced back to 'ask' — it can never leave 'ask'). `getToolPermission()`
  reads it per call; `resolveToolGate(toolName, args, projectRoot, sessionGrants)` (tools.js) is now
  the single decision point for every tool invocation from BOTH the AI loop (`aiQuery.js`'s
  `runToolCall`) and the frontend direct path (`connection.js`'s `handleToolCall`). Hierarchy: policy
  deny (wins over everything, even grants) → not gated → always-confirm set → session grant
  (auto-approved) → normal ask. `sessionContext.toolGrants` (new, per-connection `Set` of
  `toolGrantKey(projectRoot, toolName)` strings) holds grants, filled two ways: the new
  `approve_task` WS message (the green "Approve + auto-approve file edits this conversation" button
  on the tool confirm card in `Terminal.tsx` — resolves the pending tool confirm by token AND
  pre-grants the four non-risky GATED_TOOLS for that project+session), and auto-recorded after a
  first approval when the policy is `allow-after-first-ask`. A session grant is scoped per project
  root, so it can never leak to another project.
- **Always-confirm invariant**: `ALWAYS_CONFIRM_TOOLS` (runTests, stopProcess) plus `risky: true`
  `executeCommand` can NEVER be auto-approved — no policy value and no session grant bypasses them;
  `resolveToolGate` enforces this before the grant check, and the `approve_task` handler doesn't
  grant them anyway. Belt and suspenders, matching the parse-time `executeCommand` coercion.
- **PASS 5.2 — confirmMode/approval** on tool calls: handled structurally rather than as a new
  field — the gate now returns `ask | allow | deny` + `grantKey` + `autoApproved`, and the tool_start
  events tell the user when something ran without asking ("Auto-approved: ...").
- **PASS 5.3 — process/test/self-verify tools** (`tools.js`): `listProcesses({projectId})` —
  read-only view of the `runningProcesses` map (command + dev URL + `child.spawnTime`-derived
  runningSince), ungated; `stopProcess({projectId})` — the EXACT "stop server" flow (SIGTERM + map
  delete + lastDevUrls delete + dashboard_update broadcast), always-confirm; `probeUrl({url})` —
  liveness fetch (3s timeout) restricted to localhost/private http(s) ONLY via the SSRF-inverse
  `isProbeableUrl` exported from `webSearch.js` (webSearch's own `isSafeExternalUrl` rejects
  internal addresses; probeUrl must never reach a public site or the 169.254.169.254 metadata
  endpoint — that one is deliberately excluded from the probe allowlist too); `runTests()` — runs
  the project's real test command, detected by the shared exported `findTestCommand(project)`
  (package.json scripts.test → npm test; cargo.toml → cargo test; go.mod → go test ./...;
  pyproject.toml/requirements.txt → python -m pytest; keyFiles truncated-tail marker stripped
  before JSON.parse). The trigger-mode `run_tests` handler in `builtinIntents.js` was refactored
  onto that same helper so the two paths can never drift. Bounded exec (90s/10MB) so a hung suite
  can't wedge the loop; always-confirm.
- **PASS 5.4 — MAX_TOOL_ROUNDS env override** (default 6, unchanged). Plus the self-check nudge:
  after any successful writeFile/editFile/insertAtLine/appendToFile, the tool result carries a
  `note` telling the model to verify by reading the file back (rides the same `note` channel as the
  console.config.json save-nudge).
- **PASS 5.5 — multi-hunk editFile + webSearch exposure.** `editFile` now accepts
  `oldStrings`/`newStrings` equal-length arrays; all hunks apply all-or-nothing against the evolving
  content (exact match then the whitespace-normalized fallback, shared `applySingleEdit` helper) —
  if any hunk fails, nothing is written and the error names the failing hunk. `webSearch`/
  `deepResearch` were added to `createProjectTools`'s baseTools (SSRF-guarded by the existing
  `isSafeExternalUrl`), so the AI loop can call them directly instead of only via the frontend
  Search/Deep Research toggles. New tool defs added to `BUILTIN_TOOL_DEFS` in `ollamaContext.js`.
- New WS message types (keep the useConsole.ts switch in sync, per conventions): `approve_task`
  (client → server), `task_granted` (server → client acknowledgment).
- Verification: **harness-verified** — standalone script against the real modules (48/48 checks:
  resolveToolGate matrix incl. deny-wins-over-grant and always-confirm-despite-grant, findTestCommand
  markers incl. truncated package.json, multi-hunk editFile all-or-nothing + normalized fallback,
  isProbeableUrl allowlist incl. 172.32/169.254.169.254 exclusions, Phase 5 tool presence), `tsc
  --noEmit` clean, `npm run check-intents` zero new dupes, all changed modules import cleanly.
  NOT yet exercised live through a real Ollama chat session (new tools, permissions, approve-task
  flow) — that's the end-of-upgrade live verification pass.

## Processes dock + terminal output blocks (2026-08-04, Phase 6 of `console-chitchat-ai-upgrade-prompt.md` §7)

Frontend + server — no intent/matcher/example-phrase changes (check-intents unchanged). The chat
side now renders real command output (previously `start`/`output`/`end` were folded into `bot`
messages), and a new Processes dock shows every tracked process with a per-process log replay.

- **PASS 6.1 — server ring buffer + single stop path.** `server/executor.js` now keeps
  `processLogs` (projectId → `LineRingBuffer`, tail-capped 2000 lines, memory-only; handles a line
  split across two `data` chunks by holding the unterminated tail in `pending`). New exports:
  `getProcessLog(projectId)` (`{ command, lines }` or null) and `stopTrackedProcess(projectId)` —
  the single kill+cleanup path (SIGTERM + runningProcesses.delete + processLogs.delete +
  lastDevUrls.delete + `dashboard_update` AND `processes_update` broadcasts; `{ok:false}` when
  nothing is tracked). The old three way-copies of this cleanup ("stop server" regex in
  connection.js, the AI-mode `stopProcess` tool in tools.js, and the new dock stop button) now all
  route through it. Registration also records `startedAt: Date.now()` — `child.spawnTime` turned
  out to be `undefined` on Node v24 in this repo, so the timestamp is owned by the map entry, not
  the ChildProcess. Every process start/URL-detect/close/error now ALSO broadcasts
  `processes_update` alongside the existing `dashboard_update`.
- **New endpoints** (`server/routes/monitoringRoutes.js`): `GET /api/processes` (projectId,
  command, pid, url, startedAt) and `GET /api/processes/:projectId/log` (404 when untracked;
  returns `{ command, lines }` from the ring buffer). Both live next to `/api/active-servers`.
- **PASS 6.1b — new WS message `stop_process`** (`connection.js` routeMessage): payload
  `projectId` (falls back to activeProjectId), dispatches through `stopTrackedProcess`, answers
  `Stopped \`<command>\`.` or "No running process for that project." + `end`. Same convention as
  every other message type — keep the `useConsole.ts` switch in sync.
- **PASS 6.2 — frontend Processes dock.** New `src/components/ProcessDock.tsx` (mounted in
  `Terminal.tsx` in the ToolHistoryPanel slot — the footer column is `flex-shrink-0` and the chat
  scroll container stays `flex-1 overflow-y-auto`; the dock auto-hides when nothing is running).
  Collapsed state: process count toggle + one tab per running process (pulsing live dot, shortened
  command, port if a URL was detected, red Stop button). Expanded state: copy button + `max-h-64`
  auto-scrolling mono log over the server ring buffer. `src/hooks/useConsole.ts` owns the state —
  `processes`, `processLogs`, `selectedProcessId`, `dockExpanded`; `fetchProcesses()` runs on
  mount, every 5s, and on every `processes_update` WS event (prunes dead-project logs, keeps the
  selection valid preferring the active project); `fetchProcessLog()` replays the ring buffer on
  first selection; `appendProcessOutput()` tails live output (capped 2000) into the selected
  project's log; `handleStopProcess()` sends the `stop_process` message.
- **PASS 6.3 — chat renders real output blocks.** `TerminalMessage.type` gains `'output'`.
  `start` no longer opens a `bot` markdown bubble — it opens a `{ type: 'output' }` message and
  `output`/`end` append into it. New `OutputBlock` (`Terminal.tsx`): dark mono block, auto-
  collapsed, header keeps the `▶ Executing: ...` first line visible, click to expand the
  `max-h-64` scrollable body, copy button, stays a single bubble for the whole command. `answer`
  messages remain their own separate markdown bubble. Known trade-off: sessions reloaded from disk
  lose the block styling — the server persists the merged `start`/`output`/`end` stream as one
  `bot` message on `end`, so content is preserved but the renderer can't re-split it.
- Verification: standalone harness against the real modules (18/18: buffer feed/cleanup, chunk-
  split lines kept whole, 2000-line cap + tail, `stopTrackedProcess` cleanup + double-stop) and a
  live WS+HTTP harness against the restarted server (16/16: `/api/processes` empty → populated →
  empty, startedAt, log replay, `processes_update` broadcast received, `stop_process` answers,
  404 paths). `tsc --noEmit` clean, `npm run check-intents` zero new dupes. NOT yet visually
  verified — see the checklist below.

## UI restyle (2026-08-04, Phase 7 of `console-chitchat-ai-upgrade-prompt.md` §8)

Frontend-only, no intent/matcher/example-phrase changes (check-intents unchanged), no server
changes, no spacing/scroll/flexbox changes to anything outside the targeted components. All
edits are `Terminal.tsx`/`App.tsx` class-only restyles + one new header element:

- **Top bar slimmed** (`App.tsx`): `text-3xl` title + big scan form + action buttons were
  three separate rows; now one compact row (`flex flex-wrap items-center gap-3 mb-3`, was
  `mb-8`): `text-lg` title on the left, scan input compacted to `bg-surface/50 p-1.5 rounded-lg`
  (was `p-2 rounded-xl`), and the right edge carries the active-servers pill, a NEW console-port
  pill (reads `window.location.port` directly — there was no port display in the UI before, only
  the "what port are you running on" chat intent / `state.serverPort`), Home, and Dashboard
  buttons. Header is `flex-wrap` so it can't clip at narrow widths. The scan form's
  `handleScan`/`setScanPath` wiring is unchanged.
- **Chat bubbles tightened** (`Terminal.tsx`): the scroll container is now `p-4 space-y-3`
  (was `p-6 space-y-6`). The scroll container itself is untouched beyond padding — the `flex-1
  overflow-y-auto` chatting region still owns scrolling, and the input pre-detach logic is
  unchanged.
- **Confirm cards became inline chips** (`Terminal.tsx`, same `onConfirm`/`onToolConfirm`/
  `onApproveTask`/`onMemorySuggestionRespond` handlers and same WS message types — display-only
  restyle): all three confirm-card types (risky command, AI tool approval, memory suggestion)
  dropped their `rounded-2xl rounded-bl-none px-5 py-4` bubble look for a compact `rounded-xl
  px-4 py-3` inline chip with a `[10px] tracking-wider uppercase` label and smaller buttons. The
  "Approve + auto-approve file edits" grant button survives intact (same tool gate).
- **Output blocks use theme tokens** (`Terminal.tsx` `OutputBlock`): the copy/collapse header
  no longer hardcodes `bg-black/50 border-white/10 text-gray-300`; it now uses the same
  `bg-surface border-border text-muted-foreground text-accent text-foreground` tokens as the
  rest of the opencode-styled surface, and the chevron/`background` motion on expand is the same.
- **AI status row** (`Terminal.tsx`, above the input bar): the AI ON/OFF toggle + model picker
  + mode picker moved out of the terminal header (reached/toggle overflow pinned the toggle off
  screen) into a slim `px-4 py-1.5 bg-white/5 border-t border-white/10 flex-wrap` row above the
  `AIAssistantInterface`/input area, keeping the `flex-shrink-0` wrapping protection from
  CLAUDE.md's earlier fix. The busy indicators ("Thinking... "/"Running... ") were NOT moved —
  they stay in the chat stream next to the message they describe; adding duplicates to the status
  row would have been redundant, so that went in the same pass.
- **Dashboard** (`Dashboard.tsx`): left as-is — its `bg-white/5 rounded-xl border
  border-white/10 p-4` cards, `space-y-2` list, and `.space-y-2` gap set already match the app's
  prevailing surface/radius/padding rhythm, so restyling it would be a no-op churn.
- Verification: `tsc --noEmit`/`npm run lint` clean; the phase is a pure class-string edit, so
  no behavior change to matcher/handlers/WS routes (no new message types, check-intents
  unchanged). **NOT yet visually verified** — the explicit "still needed" includes dark-mode
  (if the theme has one), the fullscreen-chat toggle, the welcome/tour overlay, and 1280/1920px
  cropping of the new slim header — per the end-of-upgrade consolidated visual pass.

## Theme system (2026-08-04, `console-theme-redesign-prompt.md` — gitignored spec)

Frontend-only; no intent/matcher/example-phrase or server changes (check-intents unchanged).

- **Dark-first identity + additive light override.** The `:root` block in `src/index.css` is the
  dark palette — **matte zinc since the 2026-08-04 UI-redesign Phase 1** (was midnight navy):
  `background #121212`, `surface #18181b`, `overlay #1e1e20`, `primary #27272A`, fg ladder
  zinc-200/300/400/500/600, `panel`/`panel-strong` stay white-alpha (render ≈#1e1e20/#27272a over
  the new bg — the spec's elevated layers). Light theme is a `:root[data-theme="light"]` override
  block (zinc neutrals: `#f4f4f5` bg — off-white since 2026-08-04, when the near-white
  `#fcfcfc` was reported as "too bright" —, `#18181B` fg), not a separate stylesheet — no `dark:`
  utilities anywhere, no rebuild needed (utilities compile via `@theme inline` to
  `var(--color-*)` refs, so the attribute swap re-themes at runtime).
- **Toggle:** `src/components/ui/ThemeToggle.tsx` (sliding sun/moon pill, borrowed from
  tobi-portfolio) mounted as the last element of the header right cluster in `App.tsx` — the ONLY
  place the theme can be switched (deliberate: no per-panel toggles). `src/hooks/useTheme.ts`
  owns state: initial value = `localStorage.theme` else `matchMedia('(prefers-color-scheme:
  dark)')`, sets `document.documentElement.dataset.theme`, persists on change. `index.html` has
  a pre-paint script mirroring the same initializer so light-mode users never see a dark flash.
- **Token ladder** (dark → light, zinc after Phase 1): `fg-strong #FFFFFF→#18181B`,
  `fg #E4E4E7→#27272A`, `fg-muted #D4D4D8→#3F3F46`, `fg-subtle #A1A1AA→#52525B`,
  `fg-dim #71717A→#71717A`, `fg-faint #52525B→#A1A1AA`; `border-faint #ffffff0d→#F4F4F5`,
  `border-soft #ffffff1a→#E4E4E7`, `border-strong #ffffff33→#D4D4D8`;
  `scrim #00000080→rgba(24,24,27,.06)`, `scrim-soft .4d→.04`, `scrim-faint .33→.03`,
  `scrim-strong .99→.08`; `panel #ffffff0a→#fff`, `panel-strong #ffffff1a→#F4F4F5`;
  `surface #18181b→#FFF`; `overlay #1e1e20→#FFF` (modal/terminal panel surfaces);
  `background #121212→#f4f4f5`, `foreground #E4E4E7→#18181B`. Accent/status colors (teal
  `#00d4a3`, blue `#3d6bff`, indigo `#6366f1`, plus Tailwind teal/red/green/yellow/orange
  status classes) are CONSTANT across themes — do not tokenize them.
- **Typography (Phase 1)**: `--font-sans` is now `'Inter', ui-sans-serif, system-ui, sans-serif`
  (Google Fonts import, offline falls back to system sans) — the base for ALL UI controls,
  headers, and conversation text. `--font-mono` stays `'JetBrains Mono'` and is reserved
  strictly for code snippets, raw terminal logs, shell paths, and port indicators. The two
  `font-serif` hero titles (App header, WelcomeScreen) were switched to sans. Grep
  `font-mono` before adding new UI text: if it isn't code/log/path/port, it should be sans.
- **Mapping conventions** (all 12 rendered components now use tokens): `text-white/100→fg-strong`,
  `text-gray-100/200→fg`, `text-gray-300→fg-muted`, `text-gray-400→fg-subtle`,
  `text-gray-500→fg-dim`, `text-gray-600→fg-faint`; `bg-white/5→bg-panel`,
  `bg-white/10→bg-panel-strong`, `border-white/10→border-border-soft`,
  `border-white/5→border-border-faint`, `hover:border-white/20→hover:border-border-strong`;
  `bg-black/50→bg-scrim`, `bg-black/30→bg-scrim-faint`, `bg-black/60→bg-scrim-strong`;
  `bg-[#12151c]→bg-surface`, `bg-[#0a0c10]→bg-overlay`; `bg-white/x` text-on-blue/teal
  buttons stays `text-white` (constant accent backgrounds). Gray families only — never collapse
  onto `text-foreground`/`text-muted-foreground` (that's what the Phase-7 tokens are for);
  the new ladder exists because collapsing would have shifted dark shades.
- **Warning/notice channel (2026-08-04, addendum to the redesign spec):** informational notices
  now render as an amber banner instead of a red error bubble. `server/executor.js`'s stderr
  sender reroutes the collapsed LF/CRLF summary (the single-line "(cosmetic, no action needed)"
  case only — mixed batches with real error text stay `error_output`) to a new `warning` WS
  message type; `createBufferedSender`'s transform may now return `{ type, text }` to reroute a
  batch to a different channel. `connection.js`'s persistence interceptor stores it as role
  `warning` so reloaded sessions keep the styling; `src/types.ts` gained `'warning'` on the
  `TerminalMessage.type` union; `useConsole.ts` handles the `warning` WS case (mirrors
  `error_output`, clears `commandPending`, appends to the dock log) and maps it to `**Notice**`
  in markdown exports / `warning` in JSON exports; `Terminal.tsx` renders it as
  `bg-amber-500/10 border-amber-500/30 text-amber-400` with an `AlertTriangle` icon (sans, not
  mono). `useSessions.ts` needs no change (generic role cast). Light-theme background token was
  also moved `#FAFAFA` → `#fcfcfc` → `#f4f4f5` (off-white, 2026-08-04, per user report that the
  near-white was "too bright"; `#f4f4f5` is zinc-100, already in the palette as panel-strong).
- `GlowOrbs.tsx` orbs got a `glow-orb` class + `:root[data-theme="light"] .glow-orb { opacity:
  0.5 }` rule (dark keeps full intensity). `DisplayCards.tsx`/`v0-ai-chat-demo.tsx` remain
  unused/unimported and were deliberately NOT tokenized (out of scope).
- **Verified:** `tsc --noEmit` clean; Vite transforms 200 for App/Terminal/ThemeToggle; compiled
  CSS contains the light block, `--color-overlay`, the glow-orb rule, and var-ref utilities.
  **NOT yet visually verified** in a real browser at both themes — manual checklist: dark looks
  identical to pre-theme, light reads well across welcome/tour/dashboard/terminal/dock, toggle
  persists across reloads, no scroll/flex changes anywhere (all edits were class-string swaps).
- **Fixed 2026-08-04 (found during the manual light-mode pass):** AI markdown replies wrapped in
  `prose prose-invert` (`Terminal.tsx`) — `prose-invert` is Tailwind Typography's *hardcoded light
  palette* regardless of theme, so light mode showed pale text on white. `prose-invert` removed;
  `src/index.css` now carries a plain `.prose` rule mapping the typography variables to the theme
  tokens (`--tw-prose-body: var(--color-fg)`, headings `fg-strong`, links `accent`, code `fg`,
  pre-code `fg-muted`, quotes/bullets/hr/table borders from the border/fg ladder). Deliberately
  does NOT set `--tw-prose-pre-bg` so the existing `prose-pre:bg-scrim` utility keeps supplying
  the (theme-aware) code-block background — an unlayered rule would otherwise beat the layered
  utility. Dark mode reads essentially identical to the old invert palette; light gets dark text.

## UI + AI-stream fixes (2026-08-04, found in the NetPulse chat export + fullscreen/light testing)

- **ADDENDUM 2 (full-screen layout + telemetry, 2026-08-04):** all in `Terminal.tsx` only.
  Fullscreen mode now centers the entire chat column (`mx-auto w-full max-w-3xl` via
  `centerCol`, applied to the message thread, the AI status row, and both input containers)
  so bubbles never stretch across a wide monitor; the Ctrl+R history overlay centers itself
  too (`inset-x-0 mx-auto max-w-3xl` when fullscreen, `left-4 right-4` otherwise). Non-
  fullscreen layout is untouched. Header keeps the fullscreen toggle, Markdown/JSON exports,
  and `>_ Connected: <Project>` badge (top-left, unchanged); the header row gained
  `flex-wrap` and a new **session menu** (⚙ `Settings` icon) that reuses existing handlers
  only — Export Markdown / Export JSON / Tool Call History / Clear Workspace (when the
  workspace is non-empty) — no new WS messages. Performance telemetry: the server's trailing
  `\n\n_(2.0s, 9 tok/s)_` content note (appended by `server/ollama.js` `chatStream`) is now
  stripped from the rendered markdown by `splitTelemetry()` (module-level `TELEMETRY_RE`,
  exact end-anchored match so real content can't be eaten) and rendered as a muted footer
  (`text-xs font-mono text-fg-dim`) below the response block; raw content in storage/exports
  is unchanged. Status-card styling (item 3b: "subtle dark surface cards") was already
  delivered by Phase 7 — `OutputBlock` is `bg-surface border-border` with a `p-3 font-mono`
  body and no heavy grey/maroon boxes remain — no further change needed. Ctrl+R history was
  already implemented (Terminal.tsx keydown handler + overlay) and is preserved as-is.
  Verified: `tsc --noEmit` clean, Vite serves the new module; NOT visually re-checked in a
  browser at 1920px fullscreen — the centered column and menu need a live look.
- **Home button did nothing once a project was selected.** `App.tsx`'s Home set `showWelcome`,
  but the welcome tree only rendered when `showWelcome && !activeProject` — with an active project
  (the normal state) it was a dead button. The `!activeProject` condition was dropped (WelcomeScreen
  has no activeProject dependency — verified) and Home now also closes the Dashboard and exits
  fullscreen chat, so it's a true "home" that keeps the current project/session (per request).
- **Empty AI reply (real NetPulse export: first "Add a line to my read me" got an empty bubble).**
  `stream_start` commits a placeholder bot message; if a stream ends with zero `token` events
  (empty completion), `stream_end` left it empty. `useConsole.ts` now tracks
  `streamHadTokenRef` (set on any token event — the 16ms flush timer can empty `tokenBuffer`
  legitimately, so the ref, not the buffer, is the signal) and on `stream_end` replaces a
  content-less message with "(AI returned no response — try rephrasing your request.)". Also fixed
  in the same pass: `streaming: true` was never cleared on any stream — every AI message kept the
  flag forever; `stream_end` now clears it.
- **Triple "AI Assistant activated" banner (same export).** `useAI.ts`'s `handleAIToggle` ON path
  is async (Ollama status fetch + possible model auto-pick); rapid re-clicks ran it multiple times
  over, each appending its own activation banner. Wrapped in a `toggleBusyRef` in-flight guard
  (try/finally, so error paths reset it too).

## User profile (2026-08-04, requested directly)

- App-global identity (name/title/customRole) persisted to `data/user-profile.json` (NOT per-
  project `console.config.json` — deliberate: the profile is user identity, not project config,
  so it has one owner, never triggers the per-project config file watcher, and `data/` is already
  excluded from Vite's watch so saves never cause an HMR reload). `data/user-profile.json` is
  tracked by git (personal config, not a secret) — unlike the gitignored `data/conversations/`,
  `data/near-misses/`, `data/telemetry/`.
- `server/routes/profileRoutes.js` — `GET /api/profile` (reads file, missing/corrupt → defaults,
  never writes) and `POST /api/profile` (sanitizes: strings only, trimmed, control chars
  stripped, 120-char cap, invalid fields fall back to current value; mkdir + write; returns the
  sanitized profile so the client can reflect it). Both registered in `server/index.js`.
- Frontend: `src/hooks/useUserProfile.ts` (fetch on mount with the same defaults as the server —
  first paint is identical to the old hardcoded hero; `updateProfile` is optimistic + POST and
  reflects the server's sanitized response back; `getFormattedName()` returns bare name when
  title is empty/'none'), `src/components/UserProfileModal.tsx` (gear ⚙ `Settings` button in
  App's header right cluster → modal with Name/Title/Custom Role, Esc/backdrop close, Save
  disabled while any field is empty). The welcome hero's `TextScramble` now takes a `greeting`
  prop built from `getFormattedName()` — TextScramble re-animates when the profile loads/updates.
- Client-only for now: server-side chit-chat greeting pools (`builtinIntents.js`) are untouched
  — making them profile-aware would need server-side profile reads and was explicitly out of
  scope for this feature.
- **Randomized personalized greetings (2026-08-04):** new `src/utils/greetings.ts` — pure client
  display text, zero server involvement. `getRandomGreeting(formattedName)` (20 templates,
  "Welcome back, ${name}." family) feeds the welcome hero: `App.tsx` memoizes it as
  `heroGreeting` keyed on `profile`, so it re-rolls only when the profile loads/saves, not per
  render, and passes it through the existing `greeting` prop (WelcomeScreen unchanged).
  `getRandomChatPrompt(name)` (10 templates) feeds the chat empty-state placeholders: `Terminal`
  gained an optional `userName?: string` prop (App passes `profile.name`), computes
  `chatPrompt` via `useMemo` keyed on `[userName, activeProject?.id]`, and swapped the final
  placeholder fallback in both the plain input ("Ask a question or enter a command..." → the
  random prompt) and the AIAssistantInterface `'Ask me anything...'` fallback. The earlier
  conditional placeholders (no-project / thinking / running / blocked) are all unchanged.
  `UserProfileModal`'s Title input gained a `<datalist>` (Master / Engineer / Dev / Dr. / None)
  so the field is a dropdown-or-type per the spec.

## Empty-state greeting, persisted dev URLs + server scan, and did-you-mean chips (2026-08-04, requested directly)

Three approved features, one combined commit:

- **Centered empty-state greeting + action chips (Feature A, frontend-only).** `TerminalMessages.tsx`
  renders `TerminalEmptyState.tsx` (new, ~30 lines, pure display) when `messages.length === 0`,
  inside `${centerCol} min-h-full flex flex-col items-center justify-center` (the old `space-y-3`
  list renders otherwise — one ternary, both branches share the same scroll container so
  `flex-1 overflow-y-auto` scrolling and the `endRef` anchor are untouched; `endRef` only mounts
  when non-empty and the auto-scroll effect uses `?.` so the empty state is a safe no-op).
  Prompts come from `getRandomEmptyStatePrompt(name)` (22 templates in `src/utils/greetings.ts`)
  and chips from `getEmptyStateActions(activeProject)` — 4 with a project (`check git status`,
  `what is this project`, `run the site`, `show running processes`) / 3 without (`help`, `what
  can you do`, `list projects`). Chips are plain chat messages (`onSendMessage`), so every
  confirm gate still applies. `Terminal.tsx` memoizes both (`useMemo` keyed on
  `[userName, activeProject?.id]` / `[activeProject]`).
- **Persisted dev URLs + on-demand liveness probe + `scan for servers` intent (Feature B).
  Root cause of NetPulse "idle": `/api/active-servers` only lists the in-memory
  `runningProcesses` map (populated only when the console itself spawns a command) and
  `state.lastDevUrls` was in-memory too — servers started outside the console were invisible.
  New `server/devUrlStore.js`: `loadDevUrls()` (startup, in `index.js`), `recordDevUrl`/
  `forgetDevUrl` (debounced 500ms atomic persist to `data/dev-urls.json`, gitignored — NOT
  like the tracked `data/user-profile.json`) wired at executor.js's URL-detect/cleanup sites.
  New `server/livenessProbe.js`: `probeUrl(url, timeoutMs)` (fetch + AbortController, reuses
  `isProbeableUrl` from webSearch.js — SSRF-inverse: localhost/private http(s) only, refuses
  public URLs AND the 169.254.169.254 metadata endpoint) and `scanProjectServers(projects,
  {timeoutMs, concurrency})` — probes ONLY projects that have a recorded URL, 2s bound, worker
  pool 3. **No background scanning ever — probe only when asked** (the "is the server running"
  family, the "what is the link" pre-check at connection.js ~line 703, or the new intent).
  Honesty rule: never claim a server is up from a stale URL — `dev_server_status`
  (builtinIntents.js) and the pre-check now probe the persisted URL when nothing is tracked →
  "still responding at <url> — started outside the console, so I can't stop it from here" vs
  "not responding — say 'run the site' to start it". New intent `project.context.scan_servers`
  ("scan for servers", "which servers are up" — 17 phrases in projectContextIntents.js,
  registered in `BUILTIN_INTENTS`) answers a live/dead table; harness-verified: alive probe,
  dead port, public-URL refusal, metadata-endpoint refusal, only-URL-having-projects probed.
  `check-intents`: identical pre-existing set, 0 new (baseline re-measured at 2254 phrases/78
  intents before, 2271/79 after — the documented "6 cross / 72 near" was older, the current
  baseline is 5 cross / 80 near).
- **Did-you-mean buttons (Feature C).** `semanticMatcher.match()` now also returns
  `closeSecond` (best DIFFERENT intent when the true margin is within `CLOSE_MARGIN` 0.10 —
  the existing 0.03 blocking-collision question is untouched and takes precedence) and a new
  `nearestIntent(input)` method (raw best intent with no floor/margin gating). `matcher.js`
  passes `closeSecond` through stage 1b (guarded by the same trust checks + `BUILTIN_INTENTS`
  membership as the winner) and on total no-match computes `didYouMean` from `nearestIntent`
  when ≥0.45 (skipped for pure-chitchat intents on real-request inputs — same trap as
  `PURE_CHITCHAT_INTENTS`). `connection.js` sends a new `did_you_mean` WS event (data includes
  a `label` from the existing `describeIntent()`) after builtin answers and on the fallback
  path (before `suggestions`), and handles a new `did_you_mean_pick` message: resolves a
  pending blocking-disambiguation question if one is active for this project, else dispatches
  `handleBuiltinIntent` directly — same path a typed "1"/"2" reply uses. Frontend (keep the
  `useConsole.ts` switch in sync, per conventions — both new message types added there):
  `TerminalMessage.didYouMean` in `src/types.ts`, chips rendered under the bubble in
  `TerminalMessages.tsx` ("DID YOU MEAN:" label + one teal chip, same style as suggestion
  chips), `handleDidYouMeanPick` in `useConsole.ts` wired through `Terminal` → `App`.
  Harness-verified: clean matches carry `closeSecond: null`, garbage input scores 0.33 →
  no chip, "please to running the site for me today" (0.63, below floor) → chip for
  `run_project`.

## Modularization phases (2026-08-04, file-splitting refactors)

Ongoing effort to keep every logic file under ~150 lines (data-only registries may reach
150; the "~400 lines" guidance in Conventions is the older, looser rule). Pure copy-moves,
zero behavior change; one commit per phase; lint + check-intents must stay green each phase
(baseline: 1 within / 5 cross / 80 near @ 2271 phrases / 79 intents).

- **Phase 1 (ffd882c) — leaf utils + shared UI atoms.** NEW `server/urlSafety.js`
  (isSafeExternalUrl + isProbeableUrl from webSearch.js), `server/regexUtils.js`
  (escapeRegExp + keywordRegex from contextResolver.js), `server/markdownUtils.js`
  (extractFencedBlocks + splitIntoSections from readmeRunParser.js); NEW `src/utils/`
  helpers (apiFetch, formatPath, formatUserName, getWebSocketUrl, makeMessage, process,
  storedToTerminalMessages, waitForSocketOpen) and `src/components/ui/` atoms
  (CopyButton, ModalShell, WorkspaceToggleButton). webSearch.js re-exports isProbeableUrl
  to preserve its original export surface.
- **Phase 2 (a6a5ece) — data registries.** Pure-data tables extracted from logic modules:
  `runCommandPatterns.js` (from readmeRunParser), `guessData.js` (GUESSES, 16 entries, from
  commandGuesser), `platformCommand.js` (isWindows only), `routerData.js`
  (INTENT_DESCRIPTIONS, from localRouter), `toolDefs.js` (BUILTIN_TOOL_DEFS, 20 tools,
  from ollamaContext), `aiModePrompts.js` (MODE_INSTRUCTIONS, from ollamaContext),
  `promptRenderers.js` (formatIndex/formatProjectDoc/formatMinimalProject + 6000-char caps,
  from ollamaContext), `guessToIntent.js` (GUESS_TO_INTENT, from learningEngine),
  `nlpSeedIntents.js` (NLP_SEED_INTENTS as [phrase, intent] tuples, from nlpEngine),
  `memoryThresholds.js` (QUESTION/COMMAND/FILE_EDIT thresholds + adaptiveThreshold, from
  projectMemory). Rewired: commandGuesser (now JSDoc + import + guessCommand only),
  localRouter, nlpEngine, learningEngine, projectMemory, readmeRunParser, ollamaContext
  (244 → 126 lines).
- **Phase 3 (c193291) — telemetry cycle-break + threshold/stats extraction.** NEW
  `server/telemetryFile.js` (leaf: TELEMETRY_DIR, filePath, ensureDir, readTelemetry,
  appendTelemetry, updateTelemetryEntry, clearTelemetry, listTelemetryProjectIds),
  `server/telemetryThresholds.js` (DEFAULT_FLOOR + persistable overrides),
  `server/telemetryStats.js` (getIntentStats aggregation). Rewired: confidenceModel.js
  imports telemetryFile only (cycle broken: telemetryFile ← confidenceModel ←
  intentTelemetry; intentTelemetry also imports telemetryFile + telemetryThresholds +
  telemetryStats, re-exports threshold/file/stats ops so matcher.js/connection.js/index.js
  callers unchanged). intentTelemetry.js 241 → 122 lines; confidenceModel.js 214 → 179
  (still >150 — optional logisticRegression/modelStore split deferred). semanticMatcher.js
  has since been split too (2026-08-04, 5 commits `497e9df` → `9a88785` — see "Matching
  pipeline gotchas" for the new module map and the `check-matcher` harness). Remaining large
  files for later phases: nearMissLogger.js,
  learningEngine.js (151), projectMemory.js (210), conversationStore.js.
- **Phase 3 follow-up (24343c2) + Phases 4a/4b — remaining large files (each under 150
  lines, all later verified):** confidenceModel.js split into `server/logisticRegression.js`
  (gradient descent) + `server/modelStore.js` (persistence) → 144 lines; projectMemory.js
  split into `server/memoryStore.js` (storage) + `server/memoryThresholdChecks.js`
  (threshold logic) → 98 lines; learningEngine.js split via `server/nearMissIntentMap.js`
  (near-miss → intent mapping) → 149 lines. These three commits happened after the
  Phases 1–3 docs above were written and were never recorded here until this entry.
- **Phase 5 (2026-08-04, 5 commits `497e9df` → `9a88785`) — semanticMatcher.js
  modularization.** Detailed in "Matching pipeline gotchas" above (module map:
  preSemanticOverrides/keywordRules/matcherStages/intentVectorScan + the `check-matcher`
  harness). semanticMatcher.js 762 → 448 lines of pure orchestration.
- **Phase 6 (2026-08-04, conversationStore split).** `server/conversationStore.js` 358 →
  ~150 lines of pure orchestration; new leaf modules (all logic unchanged, no cycles):
  `server/sessionPaths.js` (path helpers + LEGACY_STORE_DIR/INDEX_PATH consts),
  `server/sessionIndex.js` (index CRUD over data/conversations/index.json, exports
  ensureLegacyDir too), `server/messageLog.js` (readMessageLog, NDJSON last-N),
  `server/chatLog.js` (appendChatLogEntry — the live chat-log writer from appendMessage;
  the old unused `appendToChatLog` was dead code, deleted as part of the extraction), and
  `server/sessionMigration.js` (ensureGitignored/ensureProjectConsoleDir/getSession/
  migrateLegacySession/linkSessionToProject — getSession lives here so linkSessionToProject
  can use it without a module cycle). `conversationStore.js` re-exports getSession/
  linkSessionToProject/ensureGitignored from sessionMigration so every external importer
  (sessionRoutes/aiQuery/connection/builtinIntents/memoryStore) is untouched. Verified:
  lint clean, 20/20 round-trip probe (create → append ×2 with isMarkdown → read-back →
  chat-log.md + .gitignore side effects → delete → index entry removed), check-matcher
  68/68, check-intents baseline (1/5/80). After this phase, every file on the original
  "remaining large files" list is under 150 lines — only the big orchestrators/giants
  remain (matcher.js 437, tools.js 770, builtinIntents.js 1732, connection.js 1274,
  executor.js 507, codebaseIndexer.js 749, useConsole.ts 747), all out of scope for the
  split-by-concern series so far.
- Verification: Phases 1–3 lint-clean; check-intents identical to baseline (1/5/80);
  import smoke + guessCommand battery pass. Phase 1 commit excludes the
  data/user-profile.json write (live dev server on :3000).

## Matchday Exchange transcript fixes (2026-08-04, reported directly — 4 bugs, 4 commits)

- **"run server" misrouted to `project.context.scan_servers` and "run its server" to
  `project.context.dev_server_status` instead of starting the server** (harness-confirmed with
  real embeddings). Fixed with a `PRE_SEMANTIC_OVERRIDES` entry in `semanticMatcher.js`
  (start-anchored `run/start/launch/boot/restart/spin up` + `server|backend|api` noun, optional
  trailing "please") routing to `run_project` — narrow, same rule as the rest of that list
  (only for confirmed traps). Status/scan phrasing ("is the server running", "scan for servers")
  verified unaffected. Commit `5fc7729`.
- **The duplicate-dev-server guard blocked "run the site" whenever a process was tracked AND any
  dev-family script existed.** `run_project`/`npm_run` in `builtinIntents.js` now only refuse when
  the tracked command equals the exact requested script (`npm run dev`/`npm start`/`npm run
  serve`) — Matchday Exchange legitimately runs vite:3001 AND tsx backend:4400 concurrently, and
  both are startable. Same commit.
- **Reloaded sessions lost styling and the whole AI tool trace.** `conversationStore.js`
  `appendMessage` now persists an optional `isMarkdown` field; the `connection.js` interceptor
  persists `isMarkdown: true` for answers (false for buffered command output), plus
  `tool_start`/`tool_result` as new `role: 'system'` lines (previously dropped entirely);
  `storedToTerminalMessages.ts` maps it back with a `role === 'bot'` legacy fallback. Round-trip
  smoke-tested. Commit `f4263aa`.
- **Stop/cancel didn't reflect live in the Dashboard: `/api/dashboard`'s 30s cache was never
  invalidated** — the WS-triggered refetch hit a stale payload, so a stopped process kept showing
  "running" for up to 30s. Now gated on a `volatileSignature()` (project ids + runningProcesses +
  lastDevUrls); any process/URL change bypasses the cache while the expensive git calls stay
  TTL-cached. Harness-verified (start/URL/stop each invalidate). Commit `77ae265`.
- **Servers started OUTSIDE the console were invisible to "scan for servers" / "is the server
  running" / "what is the link"** when the console had never recorded a URL. New
  `candidateDevUrls(project)` in `livenessProbe.js`: derives candidate `http://localhost:<port>`
  URLs from the project's own package.json script port hints (`--port N`, `-p N`, `PORT=N`;
  truncation marker stripped before parse; console's own `state.serverPort` excluded so a
  port-collision can't false-positive). `scanProjectServers` probes candidates (1s bound, global
  cap 10, separate worker index — the first draft shared a counter between the two pools and
  raced) for URL-less projects and `recordDevUrl`s alive hits; `dev_server_status` and the "what
  is the link" pre-check probe candidates as a last-resort before giving guidance. Harness: 18/18
  (unit port-hint parsing + live HTTP server integration incl. console-port exclusion and
  record-on-hit). Commit `a6f15c7`.
- All four: `tsc --noEmit` clean, check-intents at baseline (1/5/80), harness-verified only —
  the live server at :3000 predates these commits and needs a restart to pick them up.

## Conventions

- No file over ~400 lines; split by concern (see `server/wsHandlers/` for the pattern).
- Tools/handlers take named-args objects, not positional args.
- New WS message types belong in both `server/wsHandlers/connection.js` (or wherever emits them)
  and the frontend's `useConsole.ts` `handleWebSocketMessage` switch — keep them in sync.
