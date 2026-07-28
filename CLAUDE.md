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
  `getProjectInfo`, `getGitStatus`, `undoLastChange`.
- `server/dangerousPatterns.js` — hard blocklist (last resort, not a security boundary)

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

## Safety model — don't weaken this without discussing it first

- AI mode is off by default. The AI ON/OFF toggle in the terminal header is the **sole** opt-in
  gesture — flipping it on sends every subsequent message in that session straight to Ollama, no
  per-query re-confirmation (the old `consent_request` double-gate was removed as pure friction).
- `writeFile`, `editFile`, `insertAtLine`, and any `executeCommand` with `risky: true` from the AI
  path require explicit user approval (`tool_confirm_prompt` → user clicks Approve/Reject) before
  they run — the model cannot self-approve. See `isGatedToolCall()` in `server/tools.js`.
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

## Conventions

- No file over ~400 lines; split by concern (see `server/wsHandlers/` for the pattern).
- Tools/handlers take named-args objects, not positional args.
- New WS message types belong in both `server/wsHandlers/connection.js` (or wherever emits them)
  and the frontend's `useConsole.ts` `handleWebSocketMessage` switch — keep them in sync.
