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

## Architecture

`server/index.js` is a thin orchestrator only — routes and WS logic live elsewhere:

- `server/state.js` — shared mutable state (scan directory, project cache, pending confirmations)
- `server/wsServer.js` — the `wss` instance + `broadcast()`
- `server/mockProjects.js` — seeds fake projects on non-Windows sandboxes
- `server/routes/` — `projectRoutes.js`, `sessionRoutes.js`, `searchRoutes.js`
- `server/wsHandlers/` — `connection.js` (message router), `builtinIntents.js` (canned responses
  + `buildHelpMessage()` prompt library), `matchedEntry.js`, `aiQuery.js` (Ollama tool-call loop),
  `aiStream.js` (token streaming + `<tool_call>` extraction)
- `server/tools.js` — `createProjectTools(project)`: file/git tools **sandboxed to that project's
  directory only** (path-escape attempts are rejected). Named-args, not positional. Tools:
  `readFile`, `writeFile`, `editFile`, `findFiles`, `insertAtLine`, `searchCode`, `listFiles`,
  `getProjectInfo`, `getGitStatus`, `undoLastChange`, `saveMemory`.
- `server/dangerousPatterns.js` — hard blocklist (last resort, not a security boundary)
- `server/confidenceModel.js` — pure-JS logistic regression trained on real accept/reject
  telemetry; see "Learned confidence model" below

Frontend: `src/hooks/useConsole.ts` owns all state + WS/fetch handlers; `src/App.tsx` is
render-only; `src/components/Terminal.tsx` renders chat + the two remaining confirmation card
types (risky command, AI tool approval); `src/components/ui/AIAssistantInterface.tsx` is the
AI-mode input bar (real file upload via `FileReader`, Search/Reason/Deep Research toggles).

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
  clicks Approve/Reject) before they run — the model cannot self-approve. See `isGatedToolCall()`
  in `server/tools.js`. `saveMemory` is the one tool with conditional gating — see "Persistent
  cross-session AI memory" above — approval is required only when the model itself flags a save
  as `importance: 'judgment'`, not for routine low-stakes saves.
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
  (shown as a small subtitle under the chat title in the sidebar in `App.tsx`), never the title
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

## Known gotchas

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
  state.
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

## Conventions

- No file over ~400 lines; split by concern (see `server/wsHandlers/` for the pattern).
- Tools/handlers take named-args objects, not positional args.
- New WS message types belong in both `server/wsHandlers/connection.js` (or wherever emits them)
  and the frontend's `useConsole.ts` `handleWebSocketMessage` switch — keep them in sync.
