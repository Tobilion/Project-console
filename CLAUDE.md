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
  numbered-list fallback otherwise; invalid input re-asks instead of guessing. Phase 13
  (2026-08-12): first-run onboarding mirror — when the server profile's `setupComplete` is
  false, the CLI asks the same three questions as the web wizard (name, default workspace
  type, Ollama note) and writes through the same /api/profile path; never blocks on
  non-TTY/failure. The TTY path
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
  detectFrameworks — incl. Angular (`angular.json`/`ng.json`) and Flutter/Dart (`pubspec.yaml`),
  task 0c; findEntryPoints across the whole tree; detectSubPackages for monorepos),
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
  sanitized at scan time (invalid values dropped with console.warn, never crash);
  `detectWorkspaceType` (Phase 1 roadmap, 2026-08-11) attaches the 'dev'|'general'
  classification — console.config.json `workspaceType` override wins, else
  `isRecognizableByCodeAlone()` decides — to every project object in both scan paths
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
  `OPEN_PROJECT_RE`, `ROUTER_REPO_MAP_CHARS` 1200, `describeIntent`; plus the Phase 1
  suggestion-filter tags `WORKSPACE_DEV_ONLY_INTENTS`/`intentWorkspaceEligible`), `intentTrust.js`
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
  `applySuggestions()` also calls `nlpEngine.addLearnedPhrase()` (fire-and-forget) and refreshes
  the embedding stage via `semanticMatcher.addLearnedExamples()` (fire-and-forget — the cosine
  scan used to score learned phrases against stale startup vectors until restart; confirmed
  2026-08-11) and persists via `learnedIntents.js` (`data/learned-intents.json`, merged into
  INTENTS before `semanticMatcher.initialize()`)
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
- `server/notesStore.js` — Phase 5 (2026-08-12): **the user-authored notes store** at
  `<project>/.console/notes.md` — a THIRD store, deliberately distinct from memoryStore.js
  (AI-authored memory.md) and projectMemoryStore.js (JSON usage patterns). User free text
  only: never written by the AI, never injected into the AI system prompt unless the user
  explicitly asks it read back. `appendNote`/`listNotes`/`readNotes`; capped 200 entries,
  exact-normalized dedupe, per-project write lock (same pattern as memoryStore). Handlers in
  `server/wsHandlers/builtinNotes.js` (`system.notes.create/list/search`), intents in
  `server/intents/noteIntents.js`, read-only REST at `GET /api/projects/:id/notes`
  (`server/routes/noteRoutes.js`); the Notes panel is `src/components/NotesPanel.tsx`
  (Apple Notes reference — flat feed, no per-row cards, instant filter; add/search go through
  the same WS trigger commands).
- `server/csvTools.js` + `server/wsHandlers/builtinCsvTools.js` + `server/intents/csvIntents.js`
  — Phase 7 (2026-08-12, spreadsheet-lite): deterministic CSV queries — a small fixed grammar
  (`sum/average column X in Y`, `count rows in Y where X <op> v`, `filter Y where X <op> v`,
  ops: equals/contains/greater than/less than). `parseCsv` is a dependency-free quoted-field
  reader (2MB/20k-row caps); column/file names validated by `isSafeParamValue`. Read-only by
  design — no filter-to-file write variant exists (a future one must go through the standard
  confirm + action-history path). The Spreadsheet panel (`src/components/SpreadsheetPanel.tsx`,
  Numbers/Sheets reference — toolbar + sortable sticky-header zebra table) renders filter
  results via `GET /api/projects/:id/csv-filter` (same loadCsv/matchOp path as the chat
  answer), with `GET /api/projects/:id/csv-files` + `csv-headers` (routes/csvRoutes.js).
  All four intents tagged `opensPanel: 'csv-tools'`, pinned by Phase 7 pre-semantic overrides
  (the .csv token + free-form where-values carry no embedding weight).
- `server/clipboardHistory.js` + `server/snippetStore.js` + `server/wsHandlers/builtinClipboard.js`
  + `server/intents/clipboardIntents.js` — Phase 8 (2026-08-12): OS clipboard history +
  named snippets. TWO separate opt-in profile settings (data/user-profile.json via
  profileRoutes.js, toggled in UserProfileModal's Advanced section): `clipboardHistory`
  (poll the OS clipboard — PowerShell Get-Clipboard on Windows, pbpaste/xclip elsewhere;
  in-memory 25-entry LineRingBuffer-style list, deduped, `CLIPBOARD_POLL_MS` tuning knob,
  zero background behavior when off) and `clipboardPersist` (also write history to a
  gitignored data/clipboard-history.json — a bigger privacy commitment, so it's its own
  toggle). All clipboard WRITES are server-side (`copyToOsClipboard` — Set-Clipboard/
  pbcopy/xclip) so the CLI copies for real; the copy_to_clipboard WS event is now a pure
  display notice (comment updated in cli-client.js). Snippets (`snippetStore.js`) are
  global named text blocks in gitignored data/snippets.json (atomic write, env-overridable
  path for tests). Intents: clipboard.show/copy_item/clear + snippet.save/show/copy/delete;
  REST read-only `GET /api/clipboard-history` + `/api/snippets` (routes/clipboardRoutes.js);
  panel `src/components/ClipboardPanel.tsx` (Windows Clipboard History reference — pinned
  snippets above the history stack; when the setting is off the panel explains how to
  enable it rather than disappearing). `syncClipboardPolling()` runs at boot and on profile
  save so the setting takes effect live without a restart.
- `server/backupStore.js` + `server/wsHandlers/builtinBackup.js` + `server/intents/backupIntents.js`
  — Phase 9 (2026-08-12): backup/zip. `createBackup` zips a project (or a named subfolder) to
  `data/backups/<name>-<timestamp>.zip` via archiver@7 (classic `archiver('zip')` API — v8 is
  a breaking rewrite with no callable default export, do not bump), 50MB cap matching
  workspaceTransfer.js, IGNORE_DIRS skip list (node_modules/.git/.console/dist/...). Zipping
  is read-only w.r.t. the source (no confirm gate) but journals each zip via appendAction
  (`file_write`, existed:false) so `revert action <id>` deletes it. Intents backup.create/list,
  tagged `opensPanel: 'backup'`; REST `GET /api/projects/:id/backups` + `backup-file?name=`
  (basename-validated download, routes/backupRoutes.js); panel `src/components/BackupPanel.tsx`
  (Time Machine simplified — reverse-chronological list with download/show-in-folder).
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
  for risky `executeCommand`; type is `git` when the command starts with `git`; Phase 2 adds
  `file_move` for general.files tidy moves). Phase 12 (2026-08-12) audited the post-Phase-1
  trigger-only mutators and confirmed every one journals: general.files tidy/duplicates_delete
  (file_move + file_write with preContent), PDF writes (pdfKit.js file_write existed:false),
  and backup zips (builtinBackup.js file_write existed:false at `backups/<name>.zip` — the
  zip lives OUTSIDE the project in data/backups, so revertAction special-cases the `backups/`
  prefix to delete the real zip; the generic file_ branch would miss it. Phase 7 CSV is
  read-only by design — no write variant exists). Checkpoints
  themselves are NOT logged. `revertAction`: file entries restore `preContent` (deleting the
  file when it did not exist before), `file_move` entries move the file back (refusing when
  the original path is occupied or the moved file is gone), git/command entries answer checkpoint-aware advice —
  console checkpoints are COMMITS (`console-checkpoint:` prefix from gitSafety.js), so when
  `git log -1 --pretty=%B` still shows that prefix the advice is `git reset --hard HEAD~1`,
  otherwise `git revert <sha>` (push) / `git reset --soft HEAD~1` (commit) / generic manual
  steps. REST: `GET /api/projects/:id/action-history?limit=N` (1-200, most-recent-first) in
  projectRoutes.js; frontend History tab in ProcessDock renders it via `HistoryPanel.tsx`,
  whose revert button goes through the normal chat flow (`revert action <id>`) — never a
  bypass.
- `server/wsHandlers/builtinGeneralFiles.js` — Phase 2 (general-mode file tools, 2026-08-11):
  the `general.files.*` handler module for folders that are not dev projects. Four intents:
  `general.files.find` (content + name search over the project tree, text-cap 20KB/file — see
  `extractFindQuery`/`searchContents`), `general.files.tidy` (moves loose root files into
  type-category folders Images/Documents/Spreadsheets/Presentations/Archives/Audio/Video, or
  `YYYY/MM` by date, or `YYYY/<type>` combined — root files only, never re-moves files already
  in one of its own folders, `planTidy`/`performTidy`), `general.files.duplicates`
  (MD5-by-size duplicate groups, newest copy wins — `findDuplicates`), and
  `general.files.duplicates_delete` (keep-newest deletion of the same groups —
  `planDuplicateDeletes`/`performDuplicateDeletes`). The two mutating intents are
  confirm-gated with triggers `general_files_tidy`/`general_files_duplicates_delete`
  (pending record shape `{ generalFileOp: { kind, moves|files } }`, consumed in
  connectionConfirm.js — checkpoint + `start` first, like every risky op) and journal every
  move/delete through `appendAction` (`file_move` entries + `file_write` deletes with
  `preContent`, so `revert action <id>` undoes either). Deletes keep pre-images only for
  files ≤ 1MB (matches tools.js's `wrapMutatingTool` convention; larger files are deleted
  without journaling — `skippedJournal` counter in the answer). Caps: 20 result files,
  2000 hash-candidates, 50MB per hashed file, 100 moves per tidy, 12 preview lines.
  Eligible from every workspace type — deliberately NOT in WORKSPACE_DEV_ONLY_INTENTS.
- `server/toolPanelRegistry.js` + `server/routes/toolPanelRoutes.js` — Phase 1.5 (2026-08-11,
  shared interactive Tool Panel architecture): the server-driven interactive-tools registry
  (`TOOL_PANELS`: calculator, pdf-tools, reminders, file-tools, notes, csv-tools, clipboard, backup — `getToolPanels()`/`getToolPanel()`, REST
  `GET /api/tool-panels` mounted in server/index.js). PDF Tools is a real panel since Phase 3
  (see pdfKit.js entry below); Reminders is a real panel since Phase 4 (see builtinReminders.js);
  Calculator is a real live widget since Phase 6 (see the CalculatorPanel.tsx frontend bullet;
  its "=" evaluates via POST /api/calculate — routes/calculateRoutes.js — which calls the SAME
  mathEval.js functions the chat command uses, so the panel result and the chat answer can
  never diverge; the widget ALSO supports keyboard input: digits/operators/Enter/Backspace/
  Escape, ignored while an input field is focused); Wire
  contract: intent-data entries carry an `opensPanel` tag (see
  `server/intents/toolPanelIntents.js` + pdfIntents.js), and the opener handlers in
  `server/wsHandlers/builtinTools.js` (`system.tools.open_calculator` /
  `system.tools.open_pdf_tools` / `system.tools.open_reminders`, registered in BUILTIN_INTENTS, NOT dev-only) send the normal
  `answer` message with an ADDITIVE `openPanel` field — no new WS type, no protocol change.
  The answer text is always CLI-usable (calculator handler also sends `suggestions` chips
  ["calculate 15% of 80","calculate 340 / 4"]; the pdf.* handlers send the operation GUIDE
  text with openPanel when the input lacks parameters, so typing "merge pdfs" lands in the
  panel while "merge a.pdf and b.pdf into c.pdf" executes in chat). `server/cli-client.js`'s
  `answer` case permanently ignores `openPanel` — deliberate: the CLI is text-only, the
  comment in that case documents the gap. preSemanticOverrides.js carries the `^run (the|this)?
  calculation$` → system.chit_chat.calculate literal so the calculator opener's examples
  can't steal the documented "run the calculation" drift, plus the pdf-verb + pdf-mention
  rules below.
- Frontend: `src/components/ToolsPanel.tsx` (card grid → dedicated panel view with a back
  button — renders `PdfToolsPanel` for 'pdf-tools', `RemindersPanel` for 'reminders',
  `FileToolsPanel` for 'file-tools', `NotesPanel` for 'notes', `SpreadsheetPanel` for
  'csv-tools', `ClipboardPanel` for 'clipboard', `BackupPanel` for 'backup', placeholder for anything else),
  `useConsole.ts` toolPanel state cluster (`toolsOpen`/`activeToolPanel`/
  `toolPanels` + `fetchToolPanels`), `wsMessageCases.ts` answerCase reads `payload.openPanel`
  and opens the panel, App.tsx Tools view (header Tools button only when a General-workspace
  project is active) with per-project last-open persistence under `console.toolPanelByProject`.
- `server/pdfKit.js` + `server/routes/pdfRoutes.js` + `server/wsHandlers/builtinPdfTools.js` +
  `server/intents/pdfIntents.js` — Phase 3 (2026-08-11, PDF toolkit, all live): the pure
  operations core (pdf-lib for build/split/watermark, pdf-parse v2 for text — both real
  dependencies added 2026-08-11), the chat-side trigger handlers (five intents:
  `pdf.merge`/`pdf.split`/`pdf.extract_text`/`pdf.extract_pages`/`pdf.watermark`, all tagged
  `opensPanel: 'pdf-tools'`, NOT in WORKSPACE_DEV_ONLY_INTENTS), and the REST surface for the
  panel (`GET /api/projects/:id/pdf-files` — project-relative .pdf list; `GET
  /api/projects/:id/file?path=` — project-scoped download/view via the same
  createResolveSafe escape rejection the file tools use; `POST /api/projects/:id/reveal` —
  OS "show in folder"). Safety: extract_text is read-only and answers immediately; every
  write op goes through the standard confirm flow (pendingConfirmations `pdfOp` record,
  consumed in connectionConfirm.js — checkpoint first, then the pdfKit.js op) and journals
  each created file via appendAction as `file_write` with `existed: false`, so `revert
  action <id>` deletes it. Output files are NEVER overwritten (refuseExistingOutput — a
  binary pre-image can't be journaled, so an overwrite would be unrevertable); the refusal
  is an `answer` (same channel as the handler's own refusals, verified live). Caps:
  MAX_PDF_FILES 200, MAX_MERGE_INPUTS 10, MAX_PDF_BYTES 150MB, MAX_TOTAL_PAGES 2000, preview
  cap 4000 chars. `parsePdfNames`/`parsePdfOutput`/`parsePageSpec`/`extractWatermarkText`/
  `resolvePdfInput` (stem match ≥4 chars) are pure and covered by checkHandlerCoverage
  unit rows. The interactive panel (`src/components/PdfToolsPanel.tsx`) is a thin
  file-picking layer ONLY: every Run button composes the exact trigger-command line the chat
  already understands and sends it through the normal WS path — confirm cards, answers and
  journaling stay in the terminal as the single source of truth (same contract as
  Dashboard's Run/Stop buttons). Panel features: project PDF list with per-file download +
  reveal, merge multi-select chips + output name, split mode radios (per page / around page
  N), extract-text, page-range extract with optional output name, watermark text. Output
  names are sanitized client-side (path separators / shell-hostile chars stripped).
- Phase 3 scanner recognition: `codebaseData.js` gained `DOCUMENT_EXTS` (`.pdf` only,
  deliberately — it doubles as a project-discovery signal and must stay narrow) →
  codebaseIndexer counts `documentCount` → `isRecognizableByCodeAlone` includes
  document-only folders (a PDF-only folder pasted as the scan target must resolve to itself
  via the container scan's `hasRootPdf` check in projectScanContainer.js, not to zero
  projects) — but `detectWorkspaceType` deliberately does NOT count documents as a 'dev'
  signal, so a PDF-only folder classifies 'general', never 'dev'. Confirmed live: fixture
  with alpha.pdf/beta.pdf/notes.txt → single project, workspaceType 'general'.
- Phase 3 matcher guard: preSemanticOverrides.js carries five literal rules — a pdf
  operation verb (merge/combine/join, split, extract, watermark/stamp) PLUS a pdf mention
  (.pdf extension, the word pdf, or "pdf file(s)"), lookahead-anchored in either order, maps
  extract+pages → extract_pages and extract+text → extract_text. Confirmed live 2026-08-11:
  "merge alpha.pdf and beta.pdf into combined.pdf" routed to system.chit_chat.deploy (the
  git/deploy clusters own every "merge ... into ..." shape) before the override; now pinned.
  Non-pdf senses of the same verbs are untouched (battery rows: "merge this branch into
  main" → entry_point, "split the window" → structure, "extract the zip file" → file_count).
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
- `server/wsHandlers/builtinReminders.js` + `server/schedules/reminderParser.js` +
  `server/intents/reminderIntents.js` — Phase 4 (2026-08-12): personal reminders
  (`server/intentsData.js` merges REMINDER_INTENTS; registered in BUILTIN_INTENTS, NOT in
  WORKSPACE_DEV_ONLY_INTENTS — reminders are personal, usable from any project).
  `reminderParser.js` parses free-form dates via chrono-node (one-shots) + its own
  weekday/daily/interval branches (recurrence TYPE before chrono, since scheduler's isDue
  needs the type); `reminderHandlers` create/list/cancel `kind: 'reminder'` schedules in the
  SAME scheduleStore. Delivery is project-session → any-session → schedule log (deliverReminder
  in scheduleFire.js, synchronous — reminders are plain text, never queued/re-matched, so they
  can't drift into a mutating intent). Cancel accepts BOTH `cancel reminder s8` and bare
  numbers (`cancel reminder 8` — normalized with a `/^\d+$/` → `s`-prefix rewrite in the
  handler; a bare number is what users naturally type after reading the list). Verified live
  2026-08-12: create→fire→deliver-to-creating-session→remove runs green end-to-end (fire due
  at fireAt, delivered on the next 15s tick, the schedule removed after), CLI-parity checks
  pass, and no-session fires land in schedule-log.md. Known observation: the first
  embedding-staged match after a server boot can block the event loop ~30–45s (warm-up; the
  reminder create shapes triggered by pre-semantic routes stay fast). The Reminders panel
  (registered in `server/toolPanelRegistry.js`, rendered by `src/components/RemindersPanel.tsx`)
  is a dedicated Apple Reminders-style sectioned list (Today/Upcoming/All); `GET
  /api/reminders` (`server/routes/reminderRoutes.js`, mounted in server/index.js) serves the
  read-only list. Mutations (create/complete-as-cancel) use the normal WS trigger-command path
  so confirmations and the terminal stay the single source of truth. `system.tools.open_reminders`
  (builtinTools.js) opens the panel and lists current reminders as plain text for CLI parity.
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
  entries first in `stopTrackedProcess`, so they never fire). Phase 8 follow-up (2026-08-11): the
  event set gained `collision-found` (boot-time baseline drift, see `server/collisions.js`).
- `server/autoStartProjects.js` + `server/wsHandlers/connectionAutoStartAdmin.js` — Phase 8
  follow-up (2026-08-11): per-project auto-start. `auto-start this project [with "phrase"]` /
  `auto-start <name>` / `disable auto-start` / `list auto-start` / `run auto-start now` /
  `review auto-start` (pre-matcher admin tier, connectionExecute.js). Persisted to gitignored
  `data/auto-start.json` (debounced), boot-run log at `data/auto-start-log.md`. `initAutoStart()`
  runs from server/index.js AFTER the semantic matcher is ready (the stored phrase is re-matched
  at boot): candidate dev URLs are probed first (an already-answering site skips the run — no
  double-serve over a manual instance), the resolved intent must be launch-shaped
  (`LAUNCH_INTENTS`: run_project/npm_run/run_tests) or a configured entry (drift guard — a
  phrase that drifted onto git push never runs unattended), runs are staggered 20s apart through
  taskQueue, and results go to the first live session of that project or the log. Confirm
  prompts from risky entries are collected and expire via the pending TTL — boot-time runs never
  auto-approve anything.
- `server/collisions.js` — Phase 8 follow-up (2026-08-11): intent-collision baseline monitor. At
  boot (after semanticMatcher is ready + notify rules loaded) it computes `findIntentCollisions()`
  (matcherCollisions.js, 0.9 threshold), diffs against the persisted `data/collisions.json`
  baseline (gitignored), fires the opt-in `collision-found` notification for new pairs, and
  persists the new baseline (atomic write). Fire-and-forget, never blocks boot. The on-demand
  `check collisions` command (connectionTelemetry.js) is unchanged.
- **Atomic durable-state writes (2026-08-11)**: every gitignored runtime-state file that a torn
  write would silently reset on next boot uses `writeFileAtomicSync` (atomicWrite.js): telemetry
  thresholds/model files, distillation + near-miss logs (updateNearMiss rewrite), action-history
  trim rewrite, schedules.json, tuning.json, auto-start.json, notifications.json, collisions.json
  baseline, session meta files. Appends (telemetry/near-miss/action-history NDJSON lines,
  dev-urls/schedule/auto-start logs) stay plain appendFileSync — a torn append loses one line,
  never the whole file.
- `server/aiDockHints.js` — Phase 8 follow-up (2026-08-11): AI-dock bootstrap hints. Single
  consumer: builtinChitChat's `needs_ai_mode` handler appends a concrete AI-dock instruction
  (`aiDockInstruction(input)`) — a curated rephrase for create/fix/explain-shaped asks, the
  user's own words otherwise — instead of a dead-end "flip the toggle".
- `server/updateChecker.js` + `server/wsHandlers/connectionUpdateAdmin.js` — Phase 5 (2026-08-11):
  npm update awareness. `check for updates` / `update console` / `update the console` /
  `upgrade console` (pre-matcher admin tier, connectionExecute.js). `checkForUpdates()` fetches
  `https://registry.npmjs.org/<pkg>/latest` (4s AbortSignal; null on ANY failure → offline machines
  never see an error), compares against the version in the package's OWN package.json (read via
  `fileURLToPath` from the module dir — `process.cwd()` is wrong under `npx`, which runs with the
  user's cwd). `update console` re-checks when no data was cached and only asks for the
  `npm install -g local-project-console` confirm when an update is actually available —
  otherwise it honestly answers "already on the latest version". `takeUpdateNotice()` is
  one-shot per boot: on WS connect (connectionLifecycle.js) the server pushes `update_available`
  (current/latest) at most once, and the frontend (wsMessageCases.js → `updateNotice` state →
  App.tsx banner above the chat) renders a dismissible "Update available" strip; dismissing is
  per-page-session only, the server-side one-shot is what stops repeat pushes. No auto-update,
  no background npm write — the confirm runs through the same gated `confirm_prompt`/
  `stdinWrite` path as every risky command.
- `server/workspaceTransfer.js` + `server/wsHandlers/connectionWorkspaceAdmin.js` +
  `server/routes/workspaceRoutes.js` — Phase 6 (2026-08-11): portable workspace export/import,
  the whole-setup counterpart to the pack installer. `export workspace` collects a core bundle
  (profile via `writeProfile`/`readProfile` in profileRoutes.js, trained confidence model via
  modelStore.js, tuning overrides via tuningStore.js, per-intent threshold overrides via
  telemetryThresholds.js's `replaceThresholdOverrides` — each a real exported write path reused
  by import), then asks WHICH projects' `.console/memory.md` + `console.tools.json` to include
  (numbered opt-in list, never silent — `export workspace with projects 1 3` / `with all
  projects` / `without projects`, consumed in the interceptor chain like the pack reply).
  Bundle written to gitignored `data/workspace-exports/workspace-<yyyymmdd-hhmmss>.json` (v1,
  50MB read cap, 5MB/2MB per-project file caps); the answer carries both the absolute path and
  a markdown download link to `GET /api/workspace/export?file=<name>` (basename-validated, no
  `?file` → newest bundle). `import workspace <path>` previews every section and what it
  overwrites, then is a two-step confirm (`confirm import workspace` / `cancel import
  workspace`, 5-min TTL on `sessionContext.pendingWorkspaceImport`, mirroring pendingPackInstall).
  Section-granular apply: a corrupt section is skipped, never fatal; projects whose id isn't in
  the scan cache are reported as skipped (rescan first). Deliberately local-file only — no
  network, matching the offline-first design.
- `server/codeIndex/` — Phase 7 (2026-08-11): persisted semantic code index. `codeIndexData.js` (constants: store at `<project>/.console/code-index.json`, file/chunk
  caps 4000/20000, 1MB file cap, ignore dirs), `codeIndexChunker.js` (pure chunking:
  symbol-anchored ranges via `extractSymbols()` start lines for AST-capable exts, fixed
  40-line/10-overlap windows for the rest, oversized bodies split at 2000 chars),
  `codeIndexStore.js` (JSON store with per-file mtime manifest, atomic debounced writes that
  CREATE `.console/` when missing, brute-force cosine search via `cosineSimilarity`; corrupt
  chunk records — incl. typed-array-as-object vectors from a pre-fix save — reset the whole
  store so `indexNeedsFullBuild` rebuilds instead of leaving a permanently empty index),
  `codeIndexBuilder.js` (`buildProjectIndex` full walk + `updateFileInProjectIndex`
  single-file updates, both always inside taskQueue; embeds via the SAME
  `semanticMatcher.extractor` — `Array.from()` on the typed-array output is mandatory,
  JSON.stringify otherwise serializes vectors as `{"0":...}` objects; lazy per-project
  chokidar attach via `watchProjectCodeFiles` for incremental re-chunks, unlink drops
  chunks), `codeIndexSearch.js` (`searchProjectCode` statuses: unavailable (no model) /
  indexing (build queued or running — never blocks the WS turn) / ready with real file:line
  citations). Intent `project.code.search` ("where do we handle X") in
  builtinProjectKnowledge.js: first query on an unstored project answers "indexing..." and
  the enqueued task posts the results out of band (same pattern as type_check, `ws.readyState
  === 1` guard included). Retrieval-only by design — the answer says results are from the
  index, not generated.
- Misc leaves: `urlSafety.js` (isSafeExternalUrl/isProbeableUrl — SSRF guards; webSearch.js
  re-exports), `regexUtils.js`, `markdownUtils.js`, `webSearch.js` (DuckDuckGo, decodes
  `uddg` redirects, deep-research SSRF guard), `consoleCommandDocs.js` (reference catalog for
  the `system.chit_chat.how_do_i` intent — keyword-matched entries rendered by builtinChitChat;
  keep keywords narrow, "push"/"port" alone hijack adjacent docs. Phase 10, 2026-08-12: also
  served as JSON at `GET /api/command-docs` (routes/commandDocsRoutes.js) for the web Command
  Reference tab (`src/components/CommandReference.tsx` — category sidebar + search +
  phrase/shell code blocks, header book icon), and `system.chit_chat.list_commands` prints the
  ENTIRE catalog as plain text from the CLI ("list commands" / "help all")), `pluginTools.js`
  (console.tools.json manifest
  parsing + sanitizePermissions + injection-safe substitution), `contextInjector.js`
  (codebase-index snippets appended to some trigger replies), `contextResolver.js`
  (last-resort keyword fallback with word-boundary regex — `.env`-style keywords special-cased),
  `gitSafety.js` (createCheckpoint/performUndo/isGitRepo), `metrics.js`, `fileWatcher.js`,
  `mathEval.js` (safe shunting-yard evaluator for the `calculate` intent — `+ - * / ( )`
  only, no eval/Function; Phase 6, 2026-08-12 adds `convertUnits` — offline static
  length/weight/volume/temperature table — and `percentageQuery` — percent-of/tip/tax phrases,
  both still evaluated through the same safe tokenize/evaluate path), `platformCommand.js`,
  `typedCommand.js` (2026-08-11 wrapper-project fix: `getCommandDir`-aware
  `extractCommandLine` — the typed-input
  bypass gate in connectionExecute.js. Exact well-formed command lines run directly: first
  token allowlisted OR PATH-resolved (so any real executable works, including ones the
  matcher has no intent for — "ng serve" in a wrapper project), natural prefixes
  ("run ng serve", "command - git status"); single tokens still require the allowlist.
  `resolveExecutableOnPath` caches by PATH. The strict ALLOWED_COMMANDS gate still governs
  chips/AI tool calls — only typed input gets PATH resolution. Follow-up fix, same day:
  `resolveExecutableOnPath(token, projectRoot)` now checks `<projectRoot>/node_modules/.bin/`
  FIRST — a project's own devDependency CLI (e.g. Angular's `ng`, installed via plain
  `npm install`, never global) is invisible to a system-PATH-only scan, which is what actually
  broke "ng serve" on a live report even after `ng` was allowlisted. `connectionExecute.js`
  resolves the effective command dir (`getCommandDir` — wrapper sub-package aware) BEFORE
  calling `extractCommandLine` so the right `node_modules/.bin` gets checked. `ALLOWED_COMMANDS`
  (`toolAllow.js`) also broadened beyond the original JS-centric list: `ng`, `flutter`, `dart`,
  `yarn`, `pnpm`, `bun`, `deno`, `cargo`, `go`, `mvn`, `gradle`, `dotnet`, `ruby`, `bundle`,
  `php`, `composer` — this list gates single-token typed commands and the env-prefix fallback
  branch, not just PATH resolution, so a framework CLI needs to be here even when it also
  resolves on PATH). Natural-language guard (Phase 2, 2026-08-11): `find`/`sort`/`where`
  resolve to real Windows binaries, so a first token in that set followed only by plain words
  ("find duplicate files", "sort these files by type") is rejected and reaches the matcher —
  confirmed live by the Phase 2 WS driver, which caught `find.exe` erroring on the
  duplicates intent's own example phrases; real command lines ("find . -name x",
  "sort data.csv") still bypass (`NATURAL_LANG_FIRST_TOKENS` + `PLAIN_WORD_RE`), `commandDir.js`
  (2026-08-11, wrapper-project fix: `getCommandDir`/`getCommandDirScripts` — effective
  command-execution directory. Narrow rule: project ROOT with no app-launching package.json
  script (exact keys start/serve/dev/run — lint/format-only scripts DON'T count, task 0c:
  a root package.json that only holds placeholder/lint scripts must not block wrapper
  detection, and then the single sub-package must carry a real launcher script to win) and
  not a workspace root + exactly ONE direct subdirectory carrying a package.json with
  scripts → that sub-package is the command dir (one-level fs probe — the codebase index
  can't answer this: detectSubPackages only reports >=2 manifest dirs). Root launcher and
  workspaces stay absolute vetoes; true monorepos (2+ sub-packages) return null.
  Consumers: builtinFileNpm (scripts + execute cwd), connectionExecute (typed commands),
  connectionToolCall (chip/executeCommand cwd), toolProcess (runTests), projectScanContainer
  (adopts the sub-package's README/CLAUDE.md into contextFiles at scan time so README
  run-command discovery + overview Q&A work for wrapper projects). `builtinRunSuggestions`
  hedges its "static site (no build step)" guess when `idx.subPackages.length > 1` and the
  rule couldn't resolve one ("this looks like it might have a nested app..."). `runCommandPatterns.js`
  gained the `ng serve/build/test` pattern (the README parser never recognized Angular CLI
  commands)

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
- **general.files** (generalFileIntents.js → builtinGeneralFiles.js, Phase 2, 2026-08-11):
  find / tidy / duplicates / duplicates_delete — see the architecture entry for the full
  behavior. Content-search phrases ("search my files for X") and tidying phrases must NOT
  drift into file_find / deploy; the typed-command guard in typedCommand.js protects them
  from `find.exe`/`sort.exe`/`where.exe` on Windows.
- **pdf** (pdfIntents.js → builtinPdfTools.js, Phase 3, 2026-08-11): merge / split /
  extract_text / extract_pages / watermark — see the pdfKit.js architecture entry for the
  full behavior. .pdf-bearing operation shapes are pinned by pre-semantic overrides (the
  git/deploy clusters own every "merge ... into ..." shape); bare verb-only inputs without
  a pdf mention route by embedding and open the panel when under-specified.

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
- **CLI parity for WS message types (Phase 0, enforced)**: `server/cli-client.js` is a second
  renderer of the same WS protocol, and message types it doesn't handle used to fall through
  `default` and vanish with zero signal (`warning`, `server_url`, `update_available` were all
  silently dropped). `checkWsMessageCases.ts` now FAILS when a key exists in `WS_CORE_CASES`
  without a corresponding `case` in cli-client.js's switch — rendered or an explicit
  commented no-op both satisfy it. Any new WS type added to the web case table needs its CLI
  case in the same change.
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
- **General pseudo-workspace (2026-08-12)**: a reserved `__general__` project id
  (`GENERAL_PROJECT_ID`/`getGeneralProject()`/`resolveProject()` in state.js) lets a user
  chat and use personal tools BEFORE picking a real project — `handleExecute` and the
  project-scoped REST routes resolve it to a synthetic project rooted at
  `data/general-workspace/` (console-owned, gitignored, never the scan root). The client
  mirrors it as `GENERAL_PROJECT` in App.tsx and sends `projectId: '__general__'` when no
  project is active. Sessions created against it lock to that id like any other session —
  the session-lock check is untouched. The Developer/General tab switcher is ALWAYS visible
  (it used to be gated on an active project, which made the General tab unreachable on a
  fresh open), and the General tab lands on the Tools card grid (tools-first; chat reachable
  via the grid's close/back or the header Tools toggle).
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
  check-tools 149/149;
  check-indexer 85/85 (+14 SYMBOLS & GRAPH rows for the Phase 1.1 codebase-graph work);   check-ws-cases 115/115 (measured baseline 88/88 — the documented 84 was stale by +4
  later additions — +27 Phase 0 CLI-parity rows: every WS_CORE_CASES key now requires a `case`
  in cli-client.js's switch). check-docs 46/46 (catalog entries
  mirrored in README's command-reference table — `server/scripts/checkDocsSync.js`, run via
  `npm run check-docs`, wired into CI). check-handlers 36/36 (baseline +1 Phase 7 code.search
  row); check-indexer 94/94 (baseline +9 Phase 7 CODE-INDEX chunker/store rows, incl. the
  typed-array-as-object corruption regression); check-matcher 152/153 — 146 inputs + 7 NEW
  Phase 7 CODE-SEARCH rows, with the same ONE PRE-EXISTING drift on CONTROL's "run the
  calculation" (routes to system.chit_chat.calculate on this machine's local data; reproduced
  identically on clean HEAD with the how_do_i work stashed — not a regression). Phase 2
  (2026-08-11): check-handlers 77/77 (baseline 58/58 + 19 GENERAL-FILES rows incl. the
  temp-dir tidy/dedupe/revert smoke and extractFindQuery unit rows); check-tools 154/154
  (baseline 149/149 + 5 typed-command natural-language-guard rows); check-matcher 170/171
  (baseline 152/153 + 18 GENERAL-FILES rows, same one PRE-EXISTING drift); check-intents
  unchanged at 1/5/82 (the four new intents added no near-dups). Phase 1.5 (2026-08-11):
  check-handlers 80/80 (baseline 77/77 + 3 TOOLS-LEAF rows — the openPanel-on-answer and
  chips assertions); check-matcher 175/176 (baseline 170/171 + 5 PHASE-1.5 opener rows, same
  one PRE-EXISTING drift — "run the calculation" still routes to system.chit_chat.calculate,
  which the Phase 1.5 pre-semantic override re-pins after the calculator opener's examples
  briefly stole it; the trust-guard row's didYouMean for the .pdf example moved from file_read
   to open_pdf_tools, the intended direction — see the row comment); check-ws-cases 118/118
   (baseline 115/115 + 3 answer-openPanel rows); check-intents unchanged at 1/5/82 (the two new
   intents' "show me ..." shapes were trimmed during calibration because they near-dupped
   "show me the todos" and stole generic "show me the results" inputs). Phase 3 (2026-08-11):
   check-handlers 108/108 (baseline 80/80 + 28 PDF rows — the five pdf.* dispatch shapes, the
   unit rows for parsePdfNames/parsePdfOutput/parsePageSpec/extractWatermarkText/resolvePdfInput,
   and the documentCount/isRecognizableByCodeAlone/workspaceType-classification asserts);
   check-matcher 200/201 (baseline 175/176 + 25 inputs: 20 PDF battery rows — the .pdf-bearing
   merge/split/extract/watermark shapes now pinned by the Phase 3 pre-semantic overrides, so
   they're machine-independent — + the live-confirmed "merge alpha.pdf and beta.pdf into
   combined.pdf" row; same ONE PRE-EXISTING drift on "run the calculation"); check-indexer
   95/95 (baseline 94/94 + 1 documentCount/DOCUMENT_EXTS row); check-intents unchanged at
   1/5/82 (the five pdf intents added no near-dups); check-ws-cases 118/118 unchanged (no new
   WS types — openPanel stays an additive answer field); check-tools 154/154 unchanged.
   Phase 4 (2026-08-12): check-handlers 120/120 (baseline 108/108 + 12 rows — 11 REMINDERS
   dispatch + parse asserts + 1 open_reminders opener dispatch row incl. openPanel assertion
   on the create-failure reply); check-matcher 219/221 (baseline 200/201 + 18 REMINDERS rows
   + 2 new open-reminders opener routing rows — same TWO PRE-EXISTING PDF drifts on "extract
   the archive" and one other; the open_reminders rows both routed correctly); check-intents
   unchanged at 1/5/82 (the open_reminders examples and opensPanel metadata added no near-dups);
   check-ws-cases 118/118 unchanged (no new WS types); check-docs 49/49 (+1 reminders catalog
   entry, README rows synced). Phase 2 catch-up (2026-08-12, File Tools panel):
   check-handlers 121/121 (baseline 120/120 + 1 open_file_tools opener row); check-matcher
   221/223 (baseline 219/221 + 2 open_file_tools routing rows — the "open file tools" shape
   was hijacked by the open_file literal rule until `tools` joined its lookahead exclusion;
   same TWO PRE-EXISTING drifts); check-intents unchanged at 1/5/82; check-docs 50/50 (+1
   file-tools catalog entry); check-ws-cases 118/118 unchanged.
   Phase 5 (2026-08-12): check-handlers 130/130 (baseline 121/121 + 9 rows — 3 notes dispatch
   shapes against the fixture, 6 temp-dir store smoke asserts, 1 open_notes opener row);
   check-matcher 231/233 (baseline 221/223 + 10 NOTES battery rows — incl. the free-text
   "note: <arbitrary words>" and "search my notes for <arbitrary words>" shapes pinned by
   Phase 5 pre-semantic overrides after the trailing nouns dominated the vector, same class
   of trap as the remind-me override; same TWO PRE-EXISTING drifts); check-intents unchanged
   at 1/5/82; check-docs 51/51 (+1 notes catalog entry); check-ws-cases 118/118 unchanged.
   Phase 6 (2026-08-12): check-handlers 142/142 (baseline 130/130 + 12 rows — mathEval
   convert/percent unit asserts + calculate-handler dispatch rows); check-matcher 241/243
   (baseline 231/233 + 10 rows: 8 PHASE6 convert/percent/tax/tip shapes + 2 symbol-operator
   arithmetic rows — pinned by Phase 6 pre-semantic overrides; the tax/tip shapes also needed
   the looksLikeRealRequest extension-dot fix in intentTrust.js, ".25" must not read as a
   file extension; same TWO PRE-EXISTING drifts); check-tools 156/156 (baseline 154/154 + 2
   convert natural-language-guard rows — `convert` is a real Windows binary, "convert 5 km to
   miles" must reach the matcher, not the NTFS convert tool); check-intents unchanged at
   1/5/82; check-docs 52/52 (+1 convert/calculator catalog entry); check-ws-cases 118/118
   unchanged.
   Phase 7 (2026-08-12): check-handlers 155/155 (baseline 142/142 + 13 rows — csv engine
   unit asserts + 6 csv dispatch shapes against a temp-dir CSV + 1 open_csv_tools opener
   row); check-matcher 249/251 (baseline 241/243 + 8 CSV battery rows — pinned by Phase 7
   pre-semantic overrides, the .csv token + free-form where-values carry no embedding weight;
   same TWO PRE-EXISTING drifts); check-intents unchanged at 1/5/82; check-docs 53/53 (+1
   csv catalog entry); check-ws-cases 118/118 unchanged.
   Phase 8 (2026-08-12): check-handlers 164/164 (baseline 155/155 + 9 rows — 3 clipboard
   dispatch off-state rows + 5 snippet-store temp-file unit asserts + 1 open_clipboard opener
   row); check-matcher 259/261 (baseline 249/251 + 10 CLIPBOARD battery rows, same TWO
   PRE-EXISTING drifts); check-intents unchanged at 1/5/82; check-docs 53/53 unchanged (the
   clipboard catalog entry replaced the schedule-log row position — verify count on next
   run);    check-ws-cases 118/118 unchanged (copy_to_clipboard comment-only update).
   Phase 9 (2026-08-12): check-handlers 168/168 (baseline 164/164 + 4 rows — 1 open_backup
   opener row + 3 temp-dir backup-store asserts: zip created/list/missing-subfolder-refused);
   check-matcher 264/266 (baseline 259/261 + 5 BACKUP battery rows, same TWO PRE-EXISTING
   drifts); check-intents unchanged at 1/5/82; check-docs 54/54 (+1 backup catalog entry);
   check-ws-cases 118/118 unchanged. Phase 10 (2026-08-12): check-handlers 169/169 (baseline
   168/168 + 1 list_commands dispatch row); check-matcher 269/271 (baseline 264/266 + 5
   PHASE10 rows — "list commands"/"help all" route to the new list_commands intent, while
   "list all commands"/"show all commands" stay on help (both answer fine; no override forced);
   the list_commands examples deliberately carry NO "show ..." shapes after "show everything
   you can do" drifted the status intent's didYouMean — same corpus-collision lesson as
   Phase 1.5; same TWO PRE-EXISTING drifts); check-intents unchanged at 1/5/82; check-docs
   55/55 (+1 list-commands catalog entry); check-ws-cases 118/118 unchanged.
   Phase 11 (2026-08-12): no harness deltas — CommandDeck ranking is client-side (localStorage
   `console.deckUsage`, Recent/Frequent/All sections per the Raycast reference). Deliberately
   NOT a second server telemetry store: the server's intentTelemetry stays the confidence
   model's data source; the palette's ranking is UI-level, persisted in the same inline-
   localStorage style as pinned projects/workspace tabs (roadmap step 2's sanctioned "minimal
   lastUsedAt map").
   Phase 12 (2026-08-12): check-handlers 171/171 (baseline 169/169 + 2 rows — backup-action
   journal + backup revert deletes the zip from data/backups); check-tools 156/156 unchanged;
   check-matcher/handlers/intents/ws-cases unchanged. Audit result: every post-Phase-1
   trigger-only mutator journals through appendAction (tidy/duplicates/PDF/backup); the backup
   journaling bug found live — it passed project.id instead of project.path, so the action was
   never written to the project's own history file — is fixed, plus revertAction's `backups/`
   prefix special-case.
   Phase 13 (2026-08-12): no harness deltas (profile field + first-run UI). The web wizard
   (FirstRunSetup.tsx) gained a default-workspace-type selector (Developer/General) + an
   Ollama note; the CLI mirrors it via @clack after connect when setupComplete is false.
   `defaultWorkspaceType` ('dev'|'general', sanitized server-side) is the App's tab fallback
   for unclassified/no-project states. Live-verified: POST round-trips + sanitization.
   Run the relevant battery after ANY edit to the corresponding module.
- **editFile** tolerates whitespace differences (normalized line-range fallback) but not
  wrong wording; on total failure the error names both attempts and tells the caller to
  re-read the file. Truncation guard: `writeFile` re-reads and compares length after writes.
- **Windows harness gotcha**: the phase2 smoke (python http.server) never exits on its own
  (orphaned child inherits stdio pipes) — run via Start-Process + timeout + force-kill.

## Phase 6 (2026-08-11) — portable workspace export/import (all live)

- **`export workspace` / `import workspace <path>`** — full setup bundling (profile, trained
  confidence model, tuning overrides, intent-threshold overrides + opt-in per-project
  `.console/memory.md` and `console.tools.json`), written to gitignored
  `data/workspace-exports/` with a markdown download link; import is preview-then-confirm and
  never overwrites silently. Verified live 2026-08-11: 18-check round-trip (export → download →
  mutate profile → cancel-import no-op → confirm-import restores → stale-phrase hint). Driver
  gotchas: a crashed run poisons the next run's baseline (profile name), and wait-for-event
  helpers must match only FRESH events, not the events array.

## Phase 5 (2026-08-10)

- **Update checker** (2026-08-11): `check for updates` / `update console` admin commands +
  one-shot `update_available` push on WS connect → dismissible banner in App.tsx. See the
  architecture entry for `server/updateChecker.js`. Confirmed live 2026-08-11: registry check
  returns 1.0.1/latest and both commands answer correctly; the confirm path only fires when
  an actual newer version exists (not testable against the live registry at 1.0.1).

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

## Phase 8 (2026-08-11) — backlog/QoL batch 1 (all live)

- **Live Sites "process is not running" fixed**: `Dashboard.tsx` used to key the Live Sites
  dot/label off `runningCommand` (a tracked-process flag), so console-self and servers the
  user started outside the console showed the site as live but labeled "process is not
  running". `/api/dashboard` entries now carry `running: boolean` = any tracked process
  OR the stored-URL probe answered OR the project IS the console itself (serving the
  request). Dashboard renders "live now" vs "recorded — not currently answering" from
  `entry.running`; the sort score includes it. Recall the cache: 30s, invalidated by
  `volatileSignature()`; probe is 1200ms at cache build.
- **Runtime tuning overrides** (no reboot, no code edit): `server/tuningStore.js` +
  `data/tuning.json` (gitignored) + `GET/POST/DELETE /api/tuning` (`tuningRoutes.js`)
  override the exported knobs `FUSE_THRESHOLD`, `FUSE_MIN_MATCH_CHAR_LENGTH`,
  `INIT_WAIT_POLL_MS`, `SUGGESTION_DEFAULT_LIMIT`, `COLLISION_DEFAULT_THRESHOLD`,
  `DEV_URL_DETACH_GRACE_MS`, `DEV_SERVER_FORCE_DETACH_MS`, `LONG_RUNNING_FORCE_DETACH_MS`,
  `STDOUT_SUMMARY_CAP`, `STDERR_SUMMARY_CAP` (executor.js), `DEBOUNCE_MS`
  (verifyHarness.js), with BOUNDS validation (unknown keys/out-of-range rejected). Apply =
  `semanticMatcher.refreshFuseIndex()` rebuilds the Fuse index when ready. UI: gear →
  Advanced → "Tuning" groups in `UserProfileModal.tsx` (Apply posts only diffs from
  default, Reset deletes the file). The source files' exported constants stay the
  documented defaults — `getTuning(name, fallback)` is the read path everywhere.
- **Health check command**: "health check" / "is my console healthy" (also "console
  health", "how healthy is my console") → `connectionHealthCheck.js`: Ollama
  `/api/version` reachability via `getOllamaHost()` (2s abort), embedding state
  (`semanticMatcher.ready`/`initError`), free disk space on the `data/` drive (3s
  PowerShell Get-PSDrive) and a zombie tracked-process scan (`process.kill(pid, 0)` —
  EPERM means alive; best-effort on Windows, PID reuse caveat in the reply, ≤10 listed).
  Read-only, dispatched from the same pre-matcher admin tier as notify/pack commands.
- **Pinned projects**: sidebar rows get a star (hover reveal, yellow when pinned);
  `localStorage['console.pinnedProjects']`; pinned rows float above the rest. No state
  change elsewhere — same project list, same click actions.
- **Diagnostics intents** (read-only, never run anything): `test_coverage_report` parses
  `coverage/lcov.info` (SF/LF/LH records), `.coverage/lcov.info`, `lcov.info`, then
  `coverage/coverage-summary.json|coverage-final.json` (per-file `lines.total/covered`):
  overall % + worst 10 files; clean "no coverage report" answer otherwise.
  `bundle_size_analysis` walks `dist/build/out/public/build/web-build` (depth ≤6, ≤5000
  files) for .js/.cjs/.mjs/.css, largest 8 + total; clean "no build output" otherwise.
  Both registered in `BUILTIN_INTENTS` + DISPATCH rows in checkHandlerCoverage, no
  pre-semantic override (embedding handles them; confirmed on the harness fixtures).
- **taskQueue global cap**: `MAX_TASK_CONCURRENCY = 3` on top of the per-project
  single-flight rule — schedules firing across many projects can no longer saturate the
  machine with parallel tsc/git runs. `pump()` scans all queues in Map insertion order,
  re-pumps on every completion; `hasActiveTask`/`activeTaskLabel` semantics unchanged.

## Phase 7 (2026-08-11) — real semantic code index (all live)

- **Persisted vector store per project** at `<project>/.console/code-index.json`
  (`server/codeIndex/`, see the architecture entry): chunk records `{id, file, start, end,
  text, vector}` + a per-file mtime manifest, brute-force cosine search (the project's
  scale is a single user's local codebases — no database server, no new npm dependency).
- **Chunking**: top-level symbol bodies (function/class) via the existing `extractSymbols()`
  start lines for AST-capable extensions; fixed 40-line/10-overlap windows for regex-fallback
  and non-JS/TS languages (regex fallback symbols report `line: 0` and cannot anchor);
  oversized bodies split at 2000 chars.
- **Same embedding model as the matcher** (`semanticMatcher.extractor`, no second model).
  The extractor returns typed arrays — `Array.from()` before persisting, or JSON.stringify
  writes `{"0":...}` objects that the load-side validation treats as corruption (found live
  2026-08-11; regression row in check-indexer).
- **Background-only builds**: full build + single-file updates always run through taskQueue
  (never on a WS turn); lazy per-project watcher (`watchProjectCodeFiles`) attaches only to
  indexed projects and re-chunks on change, drops on unlink.
- **Intent `project.code.search`** ("where do we handle X"): first query on an unstored
  project answers "indexing in the background" and the enqueued build posts file:line
  results out of band; later queries hit the store directly. Retrieval-only — the answer
  explicitly says results come from the index, not generation. Registered in BUILTIN_INTENTS
  + projectKnowledgeIntents.js phrases + checkHandlerCoverage (unavailable-path row) +
  checkMatcherCoverage (CODE-SEARCH battery, 7 rows incl. a "where is main.py" guard that
  must stay with file_find). NOTE: "where is the task queue defined"-shaped phrasings can
  still route to `project.context.entry_point` — the intent's phrase coverage is calibrated
  around "where do we handle/find code about" shapes.
- **Corruption resilience**: any dropped chunk record resets the whole store (files manifest
  included) so `indexNeedsFullBuild` triggers a rebuild — never a permanent zero-chunk index
  hiding behind a populated mtime manifest.

## Phase 9 (2026-08-11) — how-do-I knowledge intent + question-shape routing (all live)

- **`system.chit_chat.how_do_i`** (chitChatIntents.js): "how do i <feature>" guidance
  answered from the `consoleCommandDocs.js` reference catalog — side-effect-free, no model
  call. Catalog entries carry `shell` (the real command line) and `phrases` (the patterns
  the entry answers), rendered as the exact phrase + the shell command in a code block +
  a `suggestions` chip so the user can run it directly. `help` / `what can you do` /
  `how do i <anything>` all land here.
- **Question-shape pre-semantic override** (preSemanticOverrides.js, FIRST rule in the
  list): any input matching `^(?:how\s+(?:to|do\s+(?:you|i|we))\s+|(?:what\s+is\s+the\s+)?command\s+to\s+)(?:push|commit|deploy|build|stop\s+the\s+server|open\s+in|show|make\s+a\s+checkpoint|see\s+(?:the\s+)?(?:dashboard|test\s+coverage|bundle)|switch\s+projects|change\s+the\s+theme|check\s+(?:git\s+status|the\s+console\s+health|collisions)|export|schedule|review|approve)` routes to
  how_do_i. Must stay FIRST — the bare "deploy" override lower in the list would steal
  "how do i deploy". Verb list deliberately excludes run/start/launch/serve/install/pull
  so how_to_run / run_project keep their routes. check-matcher HOWTO battery carries 8
  probe-verified question-shape rows.
- **check-docs sync harness**: `server/scripts/checkDocsSync.js` (added to package.json +
  CI) FAILs when a catalog entry's command/keywords have no row in README's command
  reference table, and WARNS on unmapped README rows. Keep the README table and
  consoleCommandDocs.js in sync when adding catalog entries.

## Phase 1 (UPGRADE-ROADMAP, 2026-08-11) — workspaceType foundation + Developer/General tab switcher (all live)

- **`workspaceType` ('dev' | 'general') per project**: `detectWorkspaceType(config,
  codebaseIndex)` in projectScanHelpers.js. console.config.json `workspaceType` override
  always wins (invalid value dropped with a warning, same scan-time sanitize pattern as
  chatReplies); otherwise the folder is 'dev' when `isRecognizableByCodeAlone()` passes —
  real code, a known key config file, or a real .git dir — else 'general'. Attached to every
  project object in projectScanSingle.js / projectScanContainer.js; rides through
  /api/projects + project_updated/projects_updated WS payloads + /api/dashboard entries
  (monitoringRoutes.js) automatically via `activeProjectsCache`.
- **Suggestion-only filtering, never a matching gate**: `WORKSPACE_DEV_ONLY_INTENTS`
  (intentRegistry.js — explicit list: git family incl. `system.chit_chat.git_status` and
  `deploy` (checkpoint+push), run_project/run_tests/how_to_run/checkpoint, npm_install/
  build/run, diagnostics.*, code.search) + `intentWorkspaceEligible(intent, workspaceType)`.
  In a 'general' workspace those intents are hidden from SUGGESTION surfaces only — help
  text (builtinHelp.js trigger lines), did-you-mean chips (matcher.js closeSecond +
  computeDidYouMean), fallback chips (getFallbackSuggestions → searchFuseSuggestions
  exclusion; project-config items, `isProject`, are never filtered). `matchInput()` dispatch,
  collision disambiguation, and the router's allowed list never consult workspaceType — a
  dev command typed in a mis-classified 'general' project still runs exactly as before.
- **Admin commands** (connectionModeAdmin.js, pre-matcher tier in connectionExecute.js,
  same pattern as notify/pack): `switch to developer mode` / `switch to general mode`
  writes the console.config.json override (atomic write, creates the file when missing),
  updates the in-memory project, broadcasts `project_updated`, answers; `what mode am I in`
  reports the effective mode. No new intents or WS message types — CLI parity for free.
- **Tab switcher** (App.tsx header, only when a project is active): Developer/General,
  restores the active project's last tab from localStorage key
  `console.workspaceTabByProject` (per-project JSON map, same inline-localStorage style as
  the pinned-projects rail — deliberately not global), falling back to the server's
  workspaceType, then 'dev'. Clicking a tab persists it AND sends the matching
  "switch to X mode" command through the normal chat flow (server suggestion filtering
  matches immediately; the user message + server answer appear in the terminal).
- **Dashboard cards**: render per-card by the entry's own workspaceType — a 'general'
  project card hides the uncommitted/recent-commits/status panels and Run/Stop/Push/Open
  site actions behind a "later phases" placeholder (no fake data invented); Open in chat /
  Copy path / history stay. `workspaceMode` prop on Dashboard is only the fallback for
  entries the server hasn't classified yet (stale pre-feature cache).
- **Harness rows**: checkHandlerCoverage.js gained workspace-eligibility unit asserts, a
  dev-only-tag sync guard (every tag must still be in BUILTIN_INTENTS), detectWorkspaceType
  unit asserts, and a mode-command smoke against a real os.tmpdir() temp project (the
  handler WRITES console.config.json — the C:/tmp/nowhere fixture must never receive files).
  Verified live 2026-08-11: container scan (package.json → 'dev', plain folder with
  console.config.json → 'general'), override persists across rescan, single-folder scan
  path, 58/58 check-handlers, 115/115 check-ws-cases, lint clean.

## Phase 1.5 (UPGRADE-ROADMAP, 2026-08-11) — shared interactive Tool Panel architecture (all live)

- **Design convention**: a Tool Panel is a dedicated web-UI view (card grid launcher → panel
  view with a back button), and every panel also has a chat-native equivalent — the
  `answer` text that opens a panel must stay CLI-usable, and chips may point at the chat
  form. The wire contract is the additive `openPanel` field on the existing `answer` payload
  (plus the `opensPanel` tag on intent data) — no new WS message type, so the CLI and the
  web render the same protocol; the CLI deliberately ignores `openPanel` forever (text-only,
  comment in cli-client.js's `answer` case documents the gap).
- **Calibration lessons** (caught by check-matcher during the build): "show me <noun>" shapes
  are corpus-collision bait — "show me the calculator" near-dupped "show me the todos" and
  generic "show me the results" inputs drifted to project.context.structure. The two new
  intents keep only verb+noun examples (open/launch/show+calculator/tools/pdf-tools), and a
  pre-semantic override re-pins "run the calculation" → system.chit_chat.calculate.
- **Panels are placeholders** until their phases: PDF Tools (Phase 3) and Calculator
  (Phases 5/6) fill the registry entries in; the frontend renders a generic "coming in a
  later update" placeholder panel for any `opensPanel` id it doesn't know yet.

## Phase 2 (UPGRADE-ROADMAP, 2026-08-11) — general-mode file tools (all live)

- **`general.files.find` / `tidy` / `duplicates` / `duplicates_delete`** — the general-mode
  file workflow set (architecture entry above). Read-only find/duplicates run immediately;
  tidy and duplicates_delete are confirm-gated (`general_files_tidy` /
  `general_files_duplicates_delete` triggers) with checkpoint + `start` first, journaled
  through `appendAction` (`file_move` moves, `file_write` deletes with preContent), and fully
  undoable via `revert action <id>` (itself confirm-gated with trigger `revert_action`).
- The File Tools panel (added 2026-08-12 as a Phase 2 catch-up) is registered in the same
  Tools card grid (`file-tools` entry in toolPanelRegistry.js, `system.tools.open_file_tools`
  opener in builtinTools.js) with a Finder-style file browser (file listing via
  `GET /api/projects/:id/files`, search via `/api/projects/:id/search-files`, duplicates via
  `/api/projects/:id/duplicates` — routes in `server/routes/fileToolsRoutes.js`), a tidy-plan
  launcher, and a keep-newest checkbox duplicate-finder view. Rendered by
  `src/components/FileToolsPanel.tsx`.
- **Typed-command natural-language guard** (typedCommand.js): `find`/`sort`/`where` resolve
  to real Windows binaries, so plain-word sentences starting with them now reach the matcher
  instead of erroring in find.exe/sort.exe/where.exe (caught live by the Phase 2 WS driver on
  the duplicates intent's own example phrase). Real command shapes with flags/paths/globs
  still bypass. 5 new rows in checkToolsCoverage's TYPED battery.
- **Not in WORKSPACE_DEV_ONLY_INTENTS**: these four intents are eligible from every
  workspace type by design (files are files whether the folder is a dev project or not).
- **Harness rows**: checkHandlerCoverage.js 19 new rows (dispatch shapes against the
  read-only C:/tmp/nowhere fixture, extractFindQuery unit asserts, and a temp-dir smoke that
  performs tidy → asserts the confirm `generalFileOp` pending record → performs the moves →
  reverts the `file_move` action; same for duplicates plan/delete/revert with the older-copy
  keep-newest assertion); checkMatcherCoverage.js 18 GENERAL-FILES rows (incl. guards keeping
  "find the config file"/"where is main.py" on file_find); checkToolsCoverage.js 5
  natural-language-guard rows. check-ws-cases unchanged (no new WS types).
- **Verified live 2026-08-11** via the same temp-driver pattern as Phase 1 (PORT=3031,
  fixture with plain text/binary/duplicate files): all 15 driver checks passed — content
  find names the file, duplicates lists both copies, dedupe confirm asks then deletes only
  the older copy (journaled with preContent), chat `revert action <id>` restores it after a
  `revert_action` confirm, tidy confirm moves 7 files into Images/Documents (journaled as
  file_move), and revert moves the file back. Server cleanup verified — no orphan on the
  probe port.

## Phase 3 (UPGRADE-ROADMAP, 2026-08-11) — PDF toolkit (all live)

- **Five trigger intents + real interactive panel** — the backend half (pdfKit.js /
  builtinPdfTools.js / pdfIntents.js) and the frontend half (PdfToolsPanel.tsx) are both
  live; see the architecture entries above for the full behavior. Writes are
  confirm-gated + journaled (`revert action <id>` deletes created files), outputs never
  overwrite, extract_text is read-only.
- **Panel contract**: PdfToolsPanel composes the exact chat trigger-command lines and sends
  them through the normal WS path — confirm cards, answers and journaling live in the
  terminal as the single source of truth, same contract as Dashboard's Run/Stop buttons.
- **Scanner recognition**: `DOCUMENT_EXTS` (`.pdf` only) → `documentCount` →
  `isRecognizableByCodeAlone` recognizes document-only folders, and the container scan's
  `hasRootPdf` makes a PDF-only folder resolve to itself as a single project — while
  `detectWorkspaceType` deliberately keeps classifying it 'general', never 'dev'.
- **Matcher guard**: the five pdf-verb + pdf-mention pre-semantic overrides pin every
  .pdf-bearing operation shape (live-confirmed: "merge alpha.pdf and beta.pdf into
  combined.pdf" was routing to system.chit_chat.deploy). Non-pdf senses of the same verbs
  stay embedding-driven.
- **Harness rows**: check-handlers 108/108 (+28), check-matcher 200/201 (+25, same one
  pre-existing drift), check-indexer 95/95 (+1), check-ws-cases/check-tools unchanged (no
  new WS types), check-intents unchanged at 1/5/82.
- **Verified live 2026-08-11** (PORT=3032, temp fixture with real pdf-lib-generated PDFs,
  pdf-parse-extractable text): 16/16 driver checks — pdf-only folder scans as one project
  classified 'general'; merge/extract-pages/watermark/split all confirm then execute;
  extract-text answers a preview without confirming; a second merge against the existing
  output is refused with an answer ("already exists") and never overwrites; created files
  are journaled as file_write/existed:false (combined.pdf included); /api/projects/:id/
  pdf-files lists only PDFs; /file?path= serves with the right content-type and rejects
  `..` escapes. The panel's exact composed command shapes are the same inputs the driver
  exercised. Browser-click verification of the panel (drag/drop, in-panel confirm) still
  needs one manual pass on a live page.

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
