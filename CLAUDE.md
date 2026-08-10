# CLAUDE.md — Local Project Console

Read this first, before exploring code. Update it in place (replace stale info, don't append
a changelog) after any fix or new discovery. Keep it under ~150 lines per section.

## What this is

A local, offline command dispatcher + optional local-AI (Ollama) chat for Tobi's project
folders (`C:\Users\tobil\Desktop\Projects\<name>`). Express + WebSocket backend, React 19 +
Vite frontend. Full description: `README.md` (current, professional-facing). This file is
the source of truth for "what's actually here now". `BUILD-SPEC-v4.md` is a historical
design doc — describes intent at the time, not current state.

## Run it

```powershell
Set-Location -Path "C:\Users\tobil\Desktop\project-console"
npm install
npm run dev     # tsx server/index.js, http://127.0.0.1:3000
npm run lint    # tsc --noEmit
```

- `start.bat` handles port fallback (3000 → 3001-3010) automatically; the frontend derives
  the WebSocket URL from `window.location`, so it follows whatever port the server used.
- **Global npx launcher**: `node bin/cli.js` (or `npx local-project-console`) imports the
  bundled or source server into the same process and polls `globalThis.__consoleServerPort`
  (a process-global integer set by `server/index.js` once the port-fallback loop binds).
  This avoids ESM module-realm duplication (the esbuild bundle inlines `server/` modules).
  The wrapper auto-opens the browser on detection.
- **Background daemon mode**: `scripts/start-daemon.ps1` starts the server hidden and writes
  the bound port to `logs/daemon.port`; `scripts/stop-daemon.ps1` kills by port (not PID —
  robust even when the cmd.exe wrapper exits before npm); `scripts/add-to-startup.ps1`
  registers login startup.
- CLI chat mode: `node server/cli-client.js [--dir "<full path>"] [--project "<name>"]`;
  it scans ports 3000-3009, retries up to 90s (cold boot is ~41s), and reports which port it
  connected on. Interactive arrow-key picker via @clack/prompts when a TTY is available,
  numbered-list fallback otherwise; invalid input re-asks instead of guessing.

## Architecture

`server/index.js` is a thin orchestrator only — routes and WS logic live elsewhere:

- `server/state.js` — shared mutable state (scan directory, project cache, pending confirmations,
  `state.serverPort` set once the fallback loop binds)
- `server/wsServer.js` — the `wss` instance + `broadcast()`
- `server/mockProjects.js` — seeds fake projects on non-Windows sandboxes
- `server/routes/` — `projectRoutes.js`, `sessionRoutes.js`, `searchRoutes.js`,
  `monitoringRoutes.js` (`/api/metrics`, `/api/active-servers`, `/api/processes` +
  `/api/processes/:projectId/log`, `/api/dashboard` with a 30s cache invalidated by a
  `volatileSignature()` over projects+runningProcesses+lastDevUrls), `profileRoutes.js`
  (`data/user-profile.json` — tracked by git, unlike gitignored conversations/near-misses/
  telemetry/dev-urls)
- `server/wsHandlers/` — `connection.js` is a ~14-line re-export shim; real logic lives in
   ten leaves (see Phase 11): `connectionLifecycle.js` (heartbeat, WS init + connect-time
   `ai_status` push so the client's AI toggle syncs to the fresh per-connection defaults after
   a reconnect, the ws.send persistence interceptor with the command-output buffer), `connectionRoutes.js` (14 WS
   cases incl. `stop_process`/`did_you_mean_pick`/`approve_task`/`ai_toggle`/`ai_set_model`/
   `workspace_set`/`learning_*`/`memory_suggestion_respond` + `abort_ai` +
   `sendAiStatus`),
  `connectionExecute.js` (`handleExecute` orchestrator: session-lock check, four pending-ask
  interceptors, typed-command bypass, admin blocks, AI dispatch — with a narrow `AI_ACK_RE`
  short-circuit so bare "ok"/"thanks"/"got it" replies instantly without a model call (a real
  NetPulse chat burned ~14 streams on a single "ok"; "yes"/"no"/"sure" are deliberately NOT
  acked — they can be answers to a pending question) — direct-cmd regex +
  `guessCommand` confirm path, then the matching pipeline), `connectionMatching.js`,
  `connectionConfirm.js` (5-min expiry, stdinWrite, tool-token resolve, fileOp),
  `connectionToolCall.js` (resolveToolGate + ask/auto-approve), `connectionDevServer.js`
  (`DEV_URL_*` regexes — exported, used by builtinIntents/readmeRunParser; stop-server
  handling incl. bare "stop it" only when `runningProcesses.has(project.id)`),
  `connectionTelemetry.js`, `connectionAdminCommands.js`, `connectionInterceptors.js`
  (pendingParam/pendingFollowUp/pendingDisambiguation/pendingMemorySuggestion), plus
  `builtinIntents.js` (~45-line dispatcher over six per-domain leaf modules — see below),
  `matchedEntry.js` (config-entry dispatch incl. params/requires/followUp),
  `aiQuery.js` (tool loop: `aiQueryDetectors.js` narrating/fabrication detectors,
  `aiQueryToolRun.js` gated execution + preview — the `executeCommand` tool result now
  includes the real tracked PID from `runningProcesses` (`{timeout:true}` results include
  `pid`/`running`); the model previously invented a PID (real NetPulse chat claimed "PID
  9128") — `aiQueryContext.js` system-prompt builder),
  `aiStream.js` (token streaming + `<tool_call>` extraction, `think: true` separation of
  thinking vs content)
- `server/tools.js` — ~105-line orchestration composing leaf factories; tools are sandboxed
  to the active project (path escapes rejected incl. symlinks). Tools: `readFile`, `writeFile`,
  `editFile` (multi-hunk all-or-nothing, whitespace-normalized fallback), `findFiles`,
  `insertAtLine`, `appendToFile`, `searchCode`, `listFiles`, `getProjectInfo`, `getGitStatus`,
  `undoLastChange`, `saveMemory`, `listProcesses`/`stopProcess`/`probeUrl`/`runTests`,
  `webSearch`/`deepResearch`, plus per-project custom tools from a `console.tools.json`
  manifest (each substituted arg passes `isSafeParamValue()`; resolved command re-checked
  against `isCommandBlocked()`; the manifest's `risky` flag only controls confirmation).
  Leaves: `toolConstants.js`, `toolEdit.js`, `toolScan.js`, `toolAllow.js` (ALLOWED_COMMANDS
  + env-var-prefix stripping), `toolGate.js` (the single approval-gate decision point:
  `GATED_TOOLS`, `ALWAYS_CONFIRM_TOOLS` (runTests, stopProcess), `CUSTOM_RISKY_TOOLS`,
  `getToolPermission`, `toolGrantKey`, `resolveToolGate`), `toolProcess.js` (+
  `findTestCommand` — shared with the trigger-mode `run_tests` handler), `toolSandbox.js`,
  `toolFileOps.js`, `toolFileEdit.js`, `toolFileSearch.js`, `toolProjectInfo.js`
- `server/dangerousPatterns.js` — hard blocklist (last resort, not a security boundary)
- `server/confidenceModel.js` — logistic regression on real accept/reject telemetry
  (logisticRegression.js + modelStore.js); `server/intentTelemetry.js` (+ telemetryFile/
  telemetryThresholds/telemetryStats) — per-intent confidence floors, `suggestThresholds()`,
  auto-apply sweeps on startup
- `server/codebaseIndexer.js` — ~185-line orchestrator + leaves `codebaseData.js`
  (36 export consts: IGNORE_DIRS/KEY_FILES/ENTRY_NAMES/CODE_EXTS/REAL_CODE_EXTS/
  SIGNATURE_PATTERNS_BY_EXT/MAX_* caps), `codebaseParsers.js` (TS compiler API for
  JS/TS/TSX signatures — promoted to a real dependency — regex for Go/Rust/Java/Ruby/PHP/C#/
  Python; imports + reverse "used by" index; Express/Flask/FastAPI/Django route extraction),
  `codebaseDetection.js` (detectLanguages — skips unmapped extensions, no fabricated entries;
  detectFrameworks; findEntryPoints across the whole tree; detectSubPackages for monorepos),
  `codebaseScans.js` (findTodos/findBiggestFiles/findRecentActivity — on-demand, capped,
  NOT cached in the index)
- `server/projectScanner.js` + `projectScanHelpers.js`/`projectScanSingle.js`/
  `projectScanContainer.js` — discovery: console.config.json / CONTEXT_FILENAMES
  (CLAUDE.md, README.md, ABOUT-TOBI.md, UNIVERSAL_CONTEXT.md — CLAUDE.md always first) /
  package.json; code-only fallback via `isRecognizableByCodeAlone()` (`REAL_CODE_EXTS`,
  key config files, or a real `.git` dir) with a synthesized fallback config; `discoverProjects`
  checks whether the baseDir is itself a single project root before descending; chatReplies
  sanitized at scan time (invalid values dropped with console.warn, never crash)
- `server/scriptEntries.js` — auto-derives command entries from package.json scripts
  (tagged `auto: true`, hand-authored wins on collision, `requires: ['node_modules']` attached)
- `server/readmeRunParser.js` — documented run-command extraction (`matchCommandLine`/
  `allMatchingCommandLines`/`findDocumentedRunCommands`, capped at 6; labeled sections first,
  fenced blocks fallback; Python patterns accept venv-style interpreter prefixes;
  `firstMatchingCommandLine` returns the full command segment, stops at `#`/`//` comments and
  `&&`/`||`)
- `server/paramCommand.js` — `{param}` substitution for config entries; `isSafeParamValue()`
  rejects shell metacharacters regardless of the entry's own pattern; anchored extraction uses
  a capture group so replies like "15 minutes" yield just "15"
- `server/outputSummarizer.js` — post-exit summary (exit code, recognized error lines, npm
  added/removed + vulnerabilities, git commit/push/conflict lines, LF/CRLF count); null for
  short output
- `server/devUrlStore.js` — persisted dev URLs (`data/dev-urls.json`, gitignored, debounced
  500ms atomic write); `server/livenessProbe.js` — `probeUrl()` + `candidateDevUrls()`
  (package.json port hints, `COMMON_DEV_PORTS` fallback, console's own `state.serverPort`
  always excluded) + `scanProjectServers` (probe only when asked, never in the background)
- `server/diffPreview.js` — pure LCS line diff + `simulateEditContent()` for file-edit
  confirm cards; never blocks confirmation, null on any failure, skips >400-line files
- `server/executor.js` — ~164-line orchestrator (`executeCommand` + venv rewrite; refuses only
  a literal duplicate of an already-tracked command, everything else runs concurrently) over
  leaves: `executorOutput.js` (ANSI/URL regexes, `collapseLfCrlfWarnings`, `createBufferedSender`
  150ms coalescing; stderr batches may reroute to a `warning` WS channel),
  `executorPorts.js` (PORT_PROMPT_RE interactive-port detection → stdinWrite confirm flow;
  `extractBusyPort`/`buildPortRetryCommand` EADDRINUSE retry),   `executorProcesses.js`
  (`runningProcesses` is MULTI-SLOT per project — `Map<projectId, Map<pid, entry>>` since the
  2026-08-10 NetPulse serve+watch fix, so several commands can run concurrently and each owns
  its own slot; `processLogs` LineRingBuffer 2000-line cap is per-project shared; `stopTrackedProcess`
  — the single kill+cleanup path: SIGTERM on EVERY tracked process for the project + map/log/URL
  cleanup + `dashboard_update` + `processes_update` broadcasts; `removeTrackedProcess` deletes one
  pid and cleans the project key when its slot empties; `process.on('exit'/'SIGTERM')` cleanup),
  `executorDevServer.js` (`isDevServerCommand`, `buildDetachMessage`). Tuning knobs are
  exported named constants (`DEV_URL_DETACH_GRACE_MS`, `DEV_SERVER_FORCE_DETACH_MS`,
  `LONG_RUNNING_FORCE_DETACH_MS`, `STDOUT_SUMMARY_CAP`, `STDERR_SUMMARY_CAP`); likewise
  `semanticMatcher.js` exports `FUSE_THRESHOLD`/`FUSE_MIN_MATCH_CHAR_LENGTH`/
  `INIT_WAIT_POLL_MS`/`SUGGESTION_DEFAULT_LIMIT`/`COLLISION_DEFAULT_THRESHOLD` — edit those,
  not inline literals.
- `server/matcher.js` — ~253-line orchestrator; leaves: `intentRegistry.js` (`BUILTIN_INTENTS`
  — the dispatch gate that has silently killed intents 6+ times; `CONFIG_RUN_ENTRY_FLOOR` 0.55,
  `OPEN_PROJECT_RE`, `ROUTER_REPO_MAP_CHARS` 1200, `describeIntent`), `intentTrust.js`
  (`PURE_CHITCHAT_INTENTS`, `KNOWLEDGE_INTENTS_NEVER_ABOUT_A_FILE`, `looksLikeRealRequest`,
  `isTrustworthyChitChat`, `isTrustworthyKnowledgeIntent`), `matchHelpers.js`
  (tryLookupEntry/captureTelemetry/getFallbackSuggestions/computeDidYouMean)
- `server/semanticMatcher.js` — embedding + Fuse.js (`threshold` 0.55) matching; stages in
  `preSemanticOverrides.js` (stage 0 literal rules — keep narrow, confirmed traps only),
  `matcherStages.js` (semantic stage floor 0.6 + 0.03 margin + close-second pass; fuzzy stage
  length-scaled floor), `intentVectorScan.js` (cosine machinery, `bestProjectActionVector`,
  `averageIntentVectors`), `keywordRules.js` (28-rule first-match fallback chain);
  `match()` also returns `closeSecond` (different intent within 0.10) and `nearestIntent()`
- `server/localRouter.js` — bounded single-call Ollama classification (stage 4, `num_predict`
  low, temp 0, 8s timeout; null on any failure → existing fallback; logged source 'router';
  can only decide *which* intent fires, never bypasses confirms)
- `server/nlpEngine.js` — trained NLP.js classifier (seeded from `nlpSeedIntents.js`);
  retrains from confirmed near-miss promotions; no `.save()`/`.load()` persistence — the
  classifier is always rebuilt fresh on startup (a dead `model.nlp` write once caused Vite
  full reloads — do not reintroduce)
- `server/learningEngine.js` (+ `nearMissIntentMap.js`) — near-miss → suggestion generation;
  `applySuggestions()` also calls `nlpEngine.addLearnedPhrase()` (fire-and-forget) and
  persists via `learnedIntents.js` (`data/learned-intents.json`, merged into INTENTS before
  `semanticMatcher.initialize()`)
- `server/distillation.js` — AI-exchange analysis → config suggestions (no `file_pattern`
  type anymore; pending records pruned after 30 days)
- `server/projectMemory.js` + `projectMemoryStore.js`/`memoryThresholdChecks.js` — usage
  patterns (commands/files/questions) with `adaptiveThreshold()` scaling (3/20/10 base,
  scaled down <15 events, up >150)
- `server/memoryStore.js` — **the memory.md store** (readMemory/formatMemoryForPrompt/
  appendMemoryEntry + sanitizeMemoryEntry; capped 200 entries; deduped). Do not confuse with
  projectMemoryStore.js (JSON usage patterns). A split once overwrote the wrong file and the
  server failed to start — check every external importer when moving exports.
- `server/conversationStore.js` — orchestration over `sessionPaths.js`/`sessionIndex.js`/
  `messageLog.js`/`chatLog.js`/`sessionMigration.js` (see "How chat memory works")
- `server/ollama.js` — `/api/chat` client (`chatStream`/`chatOnce`), `NUM_CTX` 16384
  (env `OLLAMA_NUM_CTX`), `listCloudModels()` (`CLOUD_MODELS` — check the cloud catalog if a
  model 404s rather than blaming auth), telemetry footer appended by chatStream (stripped by
  the frontend's `splitTelemetry()` and rendered as a muted footer)
- `server/ollamaContext.js` — AI system-prompt builder (+ `toolDefs.js` 20 BUILTIN_TOOL_DEFS,
  `aiModePrompts.js` mode instructions, `promptRenderers.js` 6000-char caps)
- `server/configInitializer.js` — `initConfig()` for `npx local-project-console init`
- `server/cli-client.js` — CLI chat (clack prompt picker, discovery with spinner, banner)
- `server/commandGuesser.js` (+ `guessData.js`) — post-matching regex fallback,
  platform-branched (Windows cmd builtins vs POSIX); fires only when no intent matched
- Misc leaves: `urlSafety.js` (isSafeExternalUrl/isProbeableUrl — SSRF guards; webSearch.js
  re-exports), `regexUtils.js`, `markdownUtils.js`, `webSearch.js` (DuckDuckGo, decodes
  `uddg` redirects, deep-research SSRF guard), `pluginTools.js` (console.tools.json manifest
  parsing + sanitizePermissions + injection-safe substitution), `contextInjector.js`
  (codebase-index snippets appended to some trigger replies), `contextResolver.js`
  (last-resort keyword fallback with word-boundary regex — `.env`-style keywords special-cased),
  `gitSafety.js` (createCheckpoint/performUndo/isGitRepo), `metrics.js`, `fileWatcher.js`,
  `platformCommand.js`

Frontend (`src/`): `hooks/useConsole.ts` ~368-line orchestrator owning all state + WS/fetch
handlers (WS message cases live in `hooks/wsMessageCases.ts` + `wsStreamingCases.ts`, state
clusters in `useConsoleProcessDock`/`useConsoleToolHistory`/`useConsoleWorkspace`/
`useConsoleExports` — see Phase 13). **Stable-router design**: `handleWebSocketMessage` is a
`useCallback([])` that looks up the case table via a per-render `ctxRef` — never capture
first-render state in a case handler. `App.tsx` is render-only. Components: `Terminal.tsx`
(~520 lines, thin orchestrator over `TerminalHeader`/`TerminalMessages`/`TerminalConfirmCards`/
`TerminalOutputBlock`/`StructuredJsonBlock`/`TerminalSearchOverlay`/`TerminalEmptyState`),
`SidebarDrawer.tsx` (collapsible left rail, collapses to ~48px icon rail), `WelcomeScreen.tsx`
(hero + BentoGrid + 4-step tour overlay, z-50), `Dashboard.tsx` (polls `/api/dashboard` 5s +
immediate on `dashboard_update`), `ProcessDock.tsx` (logs + projects overview tabs),
`CommandDeck.tsx` (Ctrl+K palette; nothing bypasses the confirm flows), `AIAssistantInterface.tsx`
(file upload, Search/Reason/Deep Research toggles; ↑/↓ navigates the same per-project history
as the trigger input via `getHistory`, shared `pushHistory` in Terminal), `ui/ThemeToggle.tsx`,
`ui/UserProfileModal.tsx`. The "Click here to open the site" chip in `TerminalMessages.tsx`
only renders for URLs in `knownDevUrls` (grows from `server_url` events + `/api/active-servers`
polls — an Ollama endpoint in an error message no longer gets one; NetPulse complaint).
Output blocks created while an AI turn is in flight (`aiQueryInFlight`, set by `ai_start`,
cleared by the turn's final data-less `end` — not the per-round `stream_end`) start expanded
(`autoExpand` on TerminalMessage) so AI-run commands are actually visible instead of a
collapsed header.

## How the AI gets project context

- `server/projectScanner.js` discovers docs per project (CLAUDE.md always sorted first).
- `buildSystemPrompt()` (`ollamaContext.js`) injects the main doc (truncated ~6000 chars) plus
  entry-point snippets, repo map slice (6000 chars), API routes, frameworks, monorepo info,
  and memory. The prompt instructs the model to call `findFiles` before writing/editing when
  the user names a file loosely, and to ask when there's more than one match.
- `codebaseIndexer.js` builds the repo map (top-level exports/functions/classes per file,
  imports + used-by), mtime-cached per file; `formatRepoMap(repoMap, maxChars)` caps the
  rendered slice. The router stage gets a 1200-char slice; AI mode gets 6000.
- `scriptEntries.js` auto-derives command entries from `package.json` scripts.

## How chat memory works

- Sessions live at `<project.path>/.console/sessions/<id>.json` (inside the project);
  `<project.path>/.console/chat-log.md` is a parallel human-readable log (one `## Title`
  block per session). `.console/` is auto-gitignored on first session creation there.
- `data/conversations/index.json` (in this repo) is a lookup index only (id → path/title/
  updatedAt/messageCount) so `listSessions()` doesn't scan disk. Pre-project sessions fall
  back to `data/conversations/<id>.json` and migrate into `.console/` automatically.
- **Session ↔ project linking**: every session is permanently tied to its project
  (`session.projectId`); `handleExecute` rejects messages sent against a different active
  project ("Session is locked to ..."). Session titles are NOT reliable (auto-renamed to the
  first message's first ~60 chars) — always trust `projectName`. Clicking a project card
  always creates a NEW session; `linkSessionToProject` exists but nothing calls it.
- `connectionLifecycle.js`'s ws.send interceptor auto-persists answers (isMarkdown: true),
  buffered command output (role `'output'` — reloaded sessions keep collapsible block styling),
  tool_start/tool_result (role `'system'`), and warnings.

## Cross-session AI memory (memory.md)

- `<project>/.console/memory.md`: capped (200 entries) durable facts the AI saves via the
  `saveMemory` tool, available in *different* later sessions. Two-tier gating via
  `isGatedToolCall()`: `importance: 'low'` writes immediately (no confirmation); `'judgment'`
  (sensitive/inferred) goes through the standard approve/reject flow. Entries are sanitized
  (no markdown/code blocks) and deduplicated (whitespace/case-normalized).
- `formatMemoryForPrompt()` injects it (4000-char cap, most-recent-first) into the AI system
  prompt under "What You Remember About This Project".
- No classifier/embedding decides what's saved — it's a plain tool call inside AI-mode
  conversation. Trigger mode never reads/writes it.

## Learned confidence model

- `confidenceModel.js` is real supervised learning (plain-JS logistic regression, batch
  gradient descent, no libraries) over features already logged by `intentTelemetry.js`
  (winning stage's confidence, margin, stage, input length). Labels are real user outcomes
  (`falsePositive` set on every approved/rejected gated action).
- Wired into `suggestThresholds()`: with ≥ `MIN_LABELED` (12) labeled examples,
  `learnedFloor()` (searches the score at which the model predicts ≥70% accept, holding
  margin/input-length at the means of the model's own accepted examples — not hardcoded)
  replaces the fixed ±0.03/±0.05 heuristics for every intent, in both the manual
  `telemetry suggest thresholds` command and the automatic startup sweep. Below 12 labels,
  `learnedFloor()` returns null → original heuristic, zero behavior change.
- **Chit-chat clamp**: `PURE_CHITCHAT_INTENTS` floors are clamped to ≥ 0.5 no matter what the
  model recommends (a trained model ratcheting canned chit-chat floors to 0.35 silently
  defeated the garbled-input invariant). Non-chit-chat intents stay fully data-driven.
- Retrains on server startup (before the auto-apply sweep) and fire-and-forget after every
  confirm/reject. `telemetry review` reports trained/sample count/age.
- This is "Stage 1" of a deliberately staged ML plan; further stages were assessed and
  shelved (too little usage volume, Python/GPU tooling absent). Revisit only if usage grows
  substantially.

## Safety model — don't weaken without discussing first

- AI mode is off by default; the header toggle is the **sole** opt-in gesture (no per-query
  re-confirmation — the old `consent_request` double-gate was removed as pure friction).
- `writeFile`, `editFile`, `insertAtLine`, `appendToFile`, and any `executeCommand` with
  `risky: true` from the AI path require explicit approval (`tool_confirm_prompt` →
  Approve/Reject). The model cannot self-approve. Exceptions: session grants (the "Approve +
  auto-approve file edits" button pre-grants the four non-risky file tools for that project +
  session; a `console.tools.json` `permissions` of `allow-after-first-ask` records a grant
  after first manual approval). **Neither mechanism can ever auto-approve `risky: true`
  `executeCommand`, `runTests`, or `stopProcess`** — `ALWAYS_CONFIRM_TOOLS` + parse-time
  coercion enforce that. `saveMemory` has conditional gating ('judgment' only).
- Trigger mode can also create/append files without AI (regex-parsed, quoted content only,
  deliberate conservative asks) — writes go through the same confirm flow as risky commands;
  reads are unguarded. Anything open-ended still needs AI mode.
- File tools cannot resolve outside the active project's directory. Server binds to
  `127.0.0.1` by default (`HOST=0.0.0.0` env var to change — it executes shell commands with
  no auth, so don't do that on an untrusted network).
- `git status --short` / checkpoint commits guard risky manual commands. Checkpoints use
  `git add -A && commit`; `deploy`/`push live` is checkpoint + `git push`.

## Matching pipeline — current behavior and known traps

Run `npm run check-matcher` after ANY matcher edit (68+ self-asserting inputs; `--probe`
mode to print routing when an intent intentionally changes). Current batteries green:
CONTROL/PHASE1-3/BASICS/MATCHDAY/TRAPS/MUST_NOT_STEAL/GARBAGE (+ open-family rows, 83/83).

- **Stage order**: pre-semantic literal overrides → embedding scan (floor 0.6, margin 0.03,
  collision/close-second second pass) → stage-1b config-entry scan (`bestProjectCommandEntry`
  vs `CONFIG_RUN_ENTRY_FLOOR` 0.55 — only when the winning builtin is `run_project`/`npm_run`;
  `OPEN_PROJECT_RE` exempts bare "open/launch the project") → project config entries →
  fuzzy (Fuse 0.55, length-scaled floor) → NLP classifier → local router → commandGuesser →
  fallback suggestions (+ `didYouMean` from `nearestIntent()` ≥ 0.45, skipped for
  pure-chitchat on real-request inputs).
- **`matcher.js` only gates `source === 'semantic'` results** with `getEffectiveThreshold()`;
  fuzzy/keyword/router results are trusted as-is. Remove that source check and the whole
  keyword tier (hardcoded 0.4-0.55 confidences) becomes unreachable.
- **`BUILTIN_INTENTS` membership is the gate that has silently killed intents 6+ times**
  (missing from the Set → unreachable from any stage, despite real handlers/examples).
  Every new intent goes in `intentRegistry.js`'s Set AND gets a check-handlers row. 83
  members today; `npm run check-handlers` (15+ checks) verifies bidirectionally.
- **`PRE_SEMANTIC_OVERRIDES`**: deliberately narrow literal rules for CONFIRMED embedding
  traps (git init / gitignore / deploy-push-live / add-file-without-git-context /
  git-remote-url / file_relations "who uses X" / run-start-launch+server|backend|api /
  open-file-shaped-nouns). Keep the list short — it's a targeted fix, not a reordering.
- **Garbled-input guards**: `PURE_CHITCHAT_INTENTS` (zero-argument canned replies) are
  treated as non-matches when the input `looksLikeRealRequest()` (file extension or quote);
  `isTrustworthyKnowledgeIntent()` does the same for `project.knowledge.*` when the query
  names a specific file. Both live in `intentTrust.js` with their confirmed-live bug comments.
- **Disambiguation**: a blocking tie (different intent within 0.03) returns
  `disambiguate: [A, B]` → "reply with 1/2/neither" flow (`pendingDisambiguation`), while a
  softer `closeSecond` (within 0.10) surfaces a did-you-mean chip. Non-answers clear pending
  state and fall through as a fresh message.
- **Multi-intent split** (`_splitConjunctions`) bails entirely when the input contains a
  quote character — it has no quote-boundary awareness.
- **Commit comments**: `extractCommentMessage(input)` (one shared helper, four handlers) —
  fully-quoted match first, then a fallback heuristic. Never re-derive it per handler.
- **Typed commands**: an exact, allowlisted, non-blocked command line typed in chat runs
  directly (bypasses the matcher). Only exact well-formed command lines qualify.
- **Run-command answers**: trust order is config entries > package.json scripts >
  documented README/CLAUDE.md commands > bat launcher > language guess; site/server-flavored
  asks prefer server-shaped documented commands (`SERVER_SHAPED_COMMAND_RE`).
  `projectTypeSuggestions()` is async, takes the input, checks `idx.fileSample` before
  guessing entry points, and surfaces config entries below the auto-run floor (≥0.40) as
  suggestion chips (no-param entries only).
- **`langs.includes('Python')` never matched** (labels are "Python (4 files)") — use
  `langs.some(l => l.startsWith(...))` style checks.
- **Intent phrase data**: 83 intents / ~2312 phrases in `server/intents/` merged in
  `intentsData.js`. `npm run check-intents` flags exact/near duplicates (static, no server);
  baseline is 1 within-intent / 5 cross-intent / 80 near (pre-existing, deliberately left:
  genuinely-ambiguous pairs where both sides answer reasonably). After intent changes also
  re-check `check-handlers` and `check-matcher`.

## Intent catalog (current state)

- **git** (gitIntents.js): push/commit/commit_push (comment-parsed), pull, fetch,
  remote_add/remote_info, init, add, ignore_add, rm_cached, log, branch, branch_create,
  checkout (answer-only), diff, stash/stash_pop/stash_list, tag, ahead_behind, deploy
  (checkpoint + push). Read-only run immediately; mutations confirm-gated with
  `isSafeParamValue()` on names.
- **npm/file** (npmAndFileIntents.js): install/build/run (duplicate-dev-server guard:
  only refuses when the tracked command equals the exact requested script), run_project
  (`findMentionedScript` — whole-word script-name match anywhere in the input), run_tests
  (via `findTestCommand`), create/append/read/find/delete file, how_to_run, open_* family.
- **project.knowledge / project.context** (projectKnowledgeIntents.js,
  projectContextIntents.js): commands, overview, stack, languages, dependencies,
  tech_preview, file_relations, routes, monorepo, todos, biggest_files, recent_activity,
  dev_server_status (probes recorded/candidate URLs — see livenessProbe), scan_servers,
  running_processes (global), session_info, needs_ai_mode.
- **chit-chat** (chitChatIntents.js): greeting (time-of-day aware, live-state + memory
  enrichment; AI ON → `chatOnce` with canned fallback), status, gratitude, farewell,
  identity, ack, joke, clear, help, explain_followup, yes_no, port, git_status, undo alias,
  needs_ai_mode. Project-customizable via `chatReplies` in console.config.json.
- **actions** (miscIntents.js / projectActionIntents): metrics, open_in_vscode (code CLI →
  `vscode://file/` protocol fallback), open_in_cursor, open_in_explorer, open_in_terminal,
  open_github_page (normalizeGithubPageUrl), open_site, copy_path (copy_to_clipboard WS
  event), checkpoint, project_scan, project_list, file_create, etc.

## Self-learning (4 layers)

1. **Near-miss → `learningEngine.js`**: high-confidence patterns (5+ occurrences, ≥80%
   acceptance) auto-promote into intent examples (`autoApplySuggestionsForAll` on startup);
   lower-confidence needs `review learning` + `approve suggestions`. Persisted via
   `learnedIntents.js`; both the embedding matcher AND the NLP classifier get the new phrases.
2. **Intent telemetry auto-tuning**: per-intent floors with the learned confidence model
   (above). `telemetry review`/`threshold set <intent> <floor>`.
3. **Distillation**: AI exchanges analyzed into trigger-mode config suggestions
   (`review distillations` / `apply all distillations`); knowledge entries deduped, stale
   pending pruned at 30 days.
4. **Project memory**: usage patterns with `adaptiveThreshold` scaling; crossing thresholds
   offers a `memory_suggestion` confirmation card (accept → CLAUDE.md note / quick trigger /
   topic section). `review memory` shows current patterns.

## Ollama Cloud (online fallback)

- `listCloudModels()` merges `CLOUD_MODELS` with cloud models already visible via local
  `/api/tags`. Cloud models run on Ollama's GPUs but go through the same local daemon +
  `/api/chat` — no separate provider integration; `ollama signin` + internet required.
  If `CLOUD_MODELS` entries 404, check `ollama.com/search?c=cloud` and update the list
  (401/403 → signin; 403 can also mean the Ollama app needs a full restart after sign-in).
- Frontend groups models via `<optgroup>`; picking a cloud model is the same `ai_set_model`
  message. `useAI.ts`'s model-existence check covers cloud models; on AI-toggle-on it prefers
  cloud when reachable, else local, else a message telling the user why — an already-valid
  explicit choice is never silently overridden. Cloud always requires the local daemon up.

## Frontend / shadcn / Tailwind / theming

- `@/*` → `./src/*` in BOTH tsconfig `paths` and Vite `resolve.alias`. `components.json`
  documents the shadcn CLI config (Tailwind v4 CSS-first; theme lives in `src/index.css`'s
  `@theme` block). `cn()` is `twMerge(clsx(inputs))`, not bare clsx.
- **Theme**: dark-first zinc palette in `:root` (background #121212, surface #18181b,
  overlay #1e1e20); light is a `:root[data-theme="light"]` override block (bg #f4f4f5, fg
  #18181B) — no `dark:` utilities anywhere, utilities compile via `@theme inline` to var
  refs. Toggle: `ui/ThemeToggle.tsx` in App's header cluster (only switch point); `useTheme`
  persists to localStorage, `index.html` has a pre-paint script. Tokens: fg-strong/fg/
  fg-muted/fg-subtle/fg-dim/fg-faint ladder, border-faint/soft/strong, scrim/panel/
  panel-strong, surface/overlay/background/foreground. Accent/status colors (teal #00d4a3,
  blue #3d6bff, indigo #6366f1 + Tailwind status classes) are CONSTANT across themes —
  do not tokenize. Typography: `--font-sans` Inter (all UI text), `--font-mono` JetBrains
  Mono (reserved strictly for code/log/path/port). `.prose` maps typography vars to theme
  tokens (no `prose-invert` — it hardcodes a light palette); `prose-pre:bg-scrim` supplies
  the code-block background (an unlayered rule would beat it — don't set `--tw-prose-pre-bg`).
- Gray-family class mapping conventions: `text-white/x → fg-*`, `bg-white/x → bg-panel*`,
  `border-white/x → border-border*`, `bg-black/x → bg-scrim*`. Never collapse onto
  `text-foreground`/`text-muted-foreground` (that's what the fg ladder is for).

## Known gotchas — keep fixed

- **Stale `dist/server.js` silently shadows source changes** (bit twice). `start.bat`'s
  WEB_MODE runs `node dist/server.js` whenever `dist/` exists, with no staleness check.
  If `dist/` is ever rebuilt it will shadow server edits under `start.bat` until deleted or
  rebuilt again — `npm run dev` always runs current source, so prefer it while iterating.
  (Also: never use `npm run build` for the frontend-only verification step — use
  `npx vite build` — since it regenerates the shadowing bundle.)
- **Vite watches `data/`, `.cache/`, `*.console/`** — server rewrites data files on nearly
  every user action; keep the watch-ignore list in sync in BOTH `server/index.js` and
  `vite.config.ts`. Add any new runtime-written dir there.
- **WS message types**: new types belong in the server emitter AND
  `src/hooks/wsMessageCases.ts`/`wsStreamingCases.ts`; extend `scripts/checkWsMessageCases.ts`
  when the type has user-visible behavior. `useConsole.ts`'s router reads cases via ctxRef —
  never capture first-render state inside a case handler.
- **Modularization rule**: when splitting/moving module exports, check EVERY external
  importer of that module (lint/tsc doesn't check export names) — a projectMemory split once
  overwrote `memoryStore.js` and the server failed to start (`8e10090` fixed it).
- **Executor**: spawn needs `windowsHide: true` (consoleless parents otherwise flash a cmd
  window per command). Force-detach timer is UNCONDITIONAL (10s dev-server-shaped, 20s
  otherwise) and cleared on close/error/detach; on `close`, only delete the process's OWN
  `runningProcesses` slot when the process was never detached (the Windows npm wrapper can
  close before the real server stops — "stop server" deletes the entry itself when it kills;
  sibling processes of the same project keep their slots).
  `processes_update`/`dashboard_update` broadcast on every process start/URL/close/error.
- **Cancellation**: `cancel` routes through `stopTrackedProcess()` (SIGTERM + map/log/URL
  cleanup + broadcasts) — never a raw `child.kill()` with no cleanup. The AI query's
  AbortController lives on `sessionContext.aiAbortController`; the router tier's bounded call
  needs no cancel path.
- **Upgrade sockets need error listeners** (bit twice — a WS client that connected to a
  non-`/stream` path and was then killed crashed the whole server with an unhandled
  `ECONNRESET` on the raw socket). Sockets arriving via `upgrade` leave the http server's
  normal per-connection error handling; `server/index.js` now attaches `socket.on('error',
  () => {})` in the upgrade handler and a permanent non-fatal `server.on('error', ...)` after
  binding (the listen loop's temporary error listener is removed on success). Don't remove
  either — the same sequence reliably reproduces the crash.
- **Port collision warning**: if a detected dev URL's port equals the console's own
  (`isSamePortAsConsole`/`withPortCollisionWarning` in state.js), append a heads-up — the
  URL may be the console itself.
- **Port-in-use**: interactive port prompts (CRA's "another port?") are detected
  (`PORT_PROMPT_RE`), the detach timer cancels, and approve/reject writes `Y\n`/`n\n` to the
  child's stdin (`pending.stdinWrite`). EADDRINUSE exits offer a one-click retry on the next
  port. `isCommandAllowed` strips one leading env-var-assignment prefix (`PORT=3001 ...` /
  `set PORT=3001&& ...`) before checking the executable.
- **LF/CRLF flood**: git's per-file warning collapse into one summary line; output bursts
  coalesce via `createBufferedSender` (150ms). Purely-informational stderr batches reroute
  to the `warning` WS channel (amber notice) — mixed batches with real errors stay
  `error_output`.
- **Browser folder picker limitation**: `showDirectoryPicker()`/`<input webkitdirectory>`
  can never hand a web page an absolute path (folder-name only) and Chrome rejects some
  protected/reparse-point folders with its own dialog — both are hard browser restrictions.
  Pasting a full absolute path into the scan box is the supported path.
- **CLI readline**: all `readline.createInterface()` calls need `crlfDelay: Infinity`
  (Windows ConPTY can otherwise emit two `'line'` events per Enter → "typing 10 acted like
  100"). All three in cli-client.js.
- **Startup is slow** (~41s cold: embeddings + NLP training + discovery): CLI client retries
  up to 90s across ports 3000-3009. Re-measure if the intent corpus grows a lot.
- **check-handlers' `dev_server_status` row is environment-sensitive**: the common-ports
  fallback probes live ports, so on a machine with one of `COMMON_DEV_PORTS` listening it
  honestly answers "responding at ..." — both shapes are accepted; don't treat a failure on
  a live machine as a regression.
- **Telemetry/harness baselines**: check-intents 1/5/80 (+1 documented near-dup after the
  open-file override); check-matcher 83/83; check-handlers 26/26; check-tools 92/92;
  check-indexer 71/71; check-ws-cases 83/83 (baseline +4 rows for the Phase 3 aiQueryInFlight
  lifecycle fix). Run the relevant battery after ANY edit to the corresponding module.
- **editFile** tolerates whitespace differences (normalized line-range fallback) but not
  wrong wording; on total failure the error names both attempts and tells the caller to
  re-read the file. Truncation guard: `writeFile` re-reads and compares length after writes.
- **Windows harness gotcha**: the phase2 smoke (python http.server) never exits on its own
  (orphaned child inherits stdio pipes) — run via Start-Process + timeout + force-kill.

## Conventions

- No file over ~400 lines; target ~150 for logic files (data registries may reach 150;
  orchestration wrappers like matcher.js 253 / executor.js 164 / useConsole.ts 368 are the
  deliberate exceptions). Split by concern (see `server/wsHandlers/` for the pattern).
- Tools/handlers take named-args objects, not positional args.
- Keep `BUILTIN_INTENTS` (intentRegistry.js), `PURE_CHITCHAT_INTENTS` (intentTrust.js), and
  `PRE_SEMANTIC_OVERRIDES` (preSemanticOverrides.js) in sync when adding intents; add
  check-handlers rows.
- New WS message types belong in both the server emitter and the frontend case tables;
  extend `scripts/checkWsMessageCases.ts` when the new type has user-visible behavior.
- Run `npm run lint`, `node --check` on edited server files, and the relevant check-*
  harness after every change; verify with the live server when possible.
- **Professional code, not vibe-coded**: comments explain *why* in plain professional
  language — no slang, no emoji in code; no dead code; no scratch files or leftover artifacts
  in the repo (delete or gitignore them); consistent formatting; any hack carries a comment
  justifying it. This repo's one-off spec/prompt files were deleted 2026-08-05 — don't drop
  new ones in the root; keep history in CLAUDE.md instead.
