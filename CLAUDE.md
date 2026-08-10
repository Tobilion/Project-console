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

- `start.bat` (styled W/C/Q launcher, ANSI colors, ASCII-only file) probes ports 3000-3009
  first and skips starting a server if one already responds — no duplicate instance landing on
  a fallback port. Server-start PID capture is via `server.pid` file (`Set-Content` + `set /p`),
  NOT a `for /f` pipe: the pipe variant hung forever (confirmed 2026-08-10 — the detached
  server tree kept the pipe's write end open and the batch never reached the cli-client
  handoff). Kill-on-error uses `taskkill /f /t /pid` from that file, never `/im node.exe`.
  The file must stay ASCII-only: cmd's parser desyncs on multi-byte chars (UTF-8 box-drawing
  broke echo lines; an OEM-encoded variant survived cmd but corrupted on any editor save).
  Also no parentheses inside echo lines inside IF blocks ("X was unexpected at this time").
  The frontend derives the WebSocket URL from `window.location`, so it follows whatever port
  the server used.
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
  numbered-list fallback otherwise; invalid input re-asks instead of guessing. The TTY path
  renders a cowsay mascot (the project's pre-commit hook runs `npm install` when
  `package.json` is touched, so `cowsay` is a real dependency — renderMascot() must stay
  defensive against a missing install). Chip-style server messages (`suggestions` /
  `did_you_mean`) render as a numbered option list the user picks by typing the number
  (suggestion pick → `execute`, did-you-mean pick → `did_you_mean_pick`); `memory_suggestion`
  and `learning_suggestion` render with their yes/no and "approve suggestions 1 3" reply hints.
  Stale options are cleared on any new answer/error/confirm (a number typed later can never
  fire a pick from a dead turn). Per-port probe timeout is 5s, not 2s: this machine's
  `/api/projects` takes ~1.7s on a freshly booted server, so the old 2s abort fired on most
  retry cycles and the CLI reported "could not connect" against a healthy server.

## Architecture

`server/index.js` is a thin orchestrator only — routes and WS logic live elsewhere:

- `server/state.js` — shared mutable state (scan directory, project cache, pending confirmations,
  `state.serverPort` set once the fallback loop binds)
- `server/wsServer.js` — the `wss` instance + `broadcast()`
- `server/mockProjects.js` — seeds fake projects on non-Windows sandboxes
- `server/routes/` — `projectRoutes.js` (incl. `GET /api/projects/:id/chat-log` →
  `res.download` of the project's `.console/chat-log.md`; 404s for unknown project or missing
  log, and `GET /api/projects/:id/action-history?limit=N` — Phase 4, see actionHistory.js),
  `sessionRoutes.js` (incl. `GET /api/sessions/:id/export?format=md|json` — the full
  ring-buffer-uncapped NDJSON record, never the 200-message `getSession` cap; 404 for unknown
  session; explicit Content-Type; no temp files), `searchRoutes.js`,
  `monitoringRoutes.js` (`/api/metrics`, `/api/active-servers`, `/api/processes` +
  `/api/processes/:projectId/log`, `/api/dashboard` with a 30s cache invalidated by a
  `volatileSignature()` over projects+runningProcesses+lastDevUrls), `profileRoutes.js`
  (`data/user-profile.json` — tracked by git, unlike gitignored conversations/near-misses/
  telemetry/dev-urls; hosts the opt-in `sandboxRiskyCommands` Phase 3 setting, read per
  sandbox-flagged execution via its exported `readProfile`)
- `server/wsHandlers/` — `connection.js` is a ~14-line re-export shim; real logic lives in
   eleven leaves (see Phase 11): `connectionLifecycle.js` (heartbeat, WS init + connect-time
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
  (pendingParam/pendingFollowUp/pendingDisambiguation/pendingMemorySuggestion),
  `connectionHistoryAdmin.js` (Phase 4: `show history`/`recent actions [n]`/`revert action
  <id>` — file restores are confirm-gated via a `pendingConfirmations` entry of shape
  `revert: {actionId}` (consumed in connectionConfirm.js); git/command/revert entries are
  answer-only), plus
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
   (`undoLastChange` takes an optional `{path}` — if given, restores that file's pre-edit
   content from the aiGuardrails journal, which works even in projects with no git repo;
   without a path, falls through to the git-checkpoint undo).
 - `server/aiGuardrails.js` — Phase 1, Part 1.2 write-path guards: `syntaxCheck` (parse-level
   diagnostics via the lazy `typescript` module for JS/TS-family files — parse diagnostics only,
   never semantic, and null when TS is unavailable); `validateToolCall` (pre-execution guard in
   `runToolCall`/`connectionToolCall` — simulates the edit, syntax-checks the result, journals the
   pre-edit content on failure and returns a warning that rides on the tool result, never blocks);
   a capped journal (`recordPreImage` first-write-wins) with `restorePreImage` consumed by
    `undoLastChange({path})`. Both file-mutating tool paths (AI `runToolCall` and the direct
    frontend `handleToolCall`) call `scheduleVerification` (verifyHarness.js) after a successful
    file write/edit/insert/append.
 - `server/verifyHarness.js` — Phase 1, Part 1.4 background type-check: debounced
   (`DEBOUNCE_MS` 2s), single-flight, non-blocking `npx tsc --noEmit` against any project that
   has a `tsconfig.json` (skipped silently for non-TS projects), 60s cap, result logged to
   server stdout. Never blocks the tool loop or the next model turn.
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
  NOT cached in the index), `codebaseGraph.js` (Phase 1, Part 1.1: AST symbol records via
  `extractSymbols` in codebaseParsers.js feed a per-file symbol index + used-by reference
  edges — import-resolved, name-scan heuristic; `resolveTargetFile`/`renderTargetedSlice`/
  `formatSymbolGraph`; indexProject attaches `symbolIndex`; when a query names a file,
  `formatIndex(idx, targetSlice)` swaps the whole-project repo map for that file's focused
  slice in the AI system prompt; getProjectInfo carries an additive `symbolGraph` key)
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
  — the single kill+cleanup path used by every caller ("stop server", dock stop, AI stopProcess):
  on Windows a SYNCHRONOUS `taskkill /f /t /pid <wrapper>` (an async spawn raced the SIGTERM, the
  wrapper died first and taskkill reported exit 128 "no running instance" while python.exe survived
  as an orphan serving on :5000 — confirmed live 2026-08-10), then map/log/URL
  cleanup + `dashboard_update` + `processes_update` broadcasts + post-stop verification
  (2026-08-10, user-requested: never leave the user believing the site is down while a process
  survived) — child-pid liveness, a Windows command-line survivor scan (whitespace-normalized
  `Get-CimInstance Win32_Process` match), and a 1.5s dev-URL probe; survivors surface as a
  "Heads-up" warning appended to the answer, verification never re-kills (a same-command process
  may be the user's own manual instance); `removeTrackedProcess` deletes one
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
   type anymore; pending records pruned after 30 days). Analyzes a completed exchange
   (`analyzeAIExchange`, called from aiQuery.js) and pairs the user's input phrasing to the
   command the AI ran: `inferTriggerFromInput` emits a natural trigger ("run the tests",
   "start the dev server") when the input intent matches the discovered script, falling back
   to `run <scriptName>`. Suggestions stay approve-gated — `applyDistillation` requires the
   user to select them via the `review distillations` admin command (never auto-applied).
- `server/projectMemory.js` + `projectMemoryStore.js`/`memoryThresholdChecks.js` — usage
  patterns (commands/files/questions) with `adaptiveThreshold()` scaling (3/20/10 base,
  scaled down <15 events, up >150)
- `server/memoryStore.js` — **the memory.md store** (readMemory/formatMemoryForPrompt/
  appendMemoryEntry + sanitizeMemoryEntry; capped 200 entries; deduped). Do not confuse with
  projectMemoryStore.js (JSON usage patterns). A split once overwrote the wrong file and the
  server failed to start — check every external importer when moving exports.
- `server/conversationStore.js` — orchestration over `sessionPaths.js`/`sessionIndex.js`/
  `messageLog.js`/`chatLog.js`/`sessionMigration.js` (see "How chat memory works")
- `server/sessionExport.js` — session export (Phase 0, 2026-08-10):
  `readFullSessionHistory()` reads the ring-buffer-UNCAPPED NDJSON message log (via the
  session index → per-project `.console/` path), then `formatExportMarkdown()` /
  `formatExportJson()` render it. Markdown labels roles (User/Assistant/System/Output/Error/
  Notice — bot content raw, every other role fenced in a code block) with
  `_localized timestamp_` lines; JSON is `{id, role, content, timestamp, isMarkdown}`;
  `projectChatLogPath()` finds a project's `.console/chat-log.md`. This server-side
  formatter is the single source both export file formats and the client-side PDF come
  from — the frontend (`useConsoleExports`) always downloads, it never reformats React state.
- `server/ollama.js` — `/api/chat` client (`chatStream`/`chatOnce`), `NUM_CTX` 16384
  (env `OLLAMA_NUM_CTX`), `listCloudModels()` (`CLOUD_MODELS` — check the cloud catalog if a
  model 404s rather than blaming auth), telemetry footer appended by chatStream (stripped by
  the frontend's `splitTelemetry()` and rendered as a muted footer)
- `server/ollamaContext.js` — AI system-prompt builder (+ `toolDefs.js` 20 BUILTIN_TOOL_DEFS,
  `aiModePrompts.js` mode instructions, `promptRenderers.js` 6000-char caps). Static prefix is
  built once per turn with `options.targetSlice` (Phase 1, Part 1.1 — see codebaseGraph.js);
  the dynamic session-history suffix is pruned per turn by `contextPruner.js` (Phase 1,
  Part 1.3: keeps the system + last 3 turns verbatim, compresses the middle, hard tail-drop).
  `memoryStore.js`'s cross-session memory is deduped by `memoryDedupe.js` (cosine ≥ 0.92 vs
  the newest saved lines — shares semanticMatcher's extractor, null-safe).
- `server/configInitializer.js` — `initConfig()` for `npx local-project-console init`
- `server/cli-client.js` — CLI chat (clack prompt picker, discovery with spinner, banner)
- `server/commandGuesser.js` (+ `guessData.js`) — post-matching regex fallback,
  platform-branched (Windows cmd builtins vs POSIX); fires only when no intent matched
- `server/taskQueue.js` — infrastructure expansion (2026-08-10): lightweight in-memory
  per-project FIFO queue (`enqueueTask`/`hasActiveTask`/`activeTaskLabel`) so slow,
  non-interactive handler work can run off the chat turn instead of blocking the WS connection.
  Not persistent — cleared on restart, one task at a time per project, cross-project tasks run in
  parallel. First (and currently only) consumer: `project.diagnostics.type_check` enqueues its
  `tsc --noEmit` run and posts the result as an out-of-band `answer` WS message when done — no
  frontend protocol change needed since `answerCase` in `wsMessageCases.ts` renders any incoming
  `answer` as a fresh bubble with no matching `end` required.
- `server/pluginTools.js` also exports `validateToolEntry`/`sanitizePermissions`/
  `MANIFEST_FILENAME` (infrastructure expansion, 2026-08-10) for the pack-install admin
  commands in `connectionPackAdmin.js` — `install pack <path>` reads a local
  console.tools.json-shaped file, validates it against the exact same schema real manifests use,
  and shows a preview (tool names/commands/risky flags) before anything is written. Two-step
  confirm via `sessionContext.pendingPackInstall` (5-min TTL, mirrors pendingConfirmations'
  expiry) — `confirm install pack` merges into the project's own console.tools.json (by-name
  overwrite), `cancel install pack` discards. `list packs` shows what's currently installed.
  Deliberately local-file-only, no URL/registry fetch — a hosted pack registry is a real
  vetting/hosting commitment, not a chat command, and installed tools still run through
  `createPluginToolFn`'s normal isSafeParamValue/isCommandBlocked checks at call time regardless
  of how they got into the manifest.
- `server/crossProjectMemory.js` — infrastructure expansion (2026-08-10): searches every scanned
  project's `.console/memory.md` at once via the shared embedding extractor (same lazy
  dynamic-import pattern as `memoryDedupe.js`, to avoid a load-order cycle through
  `semanticMatcher.js`). No persisted index — fans out at ask time, capped at
  `MAX_TOTAL_LINES` (400) so a query stays bounded regardless of project count. Powers
  `system.knowledge.cross_project_search` (handler in `builtinContextRuntime.js`, global like
  `running_processes` — ignores the active project, searches `state.activeProjectsCache`).
  Uses the raw input as the embedding query rather than parsing out "which project did I ... in"
  wrapper phrasing.
- `server/actionHistory.js` — Phase 4 (2026-08-10): per-project action log at
  `.console/action-history.jsonl` (cap 2000 entries, trim-rewrite when bytes > 2000×220; ids are
  `crypto.randomUUID().slice(0,8)`; corrupt lines skipped; dfmded by `ensureGitignored`).
  `appendAction` writes entries with an inline `preContent` pre-image and `existed` flag; file
  paths are validated safe by `isSafeRelativePath`. Recorded: the four file-mutating tools
  (wrapped in `tools.js` via `wrapMutatingTool` — only on `result.success`, only when the path
  resolves inside the project root, files over 1MB skipped so their pre-image never bloats the
  log) and confirmed/risky commands (`connectionConfirm` for `pending.sandbox !== false` —
  dev-server port retries are excluded deliberately — plus `aiQueryToolRun`/`connectionToolCall`
  for risky `executeCommand`; type is `git` when the command starts with `git`). Checkpoints
  themselves are NOT logged. `revertAction`: file entries restore `preContent` (deleting the
  file when it did not exist before), git/command entries answer checkpoint-aware advice —
  console checkpoints are COMMITS (`console-checkpoint:` prefix from gitSafety.js), so when
  `git log -1 --pretty=%B` still shows that prefix the advice is `git reset --hard HEAD~1`,
  otherwise `git revert <sha>` (push) / `git reset --soft HEAD~1` (commit) / generic manual
  steps. REST: `GET /api/projects/:id/action-history?limit=N` (1-200, most-recent-first) in
  projectRoutes.js; frontend History tab in ProcessDock renders it via `HistoryPanel.tsx`,
  whose revert button goes through the normal chat flow (`revert action <id>`) — never a
  bypass.
- `server/schedules/` + `server/wsHandlers/connectionScheduleAdmin.js` — Phase 1 (autonomous
  triggers): per-project scheduled commands ("schedule every 10 minutes \"git status\"",
  "schedule daily at 09:30 X", "schedule on file save X", "schedule on git commit X") persisted
  to `data/schedules.json` (gitignored, debounced by `scheduleStore.js`), plus the admin
  commands `list schedules` / `remove schedule <id>` / `review schedule log` (all dispatched
  from the same pre-matcher admin tier as telemetry/pack, returning true when consumed).
  `scheduleParser.js` handles the four interval shapes (1 min – 24 h, 24h time, the two event
  triggers); `scheduler.js` runs a 15s `setInterval` tick (unref'd, `lastFiredAt`-based cadence
  so restarts never double-fire) and owns per-project chokidar watchers (via
  `fileWatcher.watchProjectChanges` — git-commit is signalled by `.git/refs`/HEAD changes,
  node_modules/.console ignored, 1s debounce, 60s per-schedule event throttle) matched to
  however many event schedules exist. Safety: `scheduleIntents.js` allowlists read-only intents
  only (project.knowledge/context/diagnostics prefixes + explicit git read/diagnostics/status/
  time/date/port entries); creation-time `matchInput` validation rejects mutating, ambiguous,
  or config-entry-resolving commands with a clear error, and `scheduleFire.js` re-checks at
  fire time as a drift guard, then runs through `taskQueue.js` with a fake ws collecting
  output. Delivery: to the first live session of that project via `state.connectionRegistry`
  (ws → sessionContext map registered on connect, unregistered on close — the intercepted
  send renders AND persists like a typed answer), else appended to `data/schedule-log.md`
  (400-line cap) for `review schedule log`. `initScheduler()` is called from
  `server/index.js` after project discovery (loadSchedules before any connection can create).
- `server/notify.js` + `server/notify/` — Phase 2 (2026-08-10): push notifications beyond the chat.
  Rules persist to gitignored `data/notifications.json` (webhook URLs are bearer secrets,
  deliberately NOT in the git-tracked `data/user-profile.json`); everything defaults OFF — zero
  behavior change until opted in, and enabling an event turns the desktop channel on
  (`notifyStore.js`, debounced like scheduleStore). `notifyChannels.js`:
  `sendDesktopNotification` is a best-effort PowerShell 5.1 WinRT toast (no new npm dependency;
  may silently no-op on Windows 11 without a registered AppUserModelID — documented, never
  crashes), `sendWebhook` POSTs JSON with an 8s AbortSignal timeout and is re-validated through
  `isSafeExternalUrl` AT SEND TIME — localhost/private webhook endpoints are blocked by design
  (same SSRF guard as webSearch), so webhook testing requires a real public URL. `notifyEvents.js`
  keeps a bounded event set (`dev-server-crash` / `schedule-find` / `task-done`) with aliases.
  Admin commands in `connectionNotifyAdmin.js` (pre-matcher tier): `notify me when <event>` /
  `stop notifying me about <event>` / `list notifications` / `webhook add <url>` /
  `webhook remove <url>` / `test notification`. Wiring: `initNotifications()` runs from
  `server/index.js` after `initScheduler()` (loads rules before any connection, registers the
  taskQueue completion listener — `setTaskCompletionListener` in taskQueue.js); `scheduleFire.js`
  notifies when a fire produced non-empty output; executor.js's detached-close handler notifies
  when a still-tracked process died and its URL stopped answering (deliberate stops delete
  entries first in `stopTrackedProcess`, so they never fire).
- Misc leaves: `urlSafety.js` (isSafeExternalUrl/isProbeableUrl — SSRF guards; webSearch.js
  re-exports), `regexUtils.js`, `markdownUtils.js`, `webSearch.js` (DuckDuckGo, decodes
  `uddg` redirects, deep-research SSRF guard), `consoleCommandDocs.js` (reference catalog for
  the `system.chit_chat.how_do_i` intent — keyword-matched entries rendered by builtinChitChat;
  keep keywords narrow, "push"/"port" alone hijack adjacent docs), `pluginTools.js`
  (console.tools.json manifest
  parsing + sanitizePermissions + injection-safe substitution), `contextInjector.js`
  (codebase-index snippets appended to some trigger replies), `contextResolver.js`
  (last-resort keyword fallback with word-boundary regex — `.env`-style keywords special-cased),
  `gitSafety.js` (createCheckpoint/performUndo/isGitRepo), `metrics.js`, `fileWatcher.js`,
  `mathEval.js` (safe shunting-yard evaluator for the `calculate` intent — `+ - * / ( )`
  only, no eval/Function), `platformCommand.js`

Frontend (`src/`): `hooks/useConsole.ts` ~368-line orchestrator owning all state + WS/fetch
handlers (WS message cases live in `hooks/wsMessageCases.ts` + `wsStreamingCases.ts`, state
clusters in `useConsoleProcessDock`/`useConsoleToolHistory`/`useConsoleWorkspace`/
`useConsoleExports` — see Phase 13; exports are downloads-only now (Phase 0, 2026-08-10):
  markdown/JSON/blob downloads of `GET /api/sessions/:id/export`, PDF built client-side from
  the same JSON via `jspdf` (a real dependency — app UI glyphs like ⚙/✓/→ are ASCII-mapped in
  `sanitizePdfText` since jsPDF's fonts are latin-1-only), plus project chat-log download).
  **Stable-router design**: `handleWebSocketMessage` is a
`useCallback([])` that looks up the case table via a per-render `ctxRef` — never capture
first-render state in a case handler. `App.tsx` is render-only. Components: `Terminal.tsx`
(~520 lines, thin orchestrator over `TerminalHeader`/`TerminalMessages`/`TerminalConfirmCards`/
`TerminalOutputBlock`/`StructuredJsonBlock`/`TerminalSearchOverlay`/`TerminalEmptyState`),
`SidebarDrawer.tsx` (collapsible left rail, collapses to ~48px icon rail), `WelcomeScreen.tsx`
(hero + BentoGrid + 4-step tour overlay, z-50), `Dashboard.tsx` (polls `/api/dashboard` 5s +
immediate on `dashboard_update`), `ProcessDock.tsx` (logs + projects overview tabs + Phase 4 History tab — API routes, see
`actionHistory.js` — rendered by `HistoryPanel.tsx`, revert via the normal chat flow),
`CommandDeck.tsx` (Ctrl+K palette; nothing bypasses the confirm flows), `AIAssistantInterface.tsx`
(file upload, Search/Reason/Deep Research toggles; ↑/↓ navigates the same per-project history
as the trigger input via `getHistory`, shared `pushHistory` in Terminal), `ui/ThemeToggle.tsx`,
`ui/UserProfileModal.tsx`. The "Click here to open the site" chip in `TerminalMessages.tsx`
only renders for URLs in `knownDevUrls` (grows from `server_url` events + `/api/active-servers`
polls — an Ollama endpoint in an error message no longer gets one; NetPulse complaint).
`Dashboard.tsx` (2026-08-10 QoL pass: Projects/Live Sites tabs, a project card expands on click
into an action row — Open in chat / Commit & push (or Push) when the project has uncommitted or
unpushed-but-committed work / Open site / Copy path — plus a name filter and dirty/running-first
sort; `/api/dashboard` entries now carry `isGitRepo`/`aheadCount`/`hasUpstream` so "needs push"
means real unpushed commits, not just a dirty working tree). Output blocks created while an AI turn is in flight (`aiQueryInFlight`, set by `ai_start`,
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
- **`sandboxRiskyCommands` (Phase 3, 2026-08-10)**: opt-in global setting (default `false`,
  persisted in `data/user-profile.json` via `profileRoutes.js`, toggled in `UserProfileModal.tsx`).
  When ON, commands that went through the confirm gate because they're `risky: true` /
  `ALWAYS_CONFIRM_TOOLS` (confirmed trigger commands via `connectionConfirm`, AI/direct risky
  `executeCommand`, and the AI `runTests` tool) spawn with the **restricted env from
  `executorSandbox.js`**: environment allowlist (`SANDBOX_ENV_ALLOWLIST` — PATH/SystemRoot/
  TEMP/USERPROFILE/HOME/APPDATA/LOCALAPPDATA/etc., deliberately generous so npm/git/python keep
  working) + cwd pinned to the project + `CONSOLE_SANDBOXED=1` / `CONSOLE_SANDBOX_ROOT` markers,
  and a `warning` notice is emitted so the user can see it took effect. Honest guarantees — this
  is approach (a) from the spec, NOT a container: **no network isolation** (Windows has no
  per-process network block without elevation/WFP), **no OS-level file-access boundary** (a
  sandboxed `git push` still reaches GitHub; a sandboxed command can still read outside the
  project — what it CAN'T do is read env-carried secrets or be told apart from a normal run).
  The setting NEVER bypasses or weakens the confirm flow — it strictly applies after approval.
  Excluded by design: `stopProcess` (killing a process must act on the host), the dev-server
  port-conflict retry (`sandbox: false` on that one pending record in `executorPorts.js` —
  dev servers must stay env-complete), non-risky commands, and trigger-mode `run_tests` (not
  confirm-gated). Default path with the setting off is byte-identical to before — `opts.sandboxed`
  only matters when both the caller flags the command AND the setting is on.
- `git status --short` / checkpoint commits guard risky manual commands. Checkpoints use
  `git add -A && commit`; `deploy`/`push live` is checkpoint + `git push`.

## Matching pipeline — current behavior and known traps

Run `npm run check-matcher` after ANY matcher edit (68+ self-asserting inputs; `--probe`
mode to print routing when an intent intentionally changes). Current batteries green:
CONTROL/PHASE1-3/BASICS/MATCHDAY/TRAPS/MUST_NOT_STEAL/GARBAGE (+ open-family rows + PHASE0
time/date/calculate rows, 92/92).

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
- **Intent phrase data**: 96 intents / ~2494 phrases in `server/intents/` merged in
  `intentsData.js`. `npm run check-intents` flags exact/near duplicates (static, no server);
  baseline is 1 within-intent / 5 cross-intent / 82 near (pre-existing, deliberately left:
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
  identity, ack, joke, clear, help, explain_followup, yes_no, port,
  time/date (server-local clock, never a model call), calculate (safe arithmetic via
  `mathEval.js` — `evaluateArithmetic`, no eval/Function, word-synonym + `+ - * / ( )`
  only, `formatValue`), git_status, undo alias, needs_ai_mode,
  how_do_i (Phase 1, 2026-08-10: "how do i <feature>" guidance answered from the
  consoleCommandDocs.js catalog — side-effect-free, no model call; examples deliberately
  exclude run/open/push/stop-shaped phrasings so how_to_run/deploy/stop-server keep their
  routes). Project-customizable via
  `chatReplies` in console.config.json.
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
  cleanup + broadcasts) — never a raw `child.kill()` with no cleanup. On Windows the kill is a
  SYNCHRONOUS `taskkill /f /t /pid <wrapper>` (async spawns race the SIGTERM and report exit 128
  "no running instance" while the real process survives as an orphan — confirmed live
  2026-08-10) and no SIGTERM is sent at all (taskkill kills the wrapper too). The AI query's
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
  `set PORT=3001&& ...`) before checking the executable. Note: on Windows, werkzeug/Flask binds
  with SO_REUSEADDR, so a second `main.py serve` while the port is occupied does NOT hit
  EADDRINUSE — it binds anyway and runs alongside (confirmed live 2026-08-10). Never rely on
  EADDRINUSE to protect against double-serve.
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
- **Telemetry/harness baselines**: check-intents 1/5/82 (+1 documented near-dup after the
  open-file override; +2 new near-dups from the 3 new PHASE0 chit-chat intents); check-matcher
  97/98 — 92/92 core + 6 NEW PHASE1b how_do_i rows, with one PRE-EXISTING drift on CONTROL's
  "run the calculation" (routes to system.chit_chat.calculate on this machine's local data;
  reproduced identically on clean HEAD with the how_do_i work stashed, 91/92 — not a
  regression of this change); check-handlers 30/30 (baseline 29/29 + 1 how_do_i dispatch row);
  check-tools 128/128;
  check-indexer 85/85 (+14 SYMBOLS & GRAPH rows for the Phase 1.1 codebase-graph work); check-ws-cases 84/84 (baseline +4 rows for the Phase 3 aiQueryInFlight
  lifecycle fix; +1 drift row from later WS-case additions). Run the relevant battery after ANY edit to the corresponding module.
- **editFile** tolerates whitespace differences (normalized line-range fallback) but not
  wrong wording; on total failure the error names both attempts and tells the caller to
  re-read the file. Truncation guard: `writeFile` re-reads and compares length after writes.
- **Windows harness gotcha**: the phase2 smoke (python http.server) never exits on its own
  (orphaned child inherits stdio pipes) — run via Start-Process + timeout + force-kill.

## Phase 5 (2026-08-10)

- **requestedPort.js** — "run the site on port 3010" / "serve the site on port 3040":
  `extractRequestedPort`/`applyRequestedPort`. Replaces an existing `--port`/`-p` flag;
  uses `npm run dev -- --port=N` for vite-shaped scripts (vite ignores PORT env); falls
  back to `set PORT=N&& ` / `PORT=N ` env prefix. Wired into `npm_run`/`run_project`
  (incl. the npm start|serve shortcuts and the run/serve-the-site branch). When a port is
  requested the duplicate-dev-server guard is skipped deliberately (explicit re-run on a
  new port).
- **deploy intent examples fixed**: intentsData.js `deploy` example list OWNED the whole
  run/serve/open-site family ("run the site", "serve the site", "open the site", ...), so
  those phrasings silently ran a git push. Removed — `run_project`/`npm_run` own them now.
  Run-on-port examples added to npmAndFileIntents.js/miscIntents.js ('serve the site',
  'serve the app', 'run the app on port 3010', ...; 'run the site on port 3010' lives in
  npm_run only — check-intents still 1/5/82).
- **serve-the-site pre-semantic override** (preSemanticOverrides.js): "serve the site on
  port 3040" fell out of the embedding stage entirely and landed on system.chit_chat.deploy
  via a later stage — the literal `^serve the site[ on port N]$` override routes it to
  npm_run before anything else can vote (confirmed live).
- **run/serve/start-the-site branch** (builtinFileNpm.js npm_run): the script-name capture
  deliberately excludes generic nouns (site/app/server/...) so "run the site on port 3010"
  can't dead-end on "No script called site"; the branch runs the dev script with the
  requested port. With a requested port it confirms first — parity with the config-entry
  path (the same phrase confirms when the project's own dev-script entry wins the match);
  without a port it runs immediately, matching plain "run the site". "stop the server" is
  immediate by design (handleStopServer kills only tracked processes). The capture later
  gained a `(?!the\b)` guard after the optional "the": the original regex let the capture
  start ON "the", so "run the site on port 3010" dead-ended on "No script called **the**"
  (found live 2026-08-11 via the liveness driver) — with the guard it correctly falls to
  the site branch and confirms with the requested port.
- **Dashboard project modal** (Dashboard.tsx): expanded project card gained Run / Stop
  buttons (normal chat flow, never a bypass) and an embedded `HistoryPanel`.
- **Live-site truth**: `recordDevUrl`/`loadDevUrls` refuse URLs on the console's own port
  (a project can never own that port). `/api/dashboard` also drops stale colliding stored
  URLs (reported live: Matchday Exchange stayed "live" at :3001 after the console took that
  port). On cache build it now additionally probes the recorded URL (1200ms) and drops +
  forgets it when nothing answers — that covers stale persisted URLs with no tracked
  process (the Matchday :3001 case, which no executor close-handler ever fires for);
  tracked-server out-of-band deaths were already handled by the executor's delayed
  detached-exit probe. Console-self detection compares `path.resolve(project.path)` to the
  console root with case-folded, separator-normalized equality on win32 (a raw `===` fails
  when the two paths differ only in casing). Verified live 2026-08-11: console self shows
  at `http://127.0.0.1:<serverPort>`, Matchday drop + persistence clean, 8/8 driver checks.
- **Harness gotchas (2026-08-10)**: copying scratch driver scripts into the repo root
  triggers Vite rebuilds that stall the WS pipeline 60-90s — keep live-test drivers in
  `%TEMP%` and resolve `ws` via `createRequire` with an absolute path. A killed harness
  shell ORPHANS its Start-Process child, which keeps holding the port, and a later
  "restart" silently binds a fallback — verify the listening PID after every restart
  (`Get-NetTCPConnection -LocalPort N`). Test servers were run on :3007 with
  PORT=3007 env; the user's own console may hold :3000/:3001 — never kill by
  `/im node.exe`, always by PID/command line.
- **"append to X the text Y" routes to `system.chit_chat.deploy`, not `file_append`**
  (pre-existing matcher quirk, confirmed 2026-08-10 via a matcher probe; the check-matcher
  battery is unaffected because it tests canonical example phrasings). "add a line to X: ..." /
  "append this text to X: ..." route correctly. Don't be surprised when append-shaped live
  tests run `git push` instead — reach for the correctly-routing shapes above.
- **Copying scratch harness scripts into the repo root stalls the server's WS pipeline**:
  the in-process Vite dev server watches the repo root, so creating/deleting a test file
  there triggers full client rebuilds that block the single-threaded server for 60-90s —
  WS answers that took <100ms from `%TEMP%` look like 60s+ hangs from a repo-root copy.
  Keep live-verification drivers outside the repo and resolve `ws` by absolute path
  (`createRequire(import.meta.url)` + the repo's `node_modules/ws`).
- **Harness waits should key on terminal message markers, not quiet windows**: confirmed
  runs and direct tool calls terminate with an `end` WS message; a "no message for 700ms"
  quiescence check can fire mid-turn (git checkpoint output legitimately gaps >700ms) and
  miss the final answer. Wait for `end` explicitly; reserve quiet-windows for answer-only
  turns that never send `end`.

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
- **CI**: `.github/workflows/ci.yml` (added 2026-08-10) runs `npm run lint` +
  all `check-*` harnesses on every push/PR to `main` — this is now the automated backstop for the
  matcher/handler/indexer/intent regressions that used to only be caught by remembering to run
  them manually.
- **Professional code, not vibe-coded**: comments explain *why* in plain professional
  language — no slang, no emoji in code; no dead code; no scratch files or leftover artifacts
  in the repo (delete or gitignore them); consistent formatting; any hack carries a comment
  justifying it. This repo's one-off spec/prompt files were deleted 2026-08-05 — don't drop
  new ones in the root; keep history in CLAUDE.md instead.
