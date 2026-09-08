# Project Console — Master Execution Prompt (Merged from 3 Research Passes + Original Request)

> This document merges: (1) the original raw brain-dump of everything the user wants fixed/added, and (2) three independent read-only research passes over the codebase (Report A "Merged Pass", Report B "Read-Only Deep Research Report", Report C "Deep Research Report / Executive Summary"). Every finding from all three reports has been folded in under the relevant phase, with file:line evidence preserved. Nothing from the raw request has been dropped — where a raw-request item was **not** explicitly covered by any research pass, it has been added back in as its own task with a note `[NOT COVERED BY RESEARCH — ADDED FROM RAW REQUEST]`.
>
> **This is the EXECUTION prompt.** Unlike the three research passes (read-only, no commits), this session is authorized to make code changes, install dependencies, run builds, and commit/push to GitHub — but only per the Ground Rules below.

---

## 0. Ground Rules for This Execution Session

1. **Before touching any code**: run `git status`, commit/stash anything currently dirty if needed to get a clean baseline, then **push the current repo state to GitHub as a baseline snapshot** before any change is made. This preserves a rollback point. Do this even though two other sessions may also be running against this prompt in parallel — coordinate via small, frequent commits rather than one giant commit at the end, so conflicts are visible early rather than at the very end.
2. **Take as much time as needed.** This prompt is intentionally exhaustive and multi-phase. Do not skip phases to save time. Do not summarize away detail "for brevity" — implement the fix, verify it, move to the next item.
3. **Work phase by phase**, in the order listed below (A → L). Within a phase, tackle items in the order listed. Do not jump ahead unless a later phase is blocking an earlier one (e.g., theming tokens needed before the loading-screen work).
4. **Every fix must be verified**, not just written:
   - For backend/logic fixes: exercise the code path (start the dev server, trigger the flow, confirm the bug is gone) before moving on.
   - For UI fixes: visually confirm in the running app (or via a screenshot-equivalent check) that the element renders and behaves as intended.
   - For "dead button" fixes: click it. Don't just wire a handler and assume it works.
5. **No hardcoded regressions.** Every new value you introduce (colors, ports, timeouts, caps, strings, paths) must go through the existing config/token/tuning patterns identified in Phase B, not as a fresh hardcoded literal. If a genuinely new configurable surface is needed, add it to `tuningStore.js` / `user-profile.json` / `src/index.css` tokens as appropriate, following the patterns the research already identified as exemplary (`server/portConfig.js`, `server/tuningStore.js`, `src/index.css` `@theme inline`).
6. **Code must read as deliberately authored, not AI-generated.** Per Phase B: no over-explained comments, no generic/copy-pasted boilerplate, consistent naming, consistent error-handling style, no unnecessary abstraction layers. When you refactor duplicated logic into a shared helper, name it the way a senior engineer familiar with this codebase would, matching existing conventions (see `server/portConfig.js` and `server/tuningStore.js` as the style bar).
7. **Modularity is mandatory.** Any file you touch that exceeds ~400 lines (the repo's own documented ceiling per `AGENTS.md:79` "No file over ~400 lines; target ~150") should be split as part of the same change, not left oversized. See the full oversized-file list in Phase B.
8. **Cross-check your own work.** After each phase, re-read the diff against the original finding to confirm the root cause was actually fixed, not just the symptom. Several findings below explicitly warn that a naive fix only addresses the visible symptom (e.g., the notes "delete" bug, the mode-switch chat pollution).
9. **Final step only, not before**: once every phase below is complete and verified, do the work described in **Phase L** — update `README.md`, `FEATURES.md`, and `CLAUDE.md` to reflect the actual current state of the app, then commit, push to GitHub, and rebuild the app (web + desktop/exe + CLI).
10. **Go beyond this list where warranted.** All three research passes were told to flag adjacent issues found while investigating even if not explicitly asked for (e.g., another hardcoded color found while auditing theming, a second silent catch found while checking a third). Treat every such "bonus" finding below as in-scope, not optional. If you find more of the same *pattern* while implementing a fix, fix those too and note them in the final `FEATURES.md`/changelog.

---

## 1. Orientation Map (merged, for your own reference before starting)

| Area | Owns | Key files |
|---|---|---|
| Backend | Express + `ws`, matcher/trigger engine, AI/Ollama integration, storage | `server/index.js` (boot orchestrator, ~443 lines), `server/state.js`, `server/wsHandlers/` (21+ leaf handlers), `server/routes/` |
| Frontend | React 19 + Vite 6 + Tailwind v4 (CSS-first tokens) + shadcn/Radix | `src/App.tsx`, `src/hooks/` (`useConsole.ts`, `useConsoleTabs.ts`, `useConsoleNavigation.ts`, `useConsolePolling.ts`, etc.), `src/components/` |
| Desktop shell | Electron 43, `electron-builder`, `electron-updater` | `desktop/main.cjs`, `desktop/package.json`, `desktop/scripts/stage-server.mjs`, `desktop/scripts/after-pack.cjs` |
| CLI | `npx` launcher | `bin/cli.js`, `server/cli-client.js` + `cliDiscovery/cliProjectPicker/cliRenderer` |
| Runtime data | Gitignored state | `data/` (`conversations/`, `learned-intents.json`, `schedules.json`, `notifications.json`, `user-profile.json`, `.cache/xenova`) |
| Per-project data | Gitignored, per project | `.console/` (`sessions/`, `chat-log.md`, `memory.md`, `notes.md`, `action-history.jsonl`, `code-index.json`) |
| AI/Ollama | Local + cloud model integration | `server/ollama.js`, `server/wsHandlers/aiStream.js`, `server/wsHandlers/aiQuery.js`, `server/ollamaContext.js`, `server/contextPruner.js`, `server/aiModePrompts.js` |
| Matcher/trigger engine | Intent detection (fuzzy/semantic/NLP/regex pins) | `server/matcher.js`, `server/preSemanticOverrides.js`, `server/semanticMatcher.js` + `semanticMatcherInit.js`, `server/intentRegistry.js`, `server/wsHandlers/builtin*.js` |
| Notes | | `server/notesStore.js`, `server/wsHandlers/builtinNotes.js`, `src/components/NotesPanel.tsx` |
| Reminders/schedules | | `server/schedules/scheduler.js`, `server/scheduleStore.js`, `server/reminderParser.js`, `server/wsHandlers/builtinReminders.js`, `src/components/RemindersPanel.tsx` |
| Tools/panels | | `server/toolPanelRegistry.js`, `server/tools.js`, `src/components/ToolsPanel.tsx` |
| File Explorer | | `src/components/FolderExplorerPanel.tsx` + `src/components/folderExplorer/`, `server/routes/browseRoutes.js` |
| Theming | | `src/index.css` (`:root` dark + `[data-theme=light]`), `src/hooks/useTheme.ts`, `src/App.tsx` accent override |
| Installer/updater | | `desktop/scripts/stage-server.mjs`, `desktop/main.cjs`, `server/updateChecker.js` |
| Guided tour | | `src/tours.ts`, `src/components/TourOverlay.tsx`, `src/App.tsx` |
| Notifications | | `server/notify.js`, `server/notify/notifyStore.js`, `server/notify/notifyChannels.js`, `server/watchEngine.js`, `server/notificationHistoryStore.js` |
| Auth/session | Attribution only, no real auth | `server/wsHandlers/connectionRoutes.js`, `server/wsHandlers/connectionLifecycle.js`, `server/routes/connectedUsersRoutes.js` |

---

## PHASE A — Console Chat Quality & AI Streaming
*(Maps to raw request items 1, 2, and part of 10.ii — "the console can cut off its thinking process")*

### A.0 What the user actually asked for
Audit historical chat logs from **both** the desktop (exe) app and the website. Read through real conversations end-to-end. Evaluate naturalness, length (too robotic/too long?), variation (repeating the same phrasing across different chats?), and correctness. Identify the exact code path that generates a response (system prompt, templates, post-processing). Exercise the console with new test messages across categories (factual, task requests, ambiguous, follow-ups) and record real responses. Catalog weak/stiff/repetitive/wrong responses with the trigger prompt, the responsible file/logic, and what a better response would look like. Separately: find and fix why the AI's "thinking" output can get cut off mid-stream before final response delivery.

### A.1 Consolidated Findings & Required Fixes

| # | Location | Problem | Fix |
|---|---|---|---|
| A-1 | `server/wsHandlers/aiStream.js:77-91` (esp. line 86-88), `server/ollama.js:283-304` | An **unterminated `<tool_call>` fragment at end-of-stream is silently dropped** — the code explicitly comments "we simply drop" it. User sees only pre-marker text with zero indication a tool call was attempted. Also: if `json.done` arrives while thinking text is still buffered, or the model batches thinking+content unusually, the reasoning trace appears truncated mid-sentence. Trailing `thinking` text inside an open `toolCallBuffer` is dropped at the same line. Confirmed in real historical chats (two named sessions in the research: "Matchday Exchange" 2026-08-14 and "NetPulse" 2026-08-17 both showed reasoning cut mid-sentence when tool calls followed). | Ensure thinking chunks are always fully flushed to the client before the content stream begins for that turn. On stream end, if `inToolCall` is still true or `buffer` holds an unterminated tool-call fragment, do **not** silently drop it — append a visible marker to `finalText` (e.g. "(tool call was interrupted — you can ask me to retry)") and log the raw fragment server-side for debugging. Add a regression test that forces a truncated stream and asserts the user-visible text contains an interruption notice, not silence. |
| A-2 | `server/ollama.js:294-299`, `server/wsHandlers/aiQuery.js:165-212,246` | Truncated NDJSON tail throws `"Ollama stream ended mid-line"` / `"truncated response"`, caught generically as `AI error:` — but partial `visible` text that already streamed to the user is **also** persisted via `finalText` at `aiQuery.js:246`, so the chat log ends up with a half-answer *and* a separate error bubble — two contradictory sources of truth. | On truncation, either (a) persist a single combined message: partial text + explicit "(response was cut off — retrying automatically)" and auto-retry once, or (b) strip the partial and show only the error. Pick (a) — auto-retry once, falling back to (b) if retry also fails. |
| A-3 | `server/wsHandlers/aiStream.js:77-80`, `src/hooks/wsMessageCases.ts:248-257`, `server/cliRenderer.js:342` | Thinking chunks are sent as `type:'thinking'`. The **web** client renders an italic status line. The **CLI** client does `case 'thinking': break` — i.e. discards it entirely. A 5-10s reasoning phase in the CLI looks exactly like a hang, with no "AI thinking…" indicator progressing. | Give the CLI a throttled `· thinking…` status line (updates at most every ~500ms so it doesn't spam the terminal), or add a `--verbose` flag that streams raw thinking text. Either way, the CLI must never look silently hung during a reasoning phase. |
| A-4 | `server/ollamaContext.js:14-141`, `server/contextPruner.js:43-90`, `server/promptRenderers.js:7-68` | System prompt caps: 6000 chars doc + 6000 repo map + 4000 memory + 16k history, with the middle of long conversations compressed to 3 bullets. Multi-tool-failure detail is lost in this compression, and `aiQuery.js:116-123`'s "stuck tool" note relies on the *current* (already-pruned) `toolHistory`, not the pruned-away suffix. Long real sessions (one observed `chat-log.md` was 1755 lines; sessions with 100+ messages exist) lose failure context and the model starts repeating itself or giving generically unhelpful answers because it's forgotten what already failed. | Preserve a standing "stuck tool / repeated failure" summary **outside** the normal pruning window so it survives compression regardless of conversation length. This directly targets the "repetitive/wrong response" complaint in long chats. |
| A-5 | `server/wsHandlers/connectionLifecycle.js:48-93` | Command-output buffer capped at 200k chars via tail-slice, flushed on `end`/`close` — but the `end.data` branch appends **unsliced**, bypassing the cap. A chatty dev server reloading repeatedly can lose early output and/or blow past the intended cap silently. | Apply the same 200k tail-slice to the `end.data` branch; add a "(output truncated at 200k chars)" notice when truncation occurs so the user knows data was cut, not lost to a bug. |
| A-6 | `server/conversationStore.js:169-291`, `server/sessionIndex.js:48-77` | An `AsyncLocalStorage` + `writeFileAtomic` fix (2026-08-17) resolved `messageCount` drift, but stale `*.tmp` files from the old code path are never garbage-collected (observed: ~20 leftover `.tmp` files under `data/conversations/`, 2 more under `.console/sessions/`). | Add a boot-time sweep that deletes orphaned `*.tmp` files older than some threshold (e.g. 1 hour) in both `data/conversations/` and every project's `.console/sessions/`; add `*.tmp` to the relevant `.gitignore`s if not already covered. |
| A-7 | `server/ollama.js:236-262`, `server/wsHandlers/aiQuery.js:55-71,172-212` | Idle watchdog aborts a stalled generation after 120s (`STREAM_IDLE_TIMEOUT_MS`), correctly distinguishing `AbortError`. But a zero-token stall persists **nothing** — `finalText` is empty, so no session entry is written at all, and the user has no record the request even happened. | On watchdog abort, persist whatever partial `visible` text exists with a "(response stalled and was aborted after 120s)" marker, even if that text is empty — write *something* to the session log so the conversation history isn't silently missing a turn. |
| A-8 | `server/matcher.js:71-96,205-211` | The question-guard (`QUESTION_BLOCKED_INTENTS` + `QUESTION_MARKER_RE`) correctly blocks trigger-word execution on questions like "why/when/did…" in **trigger mode**, but this guard does not apply once **AI mode** is on — AI mode can still execute gated tools on question-shaped input, and toggling AI mode mid-chat silently removes the guard with no user-facing indication. | Document this scope difference in the tour/help copy (see Phase C). Consider adding a lightweight warning in AI mode when the input closely matches a normally-blocked intent pattern, so the behavior difference is visible rather than surprising. |
| A-9 | `server/matcher.js:130-180` (root cause) surfacing through `server/intents/chitChatIntents.js:400-450`, `server/preSemanticOverrides.js`, `server/matcherMulti.js` | **Question-fires-action bug class**: the NLP/fuzzy/semantic matcher stages can dispatch *executing* intents (not just chit-chat) on question-shaped input. Concretely reproduced: "what is the site about" → matched deploy-confirm intent (deploy examples in `chitChatIntents.js:400-450` are saturated with "the site" phrasing, stealing genuinely read-only questions); "why isn't this working" → deploy; "did I push" → deploy. `matcherMulti.js`'s `matchMulti` also incorrectly splits a single-intent phrase like "commit and push" into two separate intents when one `git_commit_push` intent was expected. Some of this was patched piecemeal in a prior "Round 6" audit but the systemic gating gap in `matcher.js:130-180` remains: `isNlpBuiltinEligible` doesn't restrict itself to genuinely safe (non-executing) intents, and there's no `QUESTION_BLOCKED_INTENTS`-equivalent guard specifically for the fuzzy/semantic/NLP stages (only the regex-pin stage has the strong guard per A-8). | This is the **highest-priority Phase A fix**. (1) Remove "the site"-only phrasings from deploy chit-chat examples so genuine read-only questions don't route into deploy. (2) Extend the question-guard concept from `matcher.js:71-96` so it also restricts which intents the fuzzy/semantic/NLP stages are allowed to *execute* (not just suggest) when the input is question-shaped — i.e. `isNlpBuiltinEligible` should exclude mutating/deploy-class intents on question-shaped input across all matching stages, not just the regex-pin stage. (3) In `matchMulti`, add a whole-phrase guard: if a single semantic match scores ≥0.75 against a non-chit-chat intent, don't split the phrase into two intents — treat it as one. |
| A-10 | `server/preSemanticOverrides.js` (471 lines, 60+ regex pins) | Missing pins identified during cross-checking: typo'd time/state questions, bare "commit" with no object, frustration-toned input ("why isn't this working", "ugh nothing works") routing into executing intents instead of chit-chat/support framing. | Add the missing pins found during the audit (typo'd time questions, bare commit, frustration phrasing) to `preSemanticOverrides.js`, following the existing pin format. Because this file is large and hand-tuned (see Phase B for the modularity concern), add new pins as **data-file entries** if the Phase B refactor of this file to a data table + generated tests has already landed by the time you do this; otherwise add them as regex pins in the existing format and flag for the Phase B refactor to pick up later. |
| A-11 | `server/wsHandlers/builtinFileNpm.js` (`findTestCommand`) | Reads a cached/truncated `package.json` (2000-char cap) to locate the `npm test` script — on this very project's own `package.json`, the test script lives past the 2000-char mark and is missed. | Add a disk-read fallback: if the cached/truncated read doesn't find a `scripts.test` entry, re-read the file from disk in full (bounded by a much larger cap, e.g. 20000 chars) before giving up. |
| A-12 | `server/consoleCommandDocs.js` | No catalog entry exists for a set of very ordinary questions users will actually ask: "what's up"/"what's your name" (falls back to generic chit-chat, no dedicated intent), "what version am I running", "what is AI mode vs trigger mode", "is my data safe", and short acks like "lol"/"haha" (only "ok" was added as an ack intent on 2026-09-03; "lol"/"haha" still fall through to generic fallback). | Add dedicated catalog entries + example phrasings for: app version query, AI-mode-vs-trigger-mode explainer, "is my data safe" (answer honestly per the LAN-exposure findings in Phase I), and broaden the acknowledgment intent to cover "lol"/"haha"/"nice"/"cool" etc. |
| A-13 | `server/memoryStore.js:81-86` vs `server/notesStore.js:36-54`, `server/ollamaContext.js:53-59` | Two `.console/` markdown stores exist with **opposite durability semantics**: `memory.md` (written via AI `saveMemory`, injected into every prompt, capped 4000 chars) vs `notes.md` (written via user `note: ...`, never injected into AI context unless the AI explicitly calls `readFile`). `crossProjectMemory.js` searches all projects' `memory.md` but never `notes.md`. A user who types "note: buy milk" reasonably expects the AI to "know" that later — it won't. | Add a lightweight nudge: when a user says something like "remember that …", suggest (via the console's own response, not a hardcoded string duplicated elsewhere) that they can choose between a durable AI memory (`saveMemory`) and a plain note (`note:`), briefly explaining the difference in behavior. |
| A-14 | Response naturalness/variation audit (raw request items 1 & 2) | Canned chit-chat handlers (~22 in `server/wsHandlers/builtinChitChat.js`, ~523 lines) use fixed templates — e.g. greeting always follows the same "time-of-day + live-state + memory" structure regardless of how many times the same user has been greeted that day. Variation currently depends entirely on Ollama's own stochasticity for AI-mode replies; trigger-mode canned replies have **no** variation at all — same input always produces byte-identical output. `aiModePrompts.js` defines only 6 modes (`default/coding/tutor/creative/consultant/structured`) — there is no `reason` or `deep-research` mode despite the UI exposing "Reason" and "Deep Research" toggles (see Phase F for the UI-side of this bug). | (1) For the highest-frequency canned trigger-mode responses (greeting, status, ack, and any other intent that fires many times per session), add 2-4 paraphrase variants selected round-robin or randomly, so repeat users don't see identical text every time. (2) Either implement real `reason` and `deep-research` prompt modes in `aiModePrompts.js` (e.g., `reason` = higher `num_predict` + explicit step-by-step instruction; `deep-research` = wired to the actual `server/webSearch.js` deep-research path) or rename the UI toggles so they don't imply a model-depth change that doesn't exist. Prefer implementing the real modes over renaming, since deeper reasoning is clearly what the user wants (see raw item 10.ii: "when I ask Ollama something, the console can cut off its thinking process"). (3) As part of this same pass, **do the live testing the user asked for**: send a representative range of new test messages (factual, task requests, ambiguous phrasing, follow-ups, frustration-toned, typo'd) through the running console, record the actual responses, and confirm each of the fixes above actually changes the output for the better. Keep this test transcript as part of your working notes for Phase L's changelog. |

---

## PHASE B — Code Quality & Architecture
*(Maps to raw request items 3, 4, 7 — professional code, modularity, no hardcoding)*

### B.0 What the user asked for
Every line of code should look professional and deliberately authored — not vibe-coded, not obviously AI-written. All files should be modular. Nothing should be hardcoded; everything should be customizable for other users since this app is being shipped externally.

### B.1 Oversized files requiring split (repo's own ceiling is ~400 lines per `AGENTS.md:79`)

Confirmed over the line-count ceiling (measured directly): `server/checkHandlerCoverage.js` (1103), `server/matcherBatteries.js` (830), `src/App.tsx` (584 — documented exception, re-verify it's still justified before leaving as-is), `src/components/FolderExplorerPanel.tsx` (569), `src/tours.ts` (499), `server/wsHandlers/builtinChitChat.js` (523), `src/components/CommandDeck.tsx` (486), `server/preSemanticOverrides.js` (471), `server/wsHandlers/builtinGeneralFiles.js` (492), `src/components/NotificationsPanel.tsx` (466), `src/components/UserProfileModal.tsx` (504), `src/components/RemindersPanel.tsx` (438), `src/hooks/useConsole.ts` (452, described elsewhere as a "389-line god hook" pre-refactor and 431-452 lines post — regardless of exact count it owns too much: all state + 20+ WS/fetch handlers), `server/index.js` (443), `server/cli-client.js` (414), `server/matcher.js` (429 as an orchestrator over 12 leaf modules, still doing too much), `server/executor.js` (359-430 depending on count, split into 5 leaves already but orchestrator still oversized), `src/components/Terminal.tsx` (~454-520 depending on count).

**Required work per file:**
- `server/index.js`: extract boot phases into `server/boot/` leaves (e.g. `bootstrap/scan.js`, `bootstrap/matcher.js`, `bootstrap/scheduler.js`, `bootstrap/portBinder.js`) — the file already documents itself as "thin orchestrator only" at its own header, so bring the actual line count in line with that stated intent.
- `server/preSemanticOverrides.js`: extract the 60+ regex pins into a data file (e.g. `server/data/semanticOverridePins.json` or `.js` data module) with generated/table-driven tests, rather than 5-10 line hand-written comment blocks per pin. This directly supports the A-10 fix above (new pins become data entries, not more inline code).
- `server/wsHandlers/builtinGeneralFiles.js`: split by domain — find / tidy / duplicates / rename / move each get their own file.
- `server/wsHandlers/builtinChitChat.js`: split `how_do_i` (currently ~48 lines with its own regex) and other large handler groups into `chitChat/howDoI.js` etc.
- `src/hooks/useConsole.ts`: split into `useConsoleState.ts` (state only), `useConsoleWs.ts` (WebSocket wiring), `useConsoleActions.ts` (send/execute handlers).
- `src/components/FolderExplorerPanel.tsx`: continue the existing `folderExplorer/` split pattern (`header.tsx`, `views.tsx`, `menus.tsx` already exist) — move remaining inline logic out of the 569-line root file into those leaves.
- `src/tours.ts`: this one is mostly *data* (step definitions), not logic — acceptable to leave long, but confirm no executable logic beyond step data belongs in a separate `tourEngine.ts`.
- Every other file in the oversized list: apply the same "split by responsibility" treatment, matching the style of splits already done elsewhere in the codebase (e.g. `server/executor.js`'s existing 5-leaf split, or `folderExplorer/`'s existing pattern) so the result looks consistent with the rest of the repo, not like a one-off.

### B.2 Duplicated logic to consolidate

| Duplication | Locations | Fix |
|---|---|---|
| `console.config.json` read + `sanitizeChatReplies` + `isRecognizableByCodeAlone`/`buildFallbackConfig`/`detectWorkspaceType` sequence | `server/projectScanSingle.js:18-26,47-49` and `server/projectScanContainer.js:88-96,152-154,163` — verbatim duplicated 6-step sequence, including an identical silent empty `catch(err){}` in both (see Phase K) | Extract a shared `readProjectConfig(projectPath)` / orchestration helper used by both; this also fixes the duplicated silent-catch bug in one place instead of two. |
| `answer` WS-reply helper | Re-declared independently in 60+ `server/wsHandlers/*.js` files (e.g. `builtinNotes.js:15`, `builtinPdfTools.js:17`, `builtinCsvTools.js:15`) with inconsistent error-shape conventions between handlers | Extract a single shared `wsReply.js` utility; standardize the error-response shape across all handlers as part of the same change. |
| Panel polling scaffold (`POLL_MS = 15000` + `lastSentTimer` + `setInterval` + `setTimeout(...,8000)`) | Copy-pasted verbatim across 9 panels: `BackupPanel.tsx:28`, `FileToolsPanel.tsx`, `NotesPanel.tsx:33`, `NotificationsPanel.tsx:52`, `ClipboardPanel.tsx:23`, `PdfToolsPanel.tsx:28`, `Dashboard.tsx:81`, `useConsolePolling.ts:57`, and one more | Extract a shared `usePanelPolling()` hook that takes the fetch function and interval as arguments. |
| Port probing | `bin/cli.js:66` `probeRunningPort()`, `desktop/main.cjs:244` `probePort()`, `server/livenessProbe.js` — three separate implementations with **different timeouts** (desktop 1500ms, CLI 5000ms, daemon 5000ms) and different response-shape checks (desktop only checks HTTP 200, CLI checks response shape) | Consolidate into one shared probe function with one canonical timeout and one canonical "is this actually our server" shape check, imported everywhere. Where CommonJS/ESM boundaries genuinely prevent a shared import (documented reason: `desktop/main.cjs` is CJS and can't synchronously import the ESM `server/portConfig.js`), keep the values in sync by importing the *values* (not full modules) via a build step or by duplicating only the numeric constants with an inline comment pointing at the source of truth — but the current 5s/1.5s/90s mismatch (see D-5 below) must be resolved regardless of import mechanics. |
| `sanitizeChatReplies` / `ensureConsoleConfigGitignored` / `ensureGitignored` | Called independently in `projectScanSingle.js`, `projectScanContainer.js`, `projectScanHelpers.js`, and separately imported from `conversationStore.js` into `notesStore.js`, `memoryStore.js`, `actionHistory.js` | Confirm a single shared implementation is used everywhere (looks like `ensureGitignored` already is shared — verify `sanitizeChatReplies` is too, and consolidate if not). |
| `server/wsHandlers/connection.js` (14-16 lines) | Pure re-export shim wrapping `initWebSocketServer` from `connectionLifecycle.js`, kept only to preserve an existing import path in `server/index.js:28` | Either inline the import directly in `server/index.js` (removing the shim) or, if the indirection is intentionally preserved for a reason not yet documented, add a one-line comment explaining why and leave it — don't leave an undocumented no-op file. |

### B.3 Hardcoded values to make configurable

Every value below should move into the existing configurable surfaces (`server/tuningStore.js` for backend tunables, `data/user-profile.json` for user-facing preferences, `src/index.css` tokens for anything visual, or a new `config/apiEndpoints.js` for external endpoints) rather than staying as inline literals:

| Value | Location(s) | Target |
|---|---|---|
| `COMMON_DEV_PORTS = [3000,5173,5000,8000,8001,8080,4400,8888]` | `server/livenessProbe.js:23` (inline array, not exported) | `tuningStore` or `data/config` |
| UI poll intervals `4000/5000/6000/10000/15000` repeated inline | `BackupPanel.tsx:28`, `ClipboardPanel.tsx:23`, `PdfToolsPanel.tsx:28`, `Dashboard.tsx:81`, `useConsolePolling.ts:57`, `NotificationsPanel.tsx:52` vs `App.tsx:133` (duplicate polling at two different intervals for the same data — also a Phase E bug) | `tuningStore` or `src/constants.ts` |
| External endpoints: `https://html.duckduckgo.com/html/?q=`, `http://localhost:11434`, `https://registry.npmjs.org/${pkg.name}/latest` (appears twice) | `server/webSearch.js:33`, `server/ollama.js:5`, `server/updateChecker.js:79` | `config/apiEndpoints.js`, env-overridable (Ollama's host is already env-overridable — extend the same pattern to the others) |
| `NUM_CTX = 16384` | `server/ollama.js:14` | User-facing setting (advanced) |
| `STREAM_IDLE_TIMEOUT_MS = 120000` | `server/ollama.js:218` | `tuningStore` knob |
| `MAX_TOOL_ROUNDS = 6` | `server/wsHandlers/aiQueryToolRun.js` | `tuningStore` knob |
| `MAX_ENTRIES = 200` (notes/memory caps) | `server/memoryStore.js:12`, `server/notesStore.js:13` | Per-project setting |
| `CLIPBOARD_POLL_MS` | `server/clipboardHistory.js` | Profile setting |
| Toast duration `8000ms` | `src/components/ui/toastStore.ts`, `RemindersPanel.tsx` | User preference |
| Scan ignore dirs | `server/codebaseData.js` `IGNORE_DIRS` | Config file, user-editable |
| Default model name (e.g. `qwen2.5-coder:7b`) | `src/hooks/useAI.ts:18` | Profile setting |
| `MAX_REPO_MAP_FILES=150`, `MAX_FILE_READ_BYTES=20000`, `MAX_BACKUP_BYTES` (50MB), `MAX_ACTIONS=2000`, `MAX_ENTRIES=25` and similar caps outside the current `tuningStore` allowlist | `server/codebaseData.js:60-64`, `server/backupStore.js:22`, `server/actionHistory.js:24`, `server/clipboardHistory.js:14`, etc. | Add to `tuningStore` allowlist where user-tunable makes sense; otherwise document as intentional internal limits |
| One remaining hardcoded tour-spotlight shadow color and a handful of stray hex literals | See full list in Phase G | Theme tokens |

**Positive pattern to replicate** (do not change, just follow the same approach elsewhere): `server/portConfig.js` (`BASE_PORT`, `MAX_PORT_ATTEMPTS=20`, `HOST`, `OLLAMA_DEFAULT_HOST` — centralized, env-overridable) and `server/tuningStore.js` (11 knobs with `BOUNDS` + REST endpoints for get/set/delete) are the exemplars for this whole phase.

### B.4 "Vibe-coded" / AI-generated smell audit

- **Over-explained comments**: e.g. a 22-line comment in `server/ollama.js:126-148` explaining Ollama Cloud catalog drift. Where a comment this long is genuinely necessary (non-obvious historical bug context), keep it but tighten to the essential "why", not a narrated walkthrough. Where it's explaining something a competent engineer wouldn't need explained, cut it.
- **Generic/inconsistent naming**: `server/matcher.js` uses `stage`, `pass`, `floor`, `margin` inconsistently across its 6 matching stages — pick one consistent vocabulary and rename throughout.
- **Copy-pasted boilerplate**: the `answer` helper problem above (B.2) is the main instance.
- **Inconsistent error handling style**: `server/executor.js` vs `server/tools.js` — some paths use try/catch with structured error objects, others throw raw strings. Standardize on structured error objects everywhere (this also fixes several Phase K findings about unhelpful generic error strings).
- **Unnecessary abstraction**: the `server/wsHandlers/connection.js` shim (B.2) and `server/asyncHandler.js` (a wrapper that just calls `fn(req,res,next).catch(next)` — flag as obsolete once/if the Express major version in use natively supports async error handling; check the actual Express version in `package.json` before removing, don't assume).
- **Confirmed clean**: zero real `TODO/FIXME/HACK/XXX/stub` debt — the only grep hits across the codebase are the `TODO_RE` scanning *feature* itself (`server/codebaseData.js`, `server/codebaseScans.js`) and a reminder-parser comment about dateless TODOs, not actual unfinished code. No action needed here — do not go looking for shortcuts that don't exist.
- **Unused/dead files to verify and remove or wire up**: `server/mockProjects.js` (seeds fake projects on non-Windows, apparently never used in production — confirm and remove if genuinely dead), `server/clipboardHistory.js`'s macOS/Linux paths (`pbpaste`/`xclip`) are implemented but apparently untested — either add a smoke test for those platforms or clearly flag them as unverified in a comment.

---

## PHASE C — Guided Tour & Onboarding
*(Maps to raw request item 5)*

### C.0 What the user asked for
The "take a tour" function needs to be more immersive and actually highlight the different sections it's referring to. Identify other flows that need guides too.

### C.1 What's already working (do not regress)
The core spotlight mechanism is well-built and should be preserved as the pattern for everything else in this phase: `src/components/TourOverlay.tsx` does `querySelector('[data-tour="..."]')` → `scrollIntoView({block:'center'})` → `getBoundingClientRect()` → renders a real spotlight ring around the actual element, re-measuring on resize/scroll, with a retry loop for lazily-mounted panels. `src/tours.ts` defines 10 sections / ~50 steps across 3 groups (`orient/work/power`), two display modes (`card` modal vs `guided` spotlight), auto-opens once for new users via `localStorage['console.welcomed']`, and tracks completion per-section via `localStorage['console.toursTaken']`. This already matches or exceeds the spotlight pattern used by VS Code's walkthroughs and Raycast's onboarding (spotlight + sequencing + skip/replay). **Do not rebuild this system — extend it.**

### C.2 Required fixes

| # | Issue | Fix |
|---|---|---|
| C-1 | **Missing `data-tour` targets** — cross-referencing `tours.ts` step targets against actual components found that a meaningful fraction of panel targets don't exist in the DOM (`folder-explorer-panel`, `file-tools-panel`, `repo-map-panel`, `knowledge-base-panel`, `notes-panel`, `pdf-tools-panel`, `csv-tools-panel`, `clipboard-panel`, `backup-panel` were named as missing in one pass's cross-check — verify this list against current code since panel components may have been renamed since; some of these may already exist under different attribute names). When a target is missing, guided mode silently falls back to a generic card instead of spotlighting anything. | Re-run the cross-check (`grep -r data-tour src/components` vs every `target:` value in `tours.ts`) and add the missing `data-tour="..."` attribute to every panel's root element so every tour step that names a target can actually find it. |
| C-2 | **View mismatch**: the `discovery` section's `bento-grid` step targets an element that only mounts on the Welcome screen, but the guided-mode view-switch handler can route to chat instead of welcome for this step, so the spotlight ring misses. | Fix the view-switch mapping so `bento-grid` (and any similarly-scoped step) explicitly requests the `welcome` view, or gate the step so it only appears when that view is reachable. |
| C-3 | **~12 steps have no real `target`** and show generic text only (e.g. the welcome intro, "tabs: Opening Is Locking", and a `developer` section that spotlights the same `chat-input` target for 3 consecutive steps — imprecise, since the ring never moves). | Add distinct, real targets per step — e.g. differentiate the developer-mode steps by spotlighting `header-pill` for the mode indicator, then the actual input for the chat step, rather than reusing one target three times. |
| C-4 | **Untoured flows** (confirmed gaps, consolidate across all three passes): the **marketplace/pack-registry panel has zero tour steps at all**; the AI model picker dropdown and the `permissionMode: ask` toggle are never spotlighted; `header-pill` is described in step text but never actually gets a ring; the Dashboard's Projects-vs-Live sub-tabs and the dock's Logs/Projects/History tabs aren't drilled into; notifications, watch-rules, auto-start, and schedules each get one throwaway sentence instead of a real walkthrough; the `scanAllFolders` toggle is invisible to the tour; Settings' 6 categories are summarized in a single step instead of being toured individually; the `FirstRunSetup` wizard (4 fields) has no spotlight at all. Also: **CLI, daemon, and desktop (`--cli` mode) flows have zero tour coverage** — the tour system is web-only. | Add tour sections/steps for: marketplace/pack registry (currently zero coverage — highest priority in this list), AI model picker + `permissionMode`, header-pill (give it an actual target), Dashboard sub-tabs, notifications/watch-rules/schedules (expand from one sentence to a real multi-step walkthrough matching the depth given to other panels), `scanAllFolders`, per-category Settings walkthroughs, and `FirstRunSetup`. For CLI/daemon/desktop: add either a dedicated `cli-and-desktop` tour section (if the CLI can render any equivalent of a spotlight — likely not, so this may instead be a well-written first-run text walkthrough printed to the terminal) or, at minimum, a clearly signposted "how do I use the CLI" doc surfaced from Settings. |
| C-5 | **Reference research** (already done, use as design input — do not re-research): VS Code's `WalkthroughView`, Raycast's spotlight onboarding, and Linear's checklist-based onboarding all combine spotlight/ring + step sequencing + skip/replay — which this app already has — but additionally offer a **progress scrubber**, **auto-advance on the user actually performing the action** (not just "next" button clicks), a **reduced-motion alternative**, and (for VS Code specifically) **checklist checkmarks** for completed setup steps. | Add: a step-progress indicator (e.g. "Step 3 of 8") if not already present, auto-advance when the tour can detect the user performed the demonstrated action (where feasible — don't force this everywhere), a `prefers-reduced-motion`-respecting non-animated fallback for the spotlight transition, and consider VS Code-style checklist checkmarks for the first-run setup flow specifically. |

---

## PHASE D — Performance & Latency
*(Maps to raw request item 6 in full — this is the user's stated #1 concern alongside Phase A)*

### D.0 What the user asked for
Latency needs to drop severely. Specifically: (a) opening a new tab for a different file path keeps showing the old tab's content while the new path is still loading/scanning; (b) app load takes over a minute and can still error with "couldn't find a port" or similar even though the app is being shipped to other users; (c) the CLI bundled with the exe is still crashing.

### D.1 Consolidated Findings & Required Fixes

| # | Location | Problem | Fix |
|---|---|---|---|
| D-1 | `src/hooks/useConsolePolling.ts` (mount effect), `src/hooks/useConsoleTabs.ts` (`restoreTabs`, `activateTab`), `src/hooks/useConsoleNavigation.ts` | **This is the exact bug the user described.** Tab switch is implemented so the previous tab's `messages`/project list intentionally stays visible until the new tab's data lands — there's an explicit code comment defending this as a tradeoff ("clearing it up front made every tab switch flash empty — brief stale view is strictly better"). The `isTabSwitchingRef` guard only protects the toolbar, not the chat/project content itself, so there is currently **no loading indicator at all** during this window — the user sees the *old* path's content with nothing telling them a new load is in progress, which reads as "it opened the wrong tab" or "it's stuck," not "it's loading." | Keep the "don't flash empty" instinct (it's directionally correct) but replace "silently keep stale content with zero indication" with an explicit, visible per-tab loading state: a subtle skeleton/pulse over the stale content (the header already has a pulse pattern for "Indexing…" — reuse that visual language) so it's clear to the user that what they're looking at is stale and a fresh load is in flight, not that the click didn't register. |
| D-2 | `src/hooks/useConsoleTabs.ts` (`activateTab`), `src/hooks/useProjects.ts`, `server/routes/projectRoutes.js`, `server/scanCache.js`, `server/codebaseIndexer.js` | `activateTab` blocks on `GET /api/projects?tab=<id>`. A cache hit (TTL ~8000ms) resolves in tens of milliseconds, but a cache miss re-indexes the **entire container** via full TypeScript AST parsing per file (pooled at concurrency 6, capped at 150 files for the repo map) — observed taking multiple seconds for a 15-project container scan. | Pre-warm the cache proactively (e.g. kick off a background re-scan slightly before the TTL expires rather than waiting for a miss) and use a stale-while-revalidate pattern: serve the cached result immediately while refreshing in the background, only blocking the UI on a true cold cache with no prior data at all. |
| D-3 | `src/hooks/useConsoleTabs.ts` (`duplicateTab`, `openWorkspaceTab`, `restoreTabs`), `server/routes/projectRoutes.js` | **New-tab creation always cold-scans**, even when duplicating a tab pointed at the exact same folder — `scanNewPath` calls `discoverProjects(effectivePath)` unconditionally with **no check against the existing cache** (`getCachedScan`) first. Restoring 5 saved tabs on boot does check-per-tab in parallel now, but each tab with a distinct root still walks the filesystem independently — 5 tabs × 15 projects each = 5× the necessary work. | Before calling `discoverProjects`, check `getCachedScan` for the target path; only fall through to a real scan on a genuine miss. When duplicating a tab whose root matches an already-open tab, reuse that tab's already-fetched project list instead of re-scanning at all. |
| D-4 | `server/semanticMatcherInit.js`, `server/semanticMatcher.js`, `server/index.js` boot sequence | **This is the single largest boot-time cost, measured directly from server logs**: of a ~41-48 second cold boot, roughly 35 seconds is the embedding batch step alone — computing embeddings for ~3040 intent phrases at roughly 11ms/phrase under a concurrency-8 mutex. On top of that, the **first** boot on a packaged install must download the ~23MB `Xenova/all-MiniLM-L6-v2` model weights, which are **not** pre-staged by the installer (`stage-server.mjs` deliberately stages an empty `data/` directory for a clean fresh-install guarantee, so `.cache/xenova` isn't included). There is currently **no persisted cache of the computed intent vectors themselves** (only the model weights get cached, not the resulting embeddings) — so this ~35 second cost is paid **on every single restart**, not just first boot. | (1) **Persist the computed `intentVectors` to disk** (e.g. `data/.cache/intent-vectors.json` keyed by a hash of the phrase list + model version) and load them on subsequent boots instead of recomputing — this alone should eliminate the vast majority of the 35-second cost on every boot after the first. (2) Consider lazy-loading **per-project** intent embeddings (the ~100 project-specific phrases) rather than blocking boot on them. (3) For the model-weights download specifically: either bundle the ~23MB weights in the installer (small size cost, large first-run UX win) or show real download progress in the loading screen (see Phase H) so a slow connection doesn't look like a hang. |
| D-5 | `server/index.js` (port-binding loop), `server/portConfig.js`, `bin/cli.js`, `desktop/main.cjs` | The **actual** "no free port" error text is `"No free port between 3000 and 3019 — every port in range is in use…"` — this is a real, correctly-worded error for a genuine port exhaustion case, not the bug. The **real bug** is a **timeout mismatch**: the server can take ~41-48+ seconds to actually bind (see D-4), but `bin/cli.js` only polls for up to 30 seconds before reporting `"Server failed to bind within 30s"`, and the desktop shell's `waitForServer` probes only the base port for up to 90 seconds before falling back to scanning the full 3000-3019 range — wasting time in the wrong order when the bound port is, say, 3005. Per-port abort timeouts also differ across the three launch paths (desktop 1500ms, CLI 5000ms, daemon 5000ms), and desktop's `waitForServer` returns a **boolean**, not the actual bound port, so `openConsole` may assume `BASE_PORT` even when a fallback port was actually used. | (1) Raise the CLI's bind-wait timeout to comfortably exceed worst-case cold boot (accounting for the D-4 fix reducing this — but set the timeout generously, e.g. 90-120s, rather than optimistically tight). (2) Make `waitForServer` scan the **full** port range on every poll cycle from the start, rather than checking only the base port first and falling back to a range scan later. (3) Return the **actual bound port** from `waitForServer`, not a boolean, and have `openConsole` use that returned value instead of assuming `BASE_PORT`. (4) Unify the per-port probe timeout across CLI/desktop/daemon to one value. |
| D-6 | `server/logger.js`, `server/fileLogger.js`, `desktop/main.cjs` (crash handlers), `server/index.js` (global handlers) | Crash-log infrastructure is actually solid and should be preserved: `desktop-crash.log` under the OS user-data directory for Electron main-process crashes, `server.log`/`server.err.log` with size-capped rotation for the server process, a `serverStderrTail` buffer surfaced in the fatal-error UI. Confirmed CLI crash root causes from history (already fixed, verify they stay fixed): a static top-level `import vite` in production code causing `ERR_MODULE_NOT_FOUND` (fixed via dynamic import), and `pdf-parse` evaluating `new DOMMatrix()` at module scope without a canvas polyfill (fixed via lazy import). | Confirm both historical fixes are still in place (re-check `server/index.js`'s vite import is still dynamic, and `server/pdfKit.js`'s DOMMatrix-dependent import is still lazy/guarded) — regression-test both explicitly since the user reports the CLI "is still crashing" as of writing this prompt, meaning either these fixes regressed or a **new** crash cause exists. Actually run the packaged CLI (`Project Console.exe --cli` or equivalent) end-to-end and capture any crash that occurs; if the two known historical causes are confirmed still fixed, treat this as a **new bug** and root-cause it fresh rather than assuming it's already covered. |
| D-7 | `src/hooks/useConsole.ts`, all mutating panel components (`PdfToolsPanel`, `FileToolsPanel`, `NotesPanel`, `RemindersPanel`, `FolderExplorerPanel`, `Dashboard`, etc.) | Every mutating panel action currently composes a natural-language trigger phrase and sends it through the **full chat pipeline** (`onSendMessage` → 5-slot FIFO send queue → WebSocket `execute` message → matcher → confirm-gating → journal/undo) instead of calling a direct REST endpoint — this is both the biggest latency tax in the app and the direct cause of raw request item 10.ii's chat-pollution complaint. Read-only panel actions (list/search) are already correctly direct `GET` calls. The Calculator panel is already correctly a direct `POST /api/calculate` with no chat round-trip — **use it as the reference pattern**. One panel (Spreadsheet) does a confusing dual-write: direct fetch for the table data but a chat-phrase send purely to create a journal entry — this split behavior should be resolved one way or the other. | This is the **single most impactful latency fix in the whole prompt** — implement it thoroughly, not partially: (1) Add direct REST endpoints for every currently-chat-routed mutation identified in the research: add-note, delete-note, search-notes, create-reminder, complete-reminder, delete-reminder, tidy-files, merge/split/watermark-PDF, open-with, mode-switch (see Phase F/E for the mode-switch-specific fix), and any other tool-panel action that mutates state. (2) Preserve the **confirm-gating and undo/journal guarantees** the chat pipeline currently provides — the REST endpoints must still write to the same journal (`action-history.jsonl`) and support the same undo mechanism, just without the WebSocket/matcher round-trip. Do not silently drop the safety net while removing the latency. (3) Keep the chat pipeline available as a fallback path for the CLI and for natural-language phrasing (see D-8 below) — this is additive, not a replacement of chat-based control entirely. (4) Resolve the Spreadsheet panel's dual-write inconsistency by using the same direct-REST-plus-journal pattern as everything else. |
| D-8 | Raw request item 10.ii, direct quote: *"I should be able to type add reminder to... and it works."* | Distinct from D-7: the user also explicitly wants **typed natural-language shorthand inside the console input** (not clicking a panel button) to resolve to a fast direct action, without needing a full AI round-trip. Confirm whether this currently works via the existing matcher/trigger system (it likely already does for well-known phrasings like "remind me to…") or whether it only works through the full chat/LLM path for less-common phrasings. | Verify "add reminder to X" and equivalent natural phrasings for notes/reminders resolve through the fast trigger-matcher path (`server/matcher.js`), not a full LLM round-trip, for all the common phrasings a user would realistically type. Where a common phrasing isn't currently recognized by the matcher, add it (this overlaps with the A-10/A-9 matcher work — do them together). |

---

## PHASE E — Notifications & Background Actions
*(Maps to raw request items 10.ii ("notifications up top" / "notification popup") and the "app notifications still don't send" note)*

### E.0 What the user asked for
Mode-switch confirmations and similar routine executions (adding a note, completing a tool run, etc.) should **not** be sent as chat messages — they should appear as a top-of-app notification line instead. The user should be able to control notification verbosity in Settings. Windows notifications (e.g. for a set alarm) currently don't arrive at all. The notification bell/icon should open its own popup, not route through the tools/chat system.

### E.1 Consolidated Findings & Required Fixes

| # | Location | Problem | Fix |
|---|---|---|---|
| E-1 | `server/notify/notifyChannels.js` (PowerShell WinRT toast call), `desktop/main.cjs` (`app.setAppUserModelId`) | **Root cause of "I set an alarm and get no Windows notification."** Two compounding bugs: (a) the PowerShell WinRT call **always resolves `{ok:true}` on process close, regardless of exit code** — it only reports failure if the `spawn` call itself fails to start, meaning a toast that Windows silently discards (e.g. because no `AppUserModelID` is registered) still reports success back to the app. (b) `app.setAppUserModelId('local-project-console')` is only called from the packaged Electron main process — running via `npm run dev`, `npx`, or any non-packaged path **never registers an AUMID at all**, so `CreateToastNotifier` has no registered identity for Windows to attach the toast to, and it's silently dropped. There is also a naming mismatch worth reconciling: the WinRT identifier string (`'local-project-console'`) does not match the `electron-builder` `appId` (`com.localprojectconsole.app`) — confirm whether this mismatch itself contributes to toasts not binding correctly on Windows 11, or whether it's cosmetic; align them regardless since a mismatch here is a footgun either way. | (1) Make the PowerShell wrapper actually check and propagate the process's exit code / any WinRT exception output, instead of unconditionally resolving `ok:true`. (2) Register the AppUserModelID in **all** launch paths, not just the packaged Electron path — dev mode and any other entry point that can send a Windows toast needs the same registration before attempting to send one. (3) Align the WinRT identifier string and the `electron-builder` `appId` to the same value. (4) Add a "Send test notification" action in Settings that surfaces the *real* success/failure result (post-fix) so the user has a way to confirm the fix actually works on their machine, not just trust that it does. |
| E-2 | `server/schedules/scheduleFire.js` (`deliverReminder`), `server/notify.js`, `src/hooks/wsMessageCases.ts` | Reminder delivery already correctly fans out to multiple channels (in-app toast via WS `notification_fired`, OS toast via `notify()`, and a markdown log fallback) — the in-app toast path is solid; the OS-toast leg is the only unreliable one (covered by E-1). No snooze action exists on the reminder toast/notification. | Once E-1 is fixed, verify the full fan-out actually surfaces the OS toast. Separately, add a "Snooze" action to the reminder notification (both the in-app toast and, where the OS notification API supports action buttons, the OS toast too). |
| E-3 | `server/notify/notifyStore.js`, `server/notify.js`, `server/notify/notifyEvents.js` | Most notification event types default to **OFF** except `reminder-fired` — `dev-server-crash`, `schedule-find`, `task-done`, `collision-found`, `file-changed`/`file-added`/`folder-stale` all require the user to discover and manually opt in via a chat command (`notify me when <event>`). A toggle UI exists in the Notifications panel, but discoverability is low since most users will never find it. | Don't necessarily flip every default to "on" (that risks notification fatigue), but surface these opt-in toggles more prominently — e.g. a one-time prompt the first time a watch-rule or task is created, offering to enable the relevant notification, and make sure the tour (Phase C-4) actually walks through this panel instead of summarizing it in one sentence. |
| E-4 | `src/components/AppHeader.tsx`, `src/App.tsx`, `src/components/NotificationsPanel.tsx` | **This is exactly the bug the user described.** The bell icon currently opens the Notifications view as an entry inside the Tools panel grid — not a standalone popup. Additionally the unread badge is cleared **locally only** when opened (no corresponding `POST /api/notifications/dismiss`), so it can resurface on the next poll; and there are two separate polling intervals for the same notification data at two different frequencies (10s in the panel, 15s in the header badge) which is itself wasteful and can produce visibly inconsistent badge counts. No snooze, no quiet-hours, and only a binary on/off per event type (no verbosity levels). | Replace the Tools-panel-grid entry with a real anchored popup/popover component that opens directly from the bell click — matching what the user explicitly asked for ("Notification should not be a tool but should be its own popup when I click the icon"). Fix the badge-dismiss to actually call the dismiss endpoint, not just clear local state. Unify the two polling intervals into one. Add per-event verbosity if feasible (at minimum keep the binary toggle, but consider "all / errors only / none" tiers), and add a quiet-hours setting alongside the existing reminder-toast-duration/position settings already in the profile. |
| E-5 | `server/wsHandlers/connectionModeAdmin.js`, `src/App.tsx` (mode-switch handler), `src/hooks/wsMessageCases.ts` | **This is exactly the bug the user described**: switching between General and Developer mode currently sends a visible chat `answer` bubble ("**Project** is now in **dev mode**") plus an `end` message, polluting the chat transcript for what should be a silent, non-conversational UI state change. Every pill click posts a new bubble; rapid toggling queues multiple bubbles behind the same 5-slot send queue used for real chat messages, which can also delay actual chat responses. Separately, there's a real correctness bug: the client only sends this admin message when a project is active (`if(!activeProject?.id) return`) — meaning when no project is active, the mode pill flips **locally** in the UI with **no server write at all**: `console.config.json` isn't updated and no `project_updated` broadcast fires, so the UI can silently drift from the actual persisted state. | (1) Convert the mode-switch confirmation from a chat `answer` message to a top-of-app notification/toast, per the user's explicit request — this should go through the same direct-REST pattern established in D-7, not the chat pipeline at all. (2) Fix the "no active project" case so the mode toggle either writes to a sensible default-workspace-type setting when no project is selected, or is disabled/hidden in that state — it must not silently diverge from persisted state. |
| E-6 | Broader "route through notification instead of chat" audit (raw item 10.ii, "a lot of other executions like tool execution should be sent through the notification up instead of sending in chat") | Beyond mode-switch specifically, the user wants: tool-execution results, note-added confirmations, reminder-created confirmations, backup-created confirmations, schedule-created confirmations, and auto-start-triggered messages to all move from chat bubbles to toasts/notifications. Some of this is already correctly toast-routed (schedule-find, reminder-fired already use `toast:true`); most of the rest still posts a plain chat `answer`. | Systematically go through every `ws.send({type:'answer', ...})` call across `server/wsHandlers/*.js` that represents a routine confirmation (not a substantive answer to a genuine question) and convert it to use the toast/notification path instead, following the pattern already used correctly for reminder-fired. This should land as part of the same change as D-7 (direct REST + journal) since the two fixes are two sides of the same "stop routing routine actions through chat" problem. |

---

## PHASE F — Feature Completeness / Dead Button Sweep
*(Maps to raw request item 10.ii in full, plus item 11's "map out everything so stale buttons don't exist")*

### F.0 What the user asked for
Systematically verify every button/control actually does something. Specific items called out: the home-screen Quick Start Guide button; the AI-mode "deep thinking" button and other AI-mode buttons; whether project-click reliably opens the right tab; the general/developer mode chat-pollution bug (also covered in Phase E); reminders not showing "completed" state and lacking a delete action; notes not going to a recycle bin on delete; the notes bold button not actually applying bold formatting; the file explorer's path bar, "open with" (should list real apps for the file type, not just the built-in editor), and folder "expand" button.

### F.1 Consolidated Findings & Required Fixes

| # | Item | Status found | Fix |
|---|---|---|---|
| F-1 | Home screen "Quick Start Guide" button | **Conflicting findings across the three research passes** — one pass found it fully wired (opens a local system message + creates a session if needed), another found it has **no `onClick` handler at all** and is dead. This discrepancy itself needs resolving first. | Re-verify directly in the current code: click the button in a running instance. If it's genuinely dead (no handler), wire it to a real quick-start flow — either the existing `QUICK_START_TEXT` system message flow if that code path exists, or a dedicated quick-start tour section (tie this to Phase C's tour work). If it's actually wired but the discrepancy came from an earlier bug getting fixed between research passes, just confirm it still works after your other changes and move on. |
| F-2 | AI mode buttons ("deep thinking", Search, Reason, Deep Research) | Confirmed: **"Reason" is a raw `"[REASON] "` text prefix hack**, not a real mode — it does not map to any entry in `aiModePrompts.js` (which only defines `default/coding/tutor/creative/consultant/structured`). Search and Deep Research do dispatch into real tool-call paths (`/api/search`, `/api/deep-research`) so those aren't dead, but "deep thinking" more broadly is misleading: `think:true` is sent to Ollama **unconditionally** on every request regardless of which mode toggle is active, so the toggle doesn't actually control reasoning depth at all. | This is the same fix as A-14 — implement real `reason` and `deep-research` modes with actual behavioral differences (different `num_predict`/temperature/system-prompt instructions, or genuinely deeper tool-call chaining for deep-research), rather than a text-prefix hack. Do this once, referenced from both Phase A and here. |
| F-3 | Project click → which tab opens | Confirmed real bug: clicking a project card from the Bento grid **always creates a fresh chat session** even if an empty session already exists for that project (orphaning empty sessions over time), and when the active workspace tab is "General," clicking a project can land on the Tools grid first instead of chat, contradicting the expected "project click → chat" behavior. Dashboard-card clicks correctly reuse an existing session; tab clicks correctly restore the right view — the bug is specific to the Bento-grid entry point. | Prefer reusing a single existing empty session for a project instead of always creating a new one. Gate the "General workspace opens Tools first" behavior behind an explicit toggle rather than making it the unconditional default, since it contradicts the more intuitive expectation. |
| F-4 | Reminders: complete / delete / "completed" list | Confirmed real bug, exactly as the user described: **completing a reminder currently deletes it outright** (implemented as `cancel reminder <id>`) — there is no persisted "completed" state and no way to view previously-completed reminders. There is also **no explicit per-row delete action** distinct from "complete" — completing *is* the only removal mechanism (deleting via a typed chat command like "delete reminder 5" does work, but there's no UI button for it). | Add a real `completed: boolean` (or `status` enum) field to the reminder/schedule data model. Completing a reminder should set this flag and move it to a "Completed" section/filter in the UI, **not** delete it. Add a separate, explicit per-row delete button distinct from complete, with the same undo-toast pattern already used for complete. |
| F-5 | Notes: delete → recycle bin | Confirmed real bug: `deleteNote` **permanently removes** the note immediately with no recycle/trash intermediate state and no undo — unlike reminders, which do have an undo toast. There's also a **separate, worse bug** found during the audit: deleting a note only matches and removes the **first line** that matches — if two notes happen to share a first line, only the first match is removed, which is surprising and potentially destructive. A related profile setting, `askBeforeDeleteLinkedNote` (governs whether deleting a note that has a linked reminder should prompt first), is **stored in the user profile but never actually read** by the delete handler — it currently always auto-cancels linked reminders regardless of what the user configured. | (1) Implement a real recycle/trash state: deleting a note moves it to a recycle store (e.g. `.console/notes.trash.md` or equivalent) rather than removing it outright; add a "Recycle" view where the user can restore or permanently delete from there, matching the user's explicit request ("If I delete a note the note should go to recycle and then I can choose to delete from recycle"). (2) Fix the first-line-match deletion to identify notes unambiguously (e.g. by a stable ID) instead of by first-line text matching. (3) Actually read and respect `askBeforeDeleteLinkedNote` in the delete handler. |
| F-6 | Notes: bold/italic/formatting buttons | Confirmed real bug, exactly as the user described: the toolbar buttons splice raw Markdown syntax (`**text**`, `_text_`, etc.) into a **plain `<textarea>`** — there is no rendering step, so the user sees literal asterisks in the editor, not bold text, which reads as broken. There's also a separate edit-flow bug: saving an edit on blur currently **appends a new note line** rather than replacing the original in place, so editing a note's body (not just clicking delete) can silently leave a duplicate/orphaned old version behind. | (1) Add real formatting feedback — either render a live Markdown preview pane next to the raw editor, or move to a `contentEditable`/rich-text editing model so "Bold" visibly bolds the selected text immediately, not just inserts symbols the user has to mentally parse. (2) Fix the save-on-blur path to be a true in-place replace of the original note (e.g. by stable ID, once F-5's ID fix lands) rather than an append that orphans the old version. |
| F-7 | File Explorer: path bar / breadcrumb | Found to be **already working** in the most recent code state across all three passes (breadcrumb built from the path, clickable segments, working back/forward/up/home/refresh history stack) — but confirm this directly since it's the one item in this sub-list where all passes agree it's fine, worth a quick sanity check rather than blind trust given other discrepancies found elsewhere in this phase. | Quick manual verification only; if confirmed working, no change needed. One legitimate minor bug found: the `home()` handler's drive-root detection regex is Windows-specific and fails on POSIX paths — fix that regex to handle both. |
| F-8 | File Explorer: "open with" | Confirmed **partial gap, matching the user's exact complaint**: "open with" currently only lists a small, hand-curated set of registered editors (from an internal `editors.json`/`editorsStore`) — it does **not** query the OS's real file-type associations (`AssocQueryString` on Windows, Launch Services on macOS), so it will never show, say, "Photoshop" or "VLC" unless someone manually added them to the internal editor registry. This matches the user's complaint that "open with" should show real apps for that file type, not just the built-in editor(s). | Extend "open with" to also enumerate real OS-level default/associated applications for the file's extension (platform-specific: Windows registry/`AssocQueryString`, macOS `LaunchServices`/`duti`-equivalent, Linux `xdg-mime`), and merge that list with the existing curated editor registry rather than replacing it — the curated list still has value for editors the OS doesn't know about (e.g. a specific dev tool). |
| F-9 | File Explorer: folder "expand" button | Confirmed real bug as described: the expand affordance on a folder currently **drills in and replaces the current listing** (a full navigation, same as clicking the folder name) rather than expanding **inline** into a tree view — so if the user expected an in-place expand/collapse tree (which the button visually implies), it does nothing different from just navigating in, which reads as broken. | Either implement a genuine inline expand/collapse tree (folder rows can nest child rows without replacing the current view) as an alternative browsing mode, or — if a full tree view is out of scope for this pass — remove the misleading expand affordance and make it visually clear that clicking a folder navigates rather than expands. Given the user explicitly flagged this as a "does nothing" bug, prefer implementing the real inline tree if time allows, since it's also called out as a parity gap vs. OS file managers in Phase J. |
| F-10 | General dead-button sweep beyond the explicit list | The user explicitly asked: *"map out everything so stale buttons like this don't exist."* Do not stop at the 9 items above. | Systematically click through **every** interactive control in every panel (Tools grid, Calculator, Spreadsheet, PDF Tools, Clipboard, Backup, Command Deck, Dashboard project-card action rows, Process Dock tabs, Notifications panel, Settings/Profile modal categories) and confirm each one produces a real, correct effect. Two smaller issues already surfaced during this kind of sweep and should be fixed while you're doing this pass regardless of which research pass first noted them: (a) `FolderExplorerPanel`'s "open default app" action currently fails silently on error with no user-facing toast — add one; (b) the folder-stale notification's day-count input accepts values with no upper-bound validation feedback — add basic input clamping/validation messaging. Log every additional dead/inert/silently-failing control you find during this sweep in the Phase L changelog, even ones not mentioned anywhere in this document. |

---

## PHASE G — Theming, Customization & Visual Design (incl. Liquid Glass)
*(Maps to raw request items 7 (customizable, not hardcoded), 10.i, and 12)*

### G.0 What the user asked for
10.i: Although the app theme is customizable, several elements are still hardcoded blue regardless of the user's chosen accent — the tour highlight color, the project folder icon, and the project-hover highlight specifically called out. The black theme is good, but it should blend nicely with whatever accent color the user picks. In Settings, the user wants the option for the background/accent to "follow the mouse" the same way the project-hover effect currently does, and the same mouse-follow concept should extend to the app loading screen (see Phase H).
12: Add a "liquid glass" visual touch and make some boxes more rounded/circular-edged. Liquid glass should be toggleable on/off from Settings. Two specific reference React components were supplied as candidates: `liquid-glass-button.tsx` (an SVG `feTurbulence`+`feDisplacementMap` distortion filter plus a metallic button variant) and `sonar-grid.tsx` (a canvas-based reactive dot-grid that pings on click/interval, theme-aware). Full source for both is reproduced in **Appendix A** and **Appendix B** of this document.

### G.1 Consolidated Findings

| # | Location | Problem | Fix |
|---|---|---|---|
| G-1 | `src/index.css` (`:root` + `[data-theme=light]` tokens), `src/hooks/useTheme.ts`, `src/App.tsx` | The theming *architecture* itself is confirmed exemplary by all three research passes — CSS custom properties, Tailwind v4 `@theme inline` re-exporting tokens as utility classes, a shared pub/sub theme store, pre-paint anti-flash script. This is the correct foundation to build the rest of this phase on. **However**, only the single `accentColor` (mapped to `--color-accent-blue`) is currently user-overridable — the other semantic accents (teal/orange/green/red) are fixed regardless of the user's chosen color, which is the direct cause of the hardcoded-blue complaints below. | Keep the architecture as-is; the fix for the specific hardcoded elements below is to route them through the existing `--color-accent-blue` token (or a `color-mix()` derivation of it), not to rebuild the token system. |
| G-2 | `src/components/TourOverlay.tsx` (spotlight ring) | Confirmed exactly as the user described: the tour spotlight ring's border correctly uses the `accent-teal` token, but its glow/shadow is a **hardcoded literal** (`rgba(100,210,255,0.25)`) that stays a fixed blue-teal regardless of the user's chosen accent color, and additionally doesn't correctly adapt between light/dark theme variants of teal. A correct counter-example already exists elsewhere in the same codebase (`SpotlightCard.tsx`'s hover glow correctly uses `color-mix(in srgb, var(--color-accent-teal) 10%, transparent)`). | Replace the hardcoded rgba shadow with a `color-mix()` expression against the theme token, following the exact pattern already used correctly in `SpotlightCard.tsx`. |
| G-3 | Project folder icon color, project-hover highlight | Confirmed by the user directly and consistent with the general pattern found elsewhere — locate wherever the folder icon and the project-card hover highlight set their color and confirm whether they're using a hardcoded blue literal or the `accent-blue` token; the audit found this general *pattern* (isolated hardcoded colors alongside an otherwise-tokenized system) recurring in a small number of places (`UserProfileModal.tsx`'s preset swatches — acceptable, they represent the palette choices themselves — its "Auto" gradient button, which hardcodes both light and dark background hex values instead of referencing `var(--color-background)` for each theme; `CalculatorPanel.tsx`'s operator-button text color, which is a justified contrast choice but should still reference a token; an "update available" banner using a generic teal alias instead of `accent-blue`, which means it ignores the user's accent override). | Grep for raw hex literals (`#[0-9A-Fa-f]{3,8}`) across `src/components/` and `src/index.css`, filter out legitimate token *definitions* and genuinely-intentional preset-swatch values, and replace every remaining stray literal — explicitly including the folder icon and hover highlight the user named — with the appropriate theme token or a `color-mix()` derivation of it. Fix the "Auto" gradient button and the update-available banner's stray teal alias as part of the same pass, since they're the same underlying pattern. |
| G-4 | Mouse-follow color-blend effect (Settings toggle, and reused for the loading screen in Phase H) | A working reference pattern for this **already exists in the codebase**: `src/components/SpotlightCard.tsx` implements exactly this — `onMouseMove` tracked position feeding a `radial-gradient(600px at x y, color-mix(accent-teal 10%), transparent)` overlay, GPU-composited, no canvas needed. `GlowOrbs.tsx` provides a complementary static ambient-glow pattern using the same token-aware approach. Neither `feDisplacementMap` nor a canvas dot-grid currently exists anywhere in the codebase — the two Appendix components are net-new. | Implement the sitewide "color follows mouse" setting using the **same lightweight CSS `radial-gradient` + `pointermove` approach** already proven in `SpotlightCard.tsx` — this is the fastest (sub-1ms/frame), lowest-risk, dependency-free option, and it naturally uses the existing accent token so it respects whatever color the user has chosen. Gate it behind a new `colorFollowsMouse: boolean` field in the user profile, following the exact same enable/disable pattern already used for `accentColor`. Respect `prefers-reduced-motion` — freeze/disable the effect for users who have that OS setting on. |
| G-5 | "Liquid glass" sitewide toggle | No existing glass-distortion system exists; current "glass" look is limited to Tailwind's `backdrop-blur-sm/md/xl` utilities applied to ~7 surfaces (modals, tour overlay, terminal, command deck). The user's Appendix-A component (`liquid-glass-button.tsx`) provides a genuine SVG-filter-based distortion glass effect (`feTurbulence` + `feDisplacementMap` inside a hidden `<svg><filter>`, applied via `backdrop-filter: url(#container-glass)`), which is a materially different and more elaborate effect than the current plain blur. | Implementation plan (both research passes agree this is architecturally straightforward given the existing token system): (1) Add glass-specific tokens to `src/index.css` (`--color-glass-bg`, `--color-glass-border`, `--shadow-glass`, etc.) for both dark and light theme variants. (2) Add a `liquidGlass: boolean` field to the user profile (default **on**, per the user's request — "let liquid glass be able to turn on and off from settings" implies it should ship enabled by default with an off switch, not opt-in). (3) Apply a `data-liquid-glass` attribute to `<html>` via `useTheme`, mirroring the existing `data-theme` pattern. (4) Import the `GlassFilter` SVG filter definition from Appendix A once, globally (it only needs to exist in the DOM once, referenced by `url(#container-glass)` from any element). (5) Apply the glass treatment to the specific surfaces the user asked to feel more "glass" — buttons, cards, panels — using `backdrop-filter: url(#container-glass)` when the toggle is on, falling back cleanly to the existing plain `backdrop-blur-xl` when off, so there's no broken state either way. (6) Respect `prefers-reduced-motion`/graphics-preference settings — the SVG turbulence filter has a real GPU cost; provide the plain-blur fallback automatically on very low-power devices if you can detect that reasonably, otherwise just make sure the toggle is easy to find and off is a fully clean fallback. |
| G-6 | "More circular/rounded edges" (raw item 12) | General visual-polish request, not a specific bug. | As part of the same visual pass, identify the panels/cards/buttons where a larger border-radius would read as more polished (following the design language implied by the liquid-glass reference components, which lean toward soft, rounded, glassy shapes) and increase `border-radius` on those surfaces via the existing Tailwind radius tokens/scale — do not introduce a one-off radius value outside the existing scale. |
| G-7 | shadcn/Tailwind/TypeScript prerequisite check for Appendix A/B components | Both reference components assume: a shadcn-style `/components/ui/` folder, a `cn()` utility at `@/lib/utils`, Tailwind CSS, and TypeScript. Confirm the codebase already has all of these (the research found `components.json` already exists with `tsx: true` and the project already has a `/components/ui/` — or equivalent — folder with existing shadcn-derived components) before copying the new files in. | Verify `components.json`'s configured path, confirm `cn()` exists at the expected import alias, and confirm `class-variance-authority` and `@radix-ui/react-slot` (needed by Appendix A) are already dependencies or need adding (`sonar-grid.tsx` needs no new runtime dependency beyond React itself; its demo additionally uses `motion/react` and `lucide-react`, both of which are already project dependencies). Add any missing dependency. Place both new component files under the project's existing `/components/ui/`-equivalent path, matching existing file-naming conventions there (e.g. kebab-case matching neighbors like `spotlight-card.tsx`). |

### G.2 Integrating the two reference components

Do **not** integrate these two components verbatim/unmodified as drop-in "demo" pages — adapt them to serve the specific purposes above:

- **`liquid-glass-button.tsx`** (Appendix A): use its `GlassFilter` SVG filter definition as the shared sitewide liquid-glass filter (G-5). Its `LiquidButton` variant is a good candidate for at least one prominent CTA-style button (e.g. a primary action in a modal) as a showcase of the effect, but the sitewide toggle (G-5) should apply the *filter*, not necessarily convert every button component to this exact one — evaluate case by case which existing buttons should adopt the glass treatment and which should stay as plain buttons. Its `MetalButton` variant is optional/lower-priority — only use it if there's a natural fit (e.g. a "premium" or "pro" feature callout); it's not required to satisfy anything in the raw request.
- **`sonar-grid.tsx`** (Appendix B): this is the strongest available prior art for the mouse-reactive loading-screen concept in Phase H — its canvas dot-grid with expanding rings, theme-aware coloring (reads `text-primary` via `getComputedStyle`), `prefers-reduced-motion` handling, and pause-when-hidden/off-screen behavior are all directly reusable patterns. It is **not** a literal "sand block" visual as the user described for the loading screen (dots/rings, not blocks) — adapt it rather than using it unmodified: see Phase H for the specific adaptation needed (swap circular dots for block/rect shapes, and add continuous mouse-position-driven displacement in addition to the existing click/ping behavior).

---

## PHASE H — Install/Update Screen & App Loading UX
*(Maps to raw request item 9 in full)*

### H.0 What the user asked for
The installation/update screen should look better; installing or updating currently takes a long time. Design concept: while the app is loading, show a large "Project Console" wordmark across the top half of the screen with a small "made by Tobiloba Jagun" credit line beneath it, and in the lower half show live loading-state text and elapsed time. Color scheme: blue, red, black, white. As the user's mouse moves across the screen, blocks should move like sand and the color should blend smoothly, similar to a reference image the user provided (image not included in this merged document — if it isn't available to you when you begin this phase, proceed from the text description alone and flag that the reference image should be checked against once implemented, don't guess wildly beyond what's described here).

### H.1 Consolidated Findings & Required Fixes

| # | Location | Current state | Fix |
|---|---|---|---|
| H-1 | `desktop/main.cjs` (`buildSplashHtml`), `server/index.js` (boot-state stderr emission) | The desktop splash screen already exists and already does real work worth preserving: it's a `data:text/html` inline document (works from Electron's sandboxed environment with no external file dependency), styled in the dark palette already (`#0D0D0E` background, `#161618` card), with a progress bar and **live boot-state text driven by real server stderr output** (`[boot-state]<state>` messages parsed into human labels like "Downloading model," "Scanning," "Loading match engine") plus a live elapsed-time counter. This live-status wiring is exactly the mechanism the user is asking for in the lower half of their described design — it already exists, it just needs a visual redesign, not new plumbing. The **web** entry point (opening the app in a browser rather than the desktop shell) currently has **no equivalent full-screen loading state at all** — it goes straight to the Welcome screen with only a small header pulse indicator. | Redesign the **visual** presentation of the existing splash (keep the underlying `[boot-state]` stderr-parsing mechanism as-is — it works and there's no reason to rebuild it) to match the user's concept: large "Project Console" wordmark filling the top half, small "made by Tobiloba Jagun" credit beneath it, live status text + elapsed time in the bottom half, on the blue/red/black/white palette. Additionally, build an equivalent full-screen loading state for the **web** entry point so browser users get the same experience, not just the desktop shell — this can reuse the same visual component, driven by whatever boot-progress signal is available to the web client (poll a status endpoint if the raw stderr stream isn't accessible from the browser context). |
| H-2 | Mouse-reactive "sand block" animation | No such effect exists anywhere in the codebase today. The closest prior art is `sonar-grid.tsx` (Appendix B) — a canvas dot-grid with expanding ring pings — which is **dots/rings**, not blocks, and is currently only interaction-on-click/interval rather than continuous cursor-follow. | Adapt `sonar-grid.tsx`'s canvas engine rather than starting from scratch: (1) swap the circular dot rendering for small rounded-rect "block" shapes to match the user's "sand" description, (2) in addition to (or instead of) discrete click/interval pings, add a continuous field where blocks nearest the cursor shift color/scale smoothly based on distance-to-pointer (a simple falloff function, not a physics simulation), so color blends as the mouse moves rather than only pinging on click, (3) drive the block colors from the blue/red/black/white palette specified by the user rather than the single `text-primary` token the original component reads, blending between palette colors based on the same distance-to-pointer falloff so it reads as a smooth color blend, matching the "blocks move like sand and the color kinds of blends nicely" description. Recommended technique: Canvas 2D (not WebGL/Three.js — the research found WebGL to be higher-fidelity but meaningfully heavier: extra bundle size, shader-compile jank, complications with Electron's `sandbox:true` preload restrictions, and unnecessary battery cost for this use case) — a modest grid (order of a few hundred to ~2000 blocks depending on target screen size) with `requestAnimationFrame`-driven per-frame color/scale lerp toward a pointer-distance-derived target keeps this well under 1-2ms/frame on typical hardware. Respect `prefers-reduced-motion` (freeze the animation, keep the static palette/layout) exactly as `sonar-grid.tsx` already does for its own effect. |
| H-3 | Boot/install slowness itself | Covered in depth by Phase D (D-4, D-5) — the ~35-second embedding computation is the dominant cost and is fixed by persisting computed intent vectors to disk (D-4). Separately: the installer bundles the entire `node_modules` (production deps) plus the built frontend into the NSIS package with no differential-update mechanism, so both fresh installs and updates re-transfer the full package size every time. | Cross-reference and rely on the D-4 fix for the boot-time portion — don't duplicate that work here. For install/update size specifically: investigate whether `electron-updater`'s differential/delta update support (it has some built-in capability for this) is actually enabled — if not, enabling it would meaningfully shrink update downloads (though **not** fresh installs, which will always need the full package). This is lower priority than D-4 and can be deferred if time-constrained, but should at least be evaluated and the decision documented in Phase L's changelog either way. |
| H-4 | Installer staging correctness | Confirmed already correct and should not be touched: the staging script deliberately ships an **empty** `data/` directory in fresh installs (guaranteeing new users start with a clean slate, no leftover dev data), and a post-pack step correctly copies `node_modules` into the packaged resources (which `electron-builder` would otherwise exclude by default) — both were the fix for prior real install-breaking bugs and must not be reverted. | No change needed here — just don't regress this while doing the H-1/H-2 visual work. |

---

## PHASE I — Auth / Multi-User Portal
*(Maps to raw request item 8 in full)*

### I.0 What the user asked for
Introduce a login/user-portal function so the app can support multiple users, each optionally with their own password, with a way to reset a forgotten app password — possibly by authenticating against the user's OS login (Windows Hello / system credential prompt) rather than a traditional email-reset flow.

### I.1 Consolidated Findings & Recommended Direction

| # | Finding | Direction |
|---|---|---|
| I-1 | Confirmed unanimously across all three passes: **there is currently no authentication of any kind** — what exists is a lightweight "attribution" system (a per-connection `displayName` string, sanitized but not authenticated, used only to label who created a given note/reminder/action-history entry). A single global `data/user-profile.json` serves the entire install; there is no per-user data isolation — if two people are on the same LAN-exposed instance, one can read the other's action history, notes, and reminders with zero access control. When `HOST` is set to `0.0.0.0` (LAN-exposed mode), the app explicitly warns in its own logs that it can execute shell commands with **no authentication whatsoever**. No auth-related library (`bcrypt`, `argon2`, `jsonwebtoken`, `passport`, `better-sqlite3`, `keytar`, etc.) exists anywhere in the dependency tree today. | This is real, currently-shipping-as-is behavior the user needs to know about before or during this work — treat the LAN-exposure warning as a real security consideration, not just a feature gap, while building the fix. |
| I-2 | Recommended architecture (synthesized from all three passes' feasibility research) | **Storage**: a new gitignored `data/users.json` (or a lightweight local database — `better-sqlite3` is a reasonable option if the team is comfortable adding a native dependency; a flat JSON file with one entry per user is sufficient and adds no new dependency if kept simple) holding `{ username, passwordHash, salt, role, createdAt }` per user. **Hashing**: use `argon2` (memory-hard, current best practice) if adding a native dependency is acceptable, or `bcryptjs` (pure JS, no native compile step, simpler to ship cross-platform in an Electron app) if avoiding native deps is preferred — pick one and use it consistently; do not hand-roll password hashing with the built-in `crypto` module's PBKDF2 as the primary scheme, even though `crypto` is already available with no new dependency, since it's a weaker default than argon2/bcrypt for this use case. **Session**: an opaque token (`crypto.randomUUID()`-based) or JWT, delivered as an `HttpOnly` cookie for the web/browser client and validated on the WebSocket `upgrade` request (extending the existing `display_name`-based upgrade flow rather than replacing it wholesale) alongside a `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/me`, and a reset-flow endpoint. **Per-user data**: shard the currently-global `user-profile.json` into `data/users/<id>/profile.json`, and extend `createdBy` attribution (already present on notes/reminders/action-history) to become genuine access control rather than just a display label, gated by the authenticated user's ID. |
| I-3 | Password reset via OS authentication (the user's specific request) | On Windows specifically, true Windows Hello biometric verification requires a native Node addon that is **not currently present** in the dependency tree and is a non-trivial integration (not a quick win). A more immediately achievable middle ground: Electron's built-in `safeStorage` API (backed by Windows DPAPI, macOS Keychain, or Linux libsecret depending on platform) can be used to prove "this OS-level user account is the one that originally set up this app install" — i.e., use `safeStorage.isEncryptionAvailable()`/`encryptString`/`decryptString` to store a reset-capability secret that only the same OS user account can decrypt, functioning as a reasonable "prove you're the same person who has access to this machine" gate for password reset, without needing a full biometric integration. | For the initial implementation, prefer the `safeStorage`/DPAPI approach over attempting true Windows Hello biometrics — it satisfies the spirit of "reset by authenticating from their system" with materially less implementation risk, using an API already available in Electron with no new native dependency. Document true Windows Hello as a possible future enhancement rather than attempting it in this pass, since the research explicitly flags it as "not trivial." |
| I-4 | Scope check | Multi-user auth is a substantial feature addition, not a bug fix — treat it as lower execution priority than Phases A-H (which fix things the user experiences as actively broken) but still deliver it, since it was explicitly requested. | Sequence this phase after the higher-priority latency/chat/notification/dead-button fixes (Phases A-F) are done, but before the final Phase L docs/push/rebuild step, so it's included in the shipped state described in the updated README/FEATURES docs. |

---

## PHASE J — Real-World Feature Parity Research & Implementation
*(Maps to raw request item 11)*

### J.0 What the user asked for
Research real-world apps/websites/interfaces comparable to each tool in this app and close the functionality/UI gaps. Introduce meaningful new features to Notes and other tools specifically. (The bold-button bug is covered in F-6 — this phase covers everything else.)

### J.1 Consolidated Findings & Required Work, by tool

| Tool | Gap vs. real-world comparable (Apple Notes/Obsidian/Notion for notes; Windows Explorer/Finder/VS Code for file browsing; etc.) | Work |
|---|---|---|
| **Notes** | No checklists (`- [ ]` syntax), no tags, no pin/favorite, no note-to-note linking (only note→reminder via plain text copy, not a real link object), no search-result highlighting, no version history, no attachments/images. Search is a simple client-side substring filter only. Cap of 200 entries × 1000 chars per project. | Beyond the F-5/F-6 fixes (recycle bin, real formatting), add: checklist syntax support with a toggle UI, tags with filtering, pin/favorite, and search-term highlighting in results as the highest-value, most-requested-pattern additions. Note-to-note linking and attachments are reasonable stretch goals if time allows but are lower priority than the core fixes already covered in Phase F. |
| **File Explorer** | Beyond the F-8/F-9 fixes (real OS "open with," inline tree), the explorer currently has **no create-file/create-folder/copy/cut/paste/duplicate/delete** operations at all — only rename/move, and those are sandboxed to the currently active project's path. No properties/metadata pane, no thumbnail/quicklook preview (the separate File Tools panel has an HTML-only preview via iframe), no recursive/content search (current-folder name-only filter; content search exists but lives in a *different* panel — File Tools), no drive enumeration on Windows. | Add create-file, create-folder, copy, cut/paste, duplicate, and delete operations, gated through the same confirm + journal + undo pattern used elsewhere (per D-7's direct-REST-with-journal pattern). Add a basic properties/info panel. Add an optional recursive/content-search mode that reuses the File Tools panel's existing content-search capability rather than reimplementing it. This is one of the higher-effort items in this phase — sequence it appropriately, but it's also one of the most visibly incomplete tools relative to what users expect from *any* file browser, so don't skip it. |
| **Spreadsheet/CSV panel** | Currently strictly **read-only** — quoted-field CSV parsing, preview, sort, and filter/sum/avg/count operations, but no in-cell editing, no formula bar, and no save-back to file. The panel is currently named "Spreadsheet," which over-promises relative to what it actually does. | Either add real in-cell editing with save-back-to-CSV (through the confirm+journal pattern, since this is a mutating action), or rename the panel/feature to something accurate like "CSV Viewer" if editing is out of scope for this pass. Prefer adding basic editing if time allows, since "Spreadsheet" is the name already shown to users and it currently doesn't live up to it. |
| **PDF Tools** | Solid coverage of merge/split/watermark/text-extract already. Missing: password-unlock (currently just errors on a protected PDF instead of offering to unlock), compression, OCR. | Add password-unlock support at minimum (currently the single clearest gap — an error with no path forward is a dead end for the user). Compression and OCR are reasonable stretch goals, lower priority. |
| **Reminders** | Beyond the F-4 fix (completed state, delete button), no snooze action, no in-place recurrence editing (must delete and recreate to change a recurring pattern), no subtasks, no smart lists (overdue/today/flagged equivalent groupings beyond the existing Today/Upcoming/All/No-Date/Completed tabs). | Add snooze (ties into E-2). In-place recurrence editing and subtasks are reasonable stretch goals if time allows. |
| **Clipboard, Backup, Command Deck, Dashboard** | Found to already be in reasonably good shape relative to comparable tools (Ditto/Raycast for clipboard history; standard zip-export for backup; Raycast-style command palette for Command Deck; project-card-based dashboard). No urgent parity gaps identified — the research explicitly rates these as "moderate" or "shipped/low priority" rather than flagging concrete missing functionality. | No required work here beyond whatever falls out naturally from the direct-REST migration (D-7) and the general dead-button sweep (F-10). Don't invent new scope for these unless something concrete turns up during F-10's sweep. |
| **Any other tool/interface not named above** | The user explicitly said this research should go beyond the named list. | As part of doing the work above, if you notice another tool with an obvious, easy-to-name real-world-comparable gap, note it and fix it if reasonably scoped; log it in Phase L's changelog either way even if you decide to defer it. |

---

## PHASE K — Error Sweep
*(Maps to raw request item 11's "sweep every line of code and map everything together so there are no errors")*

### K.0 What the user asked for
Sweep the whole codebase for every kind of error: silently swallowed errors, unhandled promise rejections, calls to undefined/placeholder functions, TODO/FIXME/HACK comments, and generic/unhelpful user-facing error messages that could be made specific and graceful instead.

### K.1 Consolidated Findings & Required Fixes

| # | Location | Problem | Fix |
|---|---|---|---|
| K-1 | `server/projectScanSingle.js`, `server/projectScanContainer.js` (identical, duplicated — see B.2), `server/projectScanHelpers.js` | **Empty `catch (err) {}` blocks** silently swallow `console.config.json` read/parse/stat failures — a corrupted config file is currently indistinguishable from an absent one, and the user gets "no projects found" with zero indication anything went wrong. Also silently swallows `readdir` permission errors (`EACCES`) in the helpers file. | Log a warning (`log.warn`, matching the style already used correctly elsewhere in the same codebase, e.g. `readProjectContextDocs`'s existing `log.warn` call) whenever a `JSON.parse` failure or a permission-denied error occurs — keep the silent path only for the genuinely-expected "file doesn't exist" case (`ENOENT`), which is not an error worth surfacing. |
| K-2 | `server/sessionIndex.js` | `await fs.writeFile(INDEX_PATH, data).catch(() => {})` hides real write failures (disk full, read-only filesystem) — the app self-heals via a reconciliation pass on next read, but the user is never told a write failed, and `messageCount`/`title` metadata can be lost in the interim. A related fire-and-forget promise chain (`persistenceChain = next.catch(() => {})`) deliberately never rejects so a single failed write doesn't wedge the whole queue (a legitimate design choice) — but it also never surfaces the failure anywhere, even at debug level. | Log write failures at `error` level (not silent), while keeping the self-healing/non-blocking behavior intact — the goal is visibility, not changing the resilience design. Log the fire-and-forget chain's failures at `debug` level at minimum. |
| K-3 | `server/wsHandlers/connectionLifecycle.js`, `server/wsHandlers/connectionMatching.js`, `server/wsHandlers/aiQuery.js`, `server/wsHandlers/connectionExecute.js`, `server/wsHandlers/connectionModeAdmin.js` (six call sites total) | `appendMessage(...).catch(() => {})` and `ensureConsoleConfigGitignored(...).catch(() => {})` calls across these six sites silently hide persistence/gitignore failures — inconsistent with a **sibling call site** in `conversationStore.js` that correctly does `logger.error('[conversationStore] appendMessage: failed…')` for the same kind of failure. On a disk-full or read-only `data/` directory, this currently means chat history can silently fail to persist with zero indication to the user, who will simply find their history missing after a reload. | Bring all six sites in line with the correct sibling pattern already present in `conversationStore.js` — replace the silent `.catch(() => {})` with a proper `logger.error(...)` call including context (which operation, which session/project). |
| K-4 | `server/index.js` (boot sequence), `server/learningEngine.js` | `checkCollisionBaseline().catch(() => {})`, `checkForUpdates(false).catch(() => {})`, `nlpEngine.train(...).catch(() => {})`, and `semanticMatcher.addLearnedExamples(...).catch(() => {})` all swallow boot-time/NLP/embedding failures with no log line — inconsistent with sibling boot steps in the very same file that correctly call `log.error('SemanticMatcher init failed')` for an equivalent failure category. A failed `nlpEngine.train` specifically leaves the matcher running in a degraded state with **zero** indication in the boot log that anything went wrong. | Bring all four call sites in line with the correct sibling pattern in the same file — add `log.error` with context for each. |
| K-5 | `server/wsHandlers/connectionConfirm.js`, `server/wsHandlers/connectionExecute.js` | Generic, non-actionable user-facing error text: `"Confirmation token is invalid or expired."` is used identically for three genuinely different situations (token missing, token belongs to a different session, token genuinely expired) — the user has no way to tell which happened or what to do next. `"Project not found. Scan directory again."` gives no project name or path, making it hard to tell *which* project failed to be found when multiple are open. A correct counter-example already exists in the same codebase (`actionHistory.js`'s refusal messages correctly name the specific action ID and give an exact reason). | Differentiate the confirmation-token error into its three distinct cases with distinct, specific messages (following the `actionHistory.js` style already proven correct elsewhere in this codebase). Include the project name/path in the "not found" message. |
| K-6 | `src/hooks/useConsoleTabs.ts`, `src/components/FolderExplorerPanel.tsx`, `server/notify/notifyChannels.js` (see E-1), `server/sessionIndex.js` (see K-2), `server/wsHandlers/aiQuery.js` | Broad pattern: roughly a hundred `.catch(() => {})` sites exist across the frontend hooks and backend handlers. Several of the highest-impact ones: `useConsoleTabs.ts`'s `fetchProjects`/`scanNewPath` failures are swallowed to `null`, making a genuine network/filesystem error indistinguishable from "this folder legitimately has no projects." `FolderExplorerPanel.tsx`'s browse-failure path shows a blank panel with no "folder not found" message. Notably, `useProjects.ts` has an explicit code comment documenting that an *identical* bug in that file was **already found and fixed** ("Previously swallowed silently — fixed") — but the same fix was never applied to the equivalent code in `useConsoleTabs.ts`, meaning the bug was fixed in one place and left in a sibling place doing the same thing. | Do a full pass over `.catch(() => {})`/`catch (err) {}` sites across both frontend and backend, applying the same triage used above: genuinely-expected "not found" conditions can stay silent (or show a calm, specific "nothing here yet" state), but genuine errors (network failure, permission denied, malformed data, disk full) must surface *something* to the user or the log, never total silence. Specifically fix the `useConsoleTabs.ts` instance to match the fix already correctly applied in its sibling `useProjects.ts`, using that file's own comment as the direct pointer to what the fix should look like. |
| K-7 | Global error handling (`server/index.js` `process.on('unhandledRejection'/'uncaughtException')`, `desktop/main.cjs` crash handlers, WebSocket message-handling try/catch) | Confirmed **already correct** and should be preserved as-is: global handlers log with full context and keep the server running (correct for a single-user local tool — crashing the whole process on one bad request would be worse), `init().catch` at the top level does fail loudly with `process.exit(1)` for genuine unrecoverable boot failures, and the WebSocket message router has an appropriate double-guard against a dead socket during error reporting. | No change needed — verify this remains true after your other changes (a refactor elsewhere shouldn't accidentally soften or remove these guards) and move on. |
| K-8 | TODO/FIXME/HACK/XXX/stub debt | Confirmed **clean** by all three research passes — the only grep hits across the entire codebase are the `TODO_RE` pattern used by the app's own "find TODO comments" *feature*, plus a documented, intentional "dateless reminder" TODO note in the reminder parser. There is no real backlog of unfinished-code markers. | No action needed — do not manufacture cleanup work here. This finding exists in the prompt only so you don't waste time re-verifying it; move directly to the other items in this phase. |
| K-9 | `server/clipboardHistory.js`, `server/verifyHarness.js` | Two lower-priority fire-and-forget swallows: clipboard polling (`pollOnce().catch(() => {})`, relevant when the OS clipboard is locked by another process) and the background TypeScript-check harness (`runTypeScriptCheck(...).catch(() => {})`). Both are reasonable to swallow (they're genuinely non-critical background tasks), but currently give zero visibility even at debug level. | Add a `log.warn` on a non-zero exit code / genuine failure in both cases, purely for debuggability — no behavior change needed beyond adding the log line. |

---

## PHASE L — Final Steps (only after every phase above is complete and verified)

Per the user's explicit instruction, this is the **only** part of the process that should touch documentation/release mechanics, and only once everything above is done:

1. **Update `README.md`** so it accurately reflects the app's actual current state — features, setup instructions, screenshots if applicable — after all the above changes. Do not leave stale references to bugs that have now been fixed (e.g. remove any documented workaround for the port-timeout issue if D-5 is fixed) or to features that didn't exist before this pass (e.g. document the new liquid-glass toggle, the new notification popup, the new auth system if implemented).
2. **Update `FEATURES.md`** to list every feature/fix delivered in this pass, organized by the phase structure above (or your own clearer organization) so a future reader can see what changed and why. Include the "bonus" findings you fixed along the way per each phase's "go beyond the list" instruction — this is the changelog referenced throughout this document.
3. **Update `CLAUDE.md`** so its description of the codebase's known issues, safety model, and architecture notes are current — remove anything this pass has resolved (e.g. the "attribution, not auth" language in `CLAUDE.md` should be updated if Phase I's real auth system landed; the LAN-exposure warning should stay if it's still accurate, or be updated if Phase I materially changed the security model), and add anything materially new about the architecture that a future contributor/AI session would need to know (e.g. the new direct-REST-plus-journal pattern from D-7, the new `tuningStore`/token additions from Phase B/G).
4. **Commit and push to GitHub.** Use clear, reviewable commit messages — prefer several well-scoped commits over one giant commit, consistent with Ground Rule #1's guidance about working in parallel with other sessions.
5. **Rebuild the app** — web build, desktop/exe build (through the full `stage-server.mjs` → `electron-builder` pipeline), and confirm the CLI entry point still works — and do a final smoke test of the specific things the user was most frustrated by at the start of this process: open a new tab and confirm it doesn't show stale content, time a cold boot and confirm it's meaningfully faster than "over a minute," set a reminder and confirm a real Windows notification arrives, switch general/developer mode and confirm nothing posts to chat, delete a note and confirm it goes to recycle, and click every button named in Phase F once more end-to-end.

---

## Appendix A — `liquid-glass-button.tsx` (full source, reference for Phase G)

```tsx
"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center cursor-pointer justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-primary-foreground hover:bg-destructive/90",
        cool: "dark:inset-shadow-2xs dark:inset-shadow-white/10 bg-linear-to-t border border-b-2 border-zinc-950/40 from-primary to-primary/85 shadow-md shadow-primary/20 ring-1 ring-inset ring-white/25 transition-[filter] duration-200 hover:brightness-110 active:brightness-90 dark:border-x-0 text-primary-foreground dark:text-primary-foreground dark:border-t-0 dark:border-primary/50 dark:ring-white/5",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants, liquidbuttonVariants, LiquidButton }

const liquidbuttonVariants = cva(
  "inline-flex items-center transition-colors justify-center cursor-pointer gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-transparent hover:scale-105 duration-300 transition text-primary",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 text-xs gap-1.5 px-4 has-[>svg]:px-4",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        xl: "h-12 rounded-md px-8 has-[>svg]:px-6",
        xxl: "h-14 rounded-md px-10 has-[>svg]:px-8",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "xxl",
    },
  }
)

function LiquidButton({
  className,
  variant,
  size,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof liquidbuttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <>
      <Comp
        data-slot="button"
        className={cn(
          "relative",
          liquidbuttonVariants({ variant, size, className })
        )}
        {...props}
      >
        <div className="absolute top-0 left-0 z-0 h-full w-full rounded-full 
            shadow-[0_0_6px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.08),inset_3px_3px_0.5px_-3px_rgba(0,0,0,0.9),inset_-3px_-3px_0.5px_-3px_rgba(0,0,0,0.85),inset_1px_1px_1px_-0.5px_rgba(0,0,0,0.6),inset_-1px_-1px_1px_-0.5px_rgba(0,0,0,0.6),inset_0_0_6px_6px_rgba(0,0,0,0.12),inset_0_0_2px_2px_rgba(0,0,0,0.06),0_0_12px_rgba(255,255,255,0.15)] 
        transition-all 
        dark:shadow-[0_0_8px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.08),inset_3px_3px_0.5px_-3.5px_rgba(255,255,255,0.09),inset_-3px_-3px_0.5px_-3.5px_rgba(255,255,255,0.85),inset_1px_1px_1px_-0.5px_rgba(255,255,255,0.6),inset_-1px_-1px_1px_-0.5px_rgba(255,255,255,0.6),inset_0_0_6px_6px_rgba(255,255,255,0.12),inset_0_0_2px_2px_rgba(255,255,255,0.06),0_0_12px_rgba(0,0,0,0.15)]" />
        <div
          className="absolute top-0 left-0 isolate -z-10 h-full w-full overflow-hidden rounded-md"
          style={{ backdropFilter: 'url("#container-glass")' }}
        />

        <div className="pointer-events-none z-10 ">
          {children}
        </div>
        <GlassFilter />
      </Comp>
    </>
  )
}


function GlassFilter() {
  return (
    <svg className="hidden">
      <defs>
        <filter
          id="container-glass"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.05 0.05"
            numOctaves="1"
            seed="1"
            result="turbulence"
          />

          <feGaussianBlur in="turbulence" stdDeviation="2" result="blurredNoise" />

          <feDisplacementMap
            in="SourceGraphic"
            in2="blurredNoise"
            scale="70"
            xChannelSelector="R"
            yChannelSelector="B"
            result="displaced"
          />

          <feGaussianBlur in="displaced" stdDeviation="4" result="finalBlur" />

          <feComposite in="finalBlur" in2="finalBlur" operator="over" />
        </filter>
      </defs>
    </svg>
  );
}

type ColorVariant =
  | "default"
  | "primary"
  | "success"
  | "error"
  | "gold"
  | "bronze";
 
interface MetalButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ColorVariant;
}
 
const colorVariants: Record<
  ColorVariant,
  {
    outer: string;
    inner: string;
    button: string;
    textColor: string;
    textShadow: string;
  }
> = {
  default: {
    outer: "bg-gradient-to-b from-[#000] to-[#A0A0A0]",
    inner: "bg-gradient-to-b from-[#FAFAFA] via-[#3E3E3E] to-[#E5E5E5]",
    button: "bg-gradient-to-b from-[#B9B9B9] to-[#969696]",
    textColor: "text-white",
    textShadow: "[text-shadow:_0_-1px_0_rgb(80_80_80_/_100%)]",
  },
  primary: {
    outer: "bg-gradient-to-b from-[#000] to-[#A0A0A0]",
    inner: "bg-gradient-to-b from-primary via-secondary to-muted",
    button: "bg-gradient-to-b from-primary to-primary/40",
    textColor: "text-white",
    textShadow: "[text-shadow:_0_-1px_0_rgb(30_58_138_/_100%)]",
  },
  success: {
    outer: "bg-gradient-to-b from-[#005A43] to-[#7CCB9B]",
    inner: "bg-gradient-to-b from-[#E5F8F0] via-[#00352F] to-[#D1F0E6]",
    button: "bg-gradient-to-b from-[#9ADBC8] to-[#3E8F7C]",
    textColor: "text-[#FFF7F0]",
    textShadow: "[text-shadow:_0_-1px_0_rgb(6_78_59_/_100%)]",
  },
  error: {
    outer: "bg-gradient-to-b from-[#5A0000] to-[#FFAEB0]",
    inner: "bg-gradient-to-b from-[#FFDEDE] via-[#680002] to-[#FFE9E9]",
    button: "bg-gradient-to-b from-[#F08D8F] to-[#A45253]",
    textColor: "text-[#FFF7F0]",
    textShadow: "[text-shadow:_0_-1px_0_rgb(146_64_14_/_100%)]",
  },
  gold: {
    outer: "bg-gradient-to-b from-[#917100] to-[#EAD98F]",
    inner: "bg-gradient-to-b from-[#FFFDDD] via-[#856807] to-[#FFF1B3]",
    button: "bg-gradient-to-b from-[#FFEBA1] to-[#9B873F]",
    textColor: "text-[#FFFDE5]",
    textShadow: "[text-shadow:_0_-1px_0_rgb(178_140_2_/_100%)]",
  },
  bronze: {
    outer: "bg-gradient-to-b from-[#864813] to-[#E9B486]",
    inner: "bg-gradient-to-b from-[#EDC5A1] via-[#5F2D01] to-[#FFDEC1]",
    button: "bg-gradient-to-b from-[#FFE3C9] to-[#A36F3D]",
    textColor: "text-[#FFF7F0]",
    textShadow: "[text-shadow:_0_-1px_0_rgb(124_45_18_/_100%)]",
  },
};
 
const metalButtonVariants = (
  variant: ColorVariant = "default",
  isPressed: boolean,
  isHovered: boolean,
  isTouchDevice: boolean,
) => {
  const colors = colorVariants[variant];
  const transitionStyle = "all 250ms cubic-bezier(0.1, 0.4, 0.2, 1)";
 
  return {
    wrapper: cn(
      "relative inline-flex transform-gpu rounded-md p-[1.25px] will-change-transform",
      colors.outer,
    ),
    wrapperStyle: {
      transform: isPressed
        ? "translateY(2.5px) scale(0.99)"
        : "translateY(0) scale(1)",
      boxShadow: isPressed
        ? "0 1px 2px rgba(0, 0, 0, 0.15)"
        : isHovered && !isTouchDevice
          ? "0 4px 12px rgba(0, 0, 0, 0.12)"
          : "0 3px 8px rgba(0, 0, 0, 0.08)",
      transition: transitionStyle,
      transformOrigin: "center center",
    },
    inner: cn(
      "absolute inset-[1px] transform-gpu rounded-lg will-change-transform",
      colors.inner,
    ),
    innerStyle: {
      transition: transitionStyle,
      transformOrigin: "center center",
      filter:
        isHovered && !isPressed && !isTouchDevice ? "brightness(1.05)" : "none",
    },
    button: cn(
      "relative z-10 m-[1px] rounded-md inline-flex h-11 transform-gpu cursor-pointer items-center justify-center overflow-hidden rounded-md px-6 py-2 text-sm leading-none font-semibold will-change-transform outline-none",
      colors.button,
      colors.textColor,
      colors.textShadow,
    ),
    buttonStyle: {
      transform: isPressed ? "scale(0.97)" : "scale(1)",
      transition: transitionStyle,
      transformOrigin: "center center",
      filter:
        isHovered && !isPressed && !isTouchDevice ? "brightness(1.02)" : "none",
    },
  };
};
 
const ShineEffect = ({ isPressed }: { isPressed: boolean }) => {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-20 overflow-hidden transition-opacity duration-300",
        isPressed ? "opacity-20" : "opacity-0",
      )}
    >
      <div className="absolute inset-0 rounded-md bg-gradient-to-r from-transparent via-neutral-100 to-transparent" />
    </div>
  );
};
 
export const MetalButton = React.forwardRef<
  HTMLButtonElement,
  MetalButtonProps
>(({ children, className, variant = "default", ...props }, ref) => {
  const [isPressed, setIsPressed] = React.useState(false);
  const [isHovered, setIsHovered] = React.useState(false);
  const [isTouchDevice, setIsTouchDevice] = React.useState(false);
 
  React.useEffect(() => {
    setIsTouchDevice("ontouchstart" in window || navigator.maxTouchPoints > 0);
  }, []);
 
  const buttonText = children || "Button";
  const variants = metalButtonVariants(
    variant,
    isPressed,
    isHovered,
    isTouchDevice,
  );
 
  const handleInternalMouseDown = () => {
    setIsPressed(true);
  };
  const handleInternalMouseUp = () => {
    setIsPressed(false);
  };
  const handleInternalMouseLeave = () => {
    setIsPressed(false);
    setIsHovered(false);
  };
  const handleInternalMouseEnter = () => {
    if (!isTouchDevice) {
      setIsHovered(true);
    }
  };
  const handleInternalTouchStart = () => {
    setIsPressed(true);
  };
  const handleInternalTouchEnd = () => {
    setIsPressed(false);
  };
  const handleInternalTouchCancel = () => {
    setIsPressed(false);
  };
 
  return (
    <div className={variants.wrapper} style={variants.wrapperStyle}>
      <div className={variants.inner} style={variants.innerStyle}></div>
      <button
        ref={ref}
        className={cn(variants.button, className)}
        style={variants.buttonStyle}
        {...props}
        onMouseDown={handleInternalMouseDown}
        onMouseUp={handleInternalMouseUp}
        onMouseLeave={handleInternalMouseLeave}
        onMouseEnter={handleInternalMouseEnter}
        onTouchStart={handleInternalTouchStart}
        onTouchEnd={handleInternalTouchEnd}
        onTouchCancel={handleInternalTouchCancel}
      >
        <ShineEffect isPressed={isPressed} />
        {buttonText}
        {isHovered && !isPressed && !isTouchDevice && (
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t rounded-lg from-transparent to-white/5" />
        )}
      </button>
    </div>
  );
});
 
MetalButton.displayName = "MetalButton";
```

**Demo usage:**
```tsx
import { LiquidButton } from "@/components/ui/liquid-glass-button";

export default function DemoOne() {
  return (
    <> 
      <div className="relative h-[200px] w-[800px]"> 
        <LiquidButton className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          Liquid Glass
        </LiquidButton> 
      </div>
    </>
  )
}
```

**Dependencies to install:** `@radix-ui/react-slot`, `class-variance-authority`.

---

## Appendix B — `sonar-grid.tsx` (full source, reference for Phase G / Phase H)

```tsx
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export interface SonarGridProps extends React.ComponentProps<"div"> {
  /** Distance between dots in CSS pixels. */
  spacing?: number
  /** Dot radius at rest, in CSS pixels. */
  dotRadius?: number
  /** Resting dot opacity (0–1). Dots on a wavefront go to 1. */
  baseOpacity?: number
  /** Any CSS color. Defaults to the theme's primary color, so it adapts to light/dark and brand themes. */
  color?: string
  /** Seconds between ambient pings. Set 0 to disable them. */
  pingEvery?: number
  /** Wavefront speed in CSS pixels per second. */
  speed?: number
  /** Thickness of the wavefront in CSS pixels. */
  ringWidth?: number
  /** How much a dot grows at the wave peak (0 = no growth, 2 = triple size). */
  amplitude?: number
  /** Emit a ping where the user taps or clicks. */
  interactive?: boolean
  /** Maximum simultaneous rings. Older rings are dropped first. */
  maxRings?: number
  /** Start with one ring already mid-expansion so the very first frame shows the idea. */
  seedPing?: boolean
  /** Where ambient pings (and the seed ping) may spawn, as fractions of width/height: [x0, y0, x1, y1]. */
  pingArea?: [number, number, number, number]
}

interface Ring {
  x: number
  y: number
  born: number
}

const MAX_DPR = 2
const TAU = Math.PI * 2

/**
 * SonarGrid — a decorative dot field that answers taps with expanding rings.
 * Canvas-based and theme-aware (it reads the resolved `text-primary` color), it idles
 * when no ring is alive, pauses off-screen and in hidden tabs, and renders a still grid
 * under `prefers-reduced-motion`. Children render on top of the field.
 */
export function SonarGrid({
  spacing = 26,
  dotRadius = 1.4,
  baseOpacity = 0.28,
  color,
  pingEvery = 2.4,
  speed = 260,
  ringWidth = 90,
  amplitude = 2.2,
  interactive = true,
  maxRings = 6,
  seedPing = true,
  pingArea = [0.15, 0.2, 0.85, 0.8],
  className,
  children,
  ref,
  ...rest
}: SonarGridProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const ringsRef = React.useRef<Ring[]>([])
  const refreshRef = React.useRef<() => void>(() => {})

  const opts = React.useRef({ spacing, dotRadius, baseOpacity, pingEvery, speed, ringWidth, amplitude, interactive, maxRings, seedPing, pingArea })
  opts.current = { spacing, dotRadius, baseOpacity, pingEvery, speed, ringWidth, amplitude, interactive, maxRings, seedPing, pingArea }

  const setHost = React.useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  React.useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let width = 0
    let height = 0
    let raf = 0
    let timer = 0
    let visible = true
    let seeded = false
    let stroke = ""
    let nextPing = performance.now() + opts.current.pingEvery * 1000

    const readColor = () => {
      stroke = getComputedStyle(canvas).color
    }

    const addRing = (x: number, y: number, born: number) => {
      readColor()
      const rings = ringsRef.current
      rings.push({ x, y, born })
      while (rings.length > opts.current.maxRings) rings.shift()
    }

    const draw = (now: number) => {
      const o = opts.current
      const lifetime = (Math.hypot(width, height) + o.ringWidth) / o.speed
      ringsRef.current = ringsRef.current.filter((r) => (now - r.born) / 1000 < lifetime)
      const live = ringsRef.current.map((r) => {
        const age = (now - r.born) / 1000
        const radius = age * o.speed
        return { x: r.x, y: r.y, radius, reach: radius + o.ringWidth, fade: 1 - age / lifetime }
      })

      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = stroke

      const cols = Math.ceil(width / o.spacing) + 1
      const rows = Math.ceil(height / o.spacing) + 1
      const offsetX = (width - (cols - 1) * o.spacing) / 2
      const offsetY = (height - (rows - 1) * o.spacing) / 2

      const hot: number[] = []
      ctx.globalAlpha = o.baseOpacity
      ctx.beginPath()
      for (let i = 0; i < cols; i++) {
        const cx = offsetX + i * o.spacing
        for (let j = 0; j < rows; j++) {
          const cy = offsetY + j * o.spacing
          let energy = 0
          for (const r of live) {
            if (Math.abs(cx - r.x) > r.reach || Math.abs(cy - r.y) > r.reach) continue
            const dist = Math.abs(Math.hypot(cx - r.x, cy - r.y) - r.radius)
            if (dist >= o.ringWidth) continue
            const t = 1 - dist / o.ringWidth
            const k = t * t * (3 - 2 * t) * r.fade
            if (k > energy) energy = k
          }
          if (energy < 0.01) {
            ctx.moveTo(cx + o.dotRadius, cy)
            ctx.arc(cx, cy, o.dotRadius, 0, TAU)
          } else {
            hot.push(cx, cy, energy)
          }
        }
      }
      ctx.fill()

      for (let k = 0; k < hot.length; k += 3) {
        const energy = hot[k + 2] ?? 0
        ctx.globalAlpha = o.baseOpacity + (1 - o.baseOpacity) * energy
        ctx.beginPath()
        ctx.arc(hot[k] ?? 0, hot[k + 1] ?? 0, o.dotRadius * (1 + o.amplitude * energy), 0, TAU)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const resize = () => {
      const rect = host.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!seeded) {
        seeded = true
        const [x0, y0, x1, y1] = opts.current.pingArea
        if (opts.current.seedPing && !reduceMotion.matches)
          addRing(width * (x0 + (x1 - x0) * 0.68), height * (y0 + (y1 - y0) * 0.34), performance.now() - 500)
      }
      draw(performance.now())
    }

    const scheduleIdle = (delay: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => tick(performance.now()), Math.max(16, delay))
    }

    const tick = (now: number) => {
      raf = 0
      if (!visible || document.hidden) return
      if (reduceMotion.matches) {
        ringsRef.current = []
        draw(now)
        return
      }
      const o = opts.current
      if (o.pingEvery > 0 && now >= nextPing) {
        const [x0, y0, x1, y1] = o.pingArea
        addRing(width * (x0 + Math.random() * (x1 - x0)), height * (y0 + Math.random() * (y1 - y0)), now)
        nextPing = now + o.pingEvery * 1000
      }
      draw(now)
      if (ringsRef.current.length > 0) raf = requestAnimationFrame(tick)
      else if (o.pingEvery > 0) scheduleIdle(nextPing - now)
    }

    const wake = () => {
      if (!raf) {
        window.clearTimeout(timer)
        raf = requestAnimationFrame(tick)
      }
    }

    refreshRef.current = () => {
      readColor()
      nextPing = Math.min(nextPing, performance.now() + opts.current.pingEvery * 1000)
      wake()
    }

    const onDown = (e: PointerEvent) => {
      if (!opts.current.interactive || reduceMotion.matches) return
      const rect = host.getBoundingClientRect()
      addRing(e.clientX - rect.left, e.clientY - rect.top, performance.now())
      wake()
    }
    const onVisibility = () => {
      if (!document.hidden) wake()
    }

    const ro = new ResizeObserver(resize)
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? true
        if (visible) wake()
      },
      { threshold: 0 }
    )
    const mo = new MutationObserver(() => refreshRef.current())

    readColor()
    resize()
    ro.observe(host)
    io.observe(host)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] })
    host.addEventListener("pointerdown", onDown)
    document.addEventListener("visibilitychange", onVisibility)
    reduceMotion.addEventListener("change", wake)
    wake()

    return () => {
      ro.disconnect()
      io.disconnect()
      mo.disconnect()
      host.removeEventListener("pointerdown", onDown)
      document.removeEventListener("visibilitychange", onVisibility)
      reduceMotion.removeEventListener("change", wake)
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      refreshRef.current = () => {}
    }
  }, [])

  React.useEffect(() => {
    refreshRef.current()
  }, [spacing, dotRadius, baseOpacity, color, pingEvery, speed, ringWidth, amplitude, interactive, maxRings, pingArea])

  return (
    <div
      ref={setHost}
      data-slot="sonar-grid"
      className={cn("relative isolate overflow-hidden", interactive && "cursor-crosshair", className)}
      {...rest}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="text-primary pointer-events-none absolute inset-0 -z-10 size-full"
        style={color ? { color } : undefined}
      />
      {children}
    </div>
  )
}

export default SonarGrid
```

**Dependencies (demo only, both already present in this project):** `motion` (for `motion/react`), `lucide-react`. The component itself needs nothing beyond React and the existing `cn()` utility.

---

## Appendix C — Loading Screen Design Brief (for Phase H, restated in full for the implementer)

- **Layout:** full-bleed, no browser chrome visible. Top half: large "Project Console" wordmark, with a small "made by Tobiloba Jagun" credit line positioned just beneath it. Bottom half: live loading-state text (reusing the existing `[boot-state]` stderr signal already wired up in `desktop/main.cjs`) and a live elapsed-time counter.
- **Palette:** blue, red, black, white — the existing dark-theme palette (`#0071E3` blue, `#0D0D0E` black background) plus a red accent not currently used anywhere else in the palette (introduce it specifically for this screen, sourced as a genuine theme-consistent red rather than an arbitrary new hex value — check whether `--color-accent-red` already exists as a token before adding a new one).
- **Interaction:** as the user's mouse moves across the screen, small blocks should move like sand and the color should blend smoothly between the palette colors, similar to the reference mood-board image the user described but did not attach to this merged document. If that reference image is available to you when you begin this phase, check your implementation against it before considering the work done. If it is not available, implement from this text description and flag in the Phase L changelog that the visual should be checked against the original reference once it can be provided.
- **Technical approach:** adapt `sonar-grid.tsx` (Appendix B) per the instructions in H-2 — Canvas 2D, block/rect shapes instead of circular dots, continuous pointer-distance-driven color blend in addition to (or instead of) the existing discrete ping behavior, respecting `prefers-reduced-motion`.
- **Scope:** this loading screen should appear both in the desktop/Electron shell (replacing/restyling the existing `buildSplashHtml` splash) and, per H-1, in the web entry point, which currently has no equivalent at all.
