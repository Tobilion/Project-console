# Local Project Console v4

A local, offline command dispatcher and optional AI assistant for managing multiple software projects from a single web interface. Runs entirely on your machine — zero external API calls (beyond an opt-in Ollama Cloud model, which still proxies through your local Ollama daemon), zero data leaves your computer otherwise.

## Overview

The Console scans `C:\Users\tobil\Desktop\Projects` (or any specified directory) for immediate subfolders that contain at least one of: `console.config.json`, `CLAUDE.md`/`README.md`/`ABOUT-TOBI.md`/`UNIVERSAL_CONTEXT.md`, or a `package.json` (its `scripts` are auto-derived into runnable entries even with no docs at all). A folder with none of those three still isn't invisible — it's recognized if it has real source code in any of ~15 languages, a recognized config file (`Cargo.toml`, `go.mod`, `requirements.txt`, etc.), or a real `.git` directory, and gets an auto-generated summary of its detected stack instead of a hand-authored config. It exposes a web UI (Express + Vite + React 19) and a WebSocket-based chat interface, plus an interactive CLI chat mode, with two modes:

- **Trigger Mode** (default, AI OFF): A multi-stage matching pipeline (embeddings → trained classifier → fuzzy/keyword → a single bounded local-model classification call → suggestions) resolves what you typed into a canned command or answer. No LLM conversation involved, but it can still create/append/read files and run parameterized commands without AI.
- **AI Mode** (opt-in toggle): Every message goes to an Ollama model — local, or an Ollama Cloud model proxied through the same local daemon. The AI has sandboxed file/git tools, persistent cross-session memory, and can read, write, edit, search, and run commands in the active project.

## Key Features

### Core Infrastructure
- **Offline-first**: Node.js + Express backend, React 19 + Vite frontend. No external APIs, no telemetry, no accounts.
- **WebSocket chat**: Real-time bidirectional communication. Streams AI tokens, command output, and server URLs live.
- **Port fallback**: `start.bat` (and `server/index.js` itself) auto-selects the first available port from 3000-3010; the CLI client and frontend both discover whichever port the server actually bound to.
- **CLI client**: `start.bat` also offers an interactive CLI chat mode (no browser needed) — see `server/cli-client.js`. Pass `--dir "<full project path>"` or `--project "<name>"` to skip the interactive picker and jump straight into a known project; invalid picker input now re-prompts instead of silently defaulting to the first project in the list.
- **Folder picker limitation (browser security, not a bug)**: the web UI's folder-browse button can only ever recover a folder *name*, never a full path — that's a hard File API restriction in every browser, Electron-free. The server then searches near the current scan directory for a matching name; for anything else, paste the full absolute path into the scan box directly instead of using Browse. A "can't open this folder, it contains system files" dialog is Chrome's own picker refusing certain protected/system folders — pick a different, plain folder or paste the path instead.
- **Host binding**: Defaults to `127.0.0.1` (local only). Set `HOST=0.0.0.0` for LAN access — but be aware there is no authentication.
- **Cross-platform**: built and tested primarily on Windows, but the server, sandboxed file tools, and safety blocklist are all `process.platform`-aware and work on macOS/Linux too. `start.bat` (port-fallback launcher) is Windows-only — on macOS/Linux just run `npm run dev` directly.
- **Cancellable AI queries**: CPU-only Ollama inference has no built-in time limit — a "Stop" button next to the busy indicator aborts an in-flight AI query or a running trigger-mode shell command mid-stream.
- **Dashboard**: A toggleable per-project status grid showing uncommitted files, recent commits, dev server URLs, and running commands. Polls `/api/dashboard` every 5s with a 30s server-side cache; also re-fetches immediately on any `dashboard_update` WebSocket broadcast (process start/stop, URL detection, or command completion). A green pulsing pill in the header (`N running`) shows the live dev server count from `/api/active-servers` with zero layout shift — no flex reflow when it appears or disappears.

### Trigger Mode (Dispatcher)
- **Multi-stage intent matching**: embedding cosine similarity (all-MiniLM-L6-v2) → a handful of literal pre-checks for confirmed trap phrases (`git init`, `gitignore`, `deploy`) → Fuse.js fuzzy → keyword patterns → NLP.js trained classifier → a single bounded local-model classification call (`localRouter.js`) for phrasings nothing above resolved → suggestion chips. 69 intents with ~2,100 example phrases, split across `server/intents/*.js` category files and merged in `intentsData.js` — the phrase lists are hand-curated, but matching itself is real ML at every stage (a trained local transformer for embeddings, a trained NLP.js classifier, and a logistic-regression confidence model trained on real accept/reject telemetry — see `confidenceModel.js`), and confirmed phrases get promoted into the permanent example set automatically as the console is used (`learningEngine.js`). Run `npm run check-intents` any time to statically scan all example phrases for exact/near-duplicate collisions before they cause a wrong match — complements the live `check collisions` command, which needs a running server.
- **Chit-chat + read-only code Q&A**: greeting/status/gratitude/farewell/identity all give varied canned replies (not the same string every time) with no LLM call. Read-only questions answerable without AI: detected API routes (Express/Flask/FastAPI/Django), which files import/are imported by a given file, monorepo sub-package detection, TODO/FIXME scanning, and largest-files-by-size.
- **Git actions beyond push/commit**: diff, stash/stash-pop, and branch creation, gated the same way every other git action here is (safe/read-only runs immediately, anything that mutates state asks for confirmation first). Deliberately does not include hard reset or force operations.
- **Project-specific triggers**: Commands and answers defined in each project's `console.config.json` are embedded dynamically alongside base intents.
- **Parameterized commands, no AI required**: a `console.config.json` command entry can declare `{placeholder}` params (e.g. `watch --interval {interval}`) — the console asks for missing values in plain chat and substitutes them safely (shell metacharacters rejected regardless of the entry's own pattern) before running. Entries can also declare `requires: [paths]` (checked before running, with clear setup guidance if missing) and a `followUp` field (asks a plain question — e.g. "also watch the network? reply an interval" — before the command starts, using another entry's param).
- **"how do I run/do X"**: the `how_to_run` answer lists every run command the project's docs mention (site + server + services), numbered with source labels, plus every exact `console.config.json` command entry (with param names), deduplicated — so you get the full picture, not just the first documented command.
- **Non-AI file operations**: "create a file called X with the text '...'" / "append to X the text '...'" / "read file X" work with AI mode off — parsed with regex, gated behind the same confirm-before-write flow as any risky command.
- **Multi-intent queries**: "show structure and run tests" is split on conjunctions and both intents are handled.
- **Conversation context**: Remembers the last 5 turns, resolves pronouns ("it", "the main file") and short queries into full intents.
- **Risky command confirmation**: Destructive commands require explicit UI approval with one-time security tokens.
- **Git safety checkpoints**: Before any risky command runs, `git add -A && git commit -m "console-checkpoint: ..."` creates a rollback point.
- **Dangerous pattern blocklist**: Hard-coded patterns for `rm -rf /`, force-pushes, `shutdown`, fork bombs, etc. are rejected outright.
- **Command allowlist**: Only approved executables (`npm`, `node`, `git`, `python`, `npx`, `vite`, etc.) can be run through the console — arbitrary command execution blocked.
- **WebSocket origin check**: WS connections from non-local origins are rejected.
- **Realpath sandbox**: `resolveSafe` resolves symlinks via `realpathSync.native` before checking path escape, preventing symlink-based sandbox escapes.
- **SSRF protection**: `deepResearch` only fetches from allowed hosts (duckduckgo.com).
- **Dev server URL detection**: Command output is scanned for `http://localhost:\d+` URLs and displayed as clickable links in the UI; if the detected URL happens to share a port with the console itself, a heads-up is appended instead of silent confusion.
- **Dev server auto-detach**: Long-running/streaming processes force-detach after a timeout (10s for recognized dev-server commands, 20s for anything else that's still running) — output stops streaming into chat, the process keeps running in the background. Stop with "stop server".
- **Port-in-use handling**: interactive "run on another port?" prompts (CRA/react-scripts) are detected and answered via a normal confirm card; hard `EADDRINUSE` failures get a one-click retry on the next port.
- **Output summarizer**: after a command finishes, a short heuristic callout (exit code, recognized errors, npm package/vuln counts, git result) is appended for anything long enough to be worth summarizing — no LLM involved. Rapid-fire output (e.g. hundreds of per-file git warnings) is buffered/coalesced instead of flooding chat with one bubble per line.

### AI Mode
- **Opt-in toggle**: AI mode is OFF by default. Flipping it ON sends every message in that session to Ollama — no per-query re-consent. Detection order on toggle-on: is Ollama reachable at all → is the internet reachable (prefer an Ollama Cloud model as the default if so) → else fall back to a local model → if neither is available, AI mode fails with a message explaining why. This only picks a *default*; you can always override it via the model picker.
- **Model selection**: Choose any model available in your local Ollama instance, or an Ollama Cloud model (`:cloud`-suffixed, e.g. `deepseek-v4-flash:cloud`, `qwen3.5:cloud`) for heavier requests — cloud models proxy through the same local Ollama daemon (`ollama signin` + internet required), so there's no separate API key or provider integration to configure.
- **Mode picker**: Default / Search / Deep Research / Reason modes modify the system prompt for different AI behaviors.
- **Tool-call loop**: The AI can call sandboxed tools — `readFile`, `writeFile`, `editFile`, `findFiles`, `insertAtLine`, `appendToFile`, `searchCode`, `listFiles`, `getProjectInfo`, `getGitStatus`, `undoLastChange`, `saveMemory`, and `executeCommand` (13 total) — with up to 6 rounds of tool calls.
- **Token streaming**: AI responses stream token-by-token to the UI. `<tool_call>` JSON blocks are intercepted server-side — the user never sees raw JSON.
- **Reasoning/answer separation**: every Ollama call requests `think: true`, so a reasoning-capable model's internal deliberation (`message.thinking`) is kept separate from its actual answer (`message.content`) — only the answer is ever shown as the reply or scanned for tool calls, so a model "thinking out loud" can no longer be mistaken for a finished response or a real tool call. Safe no-op for models without thinking support. The reasoning text itself is now also surfaced live in the UI as a small scrollable italic trace under the "AI is thinking..." spinner — not just the spinner alone.
- **Fabricated-action detection**: if a reply describes a completed mutating action (pushed, committed, deployed, deleted, installed, etc.) in success language but no tool was actually called anywhere in that exchange, an unmissable correction is sent right after — guards against a model inventing a plausible-looking "done ✅" result instead of admitting it never ran anything.
- **Gated tools**: `writeFile`, `editFile`, `insertAtLine`, `appendToFile`, risky `executeCommand`, and judgment-level `saveMemory` calls require explicit user approval before execution; routine `saveMemory` calls run immediately (see Persistent Memory below).
- **Path sandbox**: All file tools are scoped to the active project's directory. Any attempt to resolve outside the project root is rejected.
- **File upload**: Real files can be attached via `FileReader` in the AI input bar for the AI to analyze.
- **Project context injection**: The AI's system prompt includes CLAUDE.md content (~6000 chars), entry-point code snippets, a whole-project repo map (top-level export/function/class names per file plus import/imported-by relationships, so the model can resolve "the config file" or "what uses this" without guessing), detected API routes (Express/Flask/FastAPI/Django), monorepo sub-package detection, and anything saved to persistent memory for that project.
- **Trigger mode reads the README too**: `readmeRunParser.js` collects every run command a project's own docs mention (Install/Usage/Getting Started/Run sections, or any fenced code block — capped at 6), and prefers them over a language-based guess. Ask "how do I run this" (no AI needed) to see all of them; for a site-flavored ask like "run the site", the project helper picks whichever documented command actually *serves* the web app (serve/flask/uvicorn/vite/npm dev shape) instead of blindly taking the first documented one.
- **Self-documenting**: after the AI works out a real run command through trial and error, it's prompted (and structurally reminded via the tool result) to offer saving it as a permanent `console.config.json` entry, so trigger mode can run it without AI next time.

### Persistent Cross-Session AI Memory
- `<project>/.console/memory.md` is a short, capped (200 entries) list of durable facts/preferences/project notes the AI itself decides to save mid-conversation via the `saveMemory` tool — available in later, separate chat sessions, not just the current one.
- Two-tier gating: `importance: "low"` (a stated preference, a project quirk, a correction) writes immediately with no confirmation; `importance: "judgment"` (sensitive, inferred, or uncertain) requires approval through the same confirm-card flow as a file write. Near-duplicate entries are deduplicated automatically.
- Doesn't depend on any locally-running model to decide what's worth saving — it's a plain tool call inside whatever AI-mode conversation is already happening, driven by the system prompt. If AI mode is never used, memory.md stays empty.

### Matching Intelligence (Self-Learning)
- **Near-miss logging** (Layer 1): Every input that hits the command guesser or fallback text is recorded in `data/near-misses/<projectId>.jsonl`. When the user confirms/rejects a guessed command, the entry is marked accepted/rejected. High-confidence patterns (5+ occurrences, ≥80% acceptance) are auto-promoted into real intent examples on every server startup; lower-confidence ones still need `review learning` + `approve suggestions`. Promoted phrases persist to disk (`data/learned-intents.json`) so they survive restarts, and also retrain `nlpEngine.js`'s trained classifier, not just the embedding matcher.
- **Intent telemetry** (Layer 2): Every match logs which pipeline stage won and at what confidence — stored in `data/telemetry/<projectId>.jsonl`. Per-intent statistics are aggregated.
- **Threshold auto-tuning**: Once 12+ real accept/reject outcomes exist, a small trained logistic-regression model (`server/confidenceModel.js` — see "Learned Confidence Model" below) recommends per-intent confidence floors instead of a fixed heuristic; suggestions auto-apply on startup when enough data exists (10+ matches per intent). Manual override with `threshold set <intent> <floor>`.
- **False-positive feedback**: When the user rejects a guessed/gated action, the linked telemetry entry is marked `falsePositive` — this is the real accept/reject label both the heuristic and the learned model train on.
- **Intent collision detection**: `check collisions` compares all intent embedding vectors pairwise and reports any with cosine similarity ≥0.9 — these intents may be hard for the model to distinguish.

### Learned Confidence Model ("Stage 1" ML)
- `server/confidenceModel.js` is a real trained model — logistic regression via plain-JS batch gradient descent, no library, no GPU, no AI model involved. Features: winning stage's confidence, its margin over the runner-up, which stage won, normalized input length. Labels: real accept/reject outcomes from confirm/reject responses.
- Retrains automatically on every server startup and immediately (fire-and-forget) after each new labeled outcome. Below 12 labeled examples it's inactive and everything falls back to the original hardcoded heuristic — zero behavior change for a fresh install.
- Runs independently of Ollama/AI mode entirely — it's supervised learning over data the trigger-mode dispatcher already collects. Check its status any time with `telemetry review` (reports whether it's trained, sample count, last update).

### AI Distillation (Layer 3)
After every AI tool-call loop completes, `server/distillation.js` analyzes the exchange and logs suggestions for trigger-mode improvements:
- **Command entry**: If the AI ran an `npm run <script>` command, suggests adding it as a trigger-mode entry in `console.config.json`.
- **Knowledge entry**: If the AI read a file and produced a substantive explanation (>200 chars), suggests a canned answer entry extracted from that explanation.

Review with `review distillations`, apply with `apply distillation <n>` or `apply all distillations`. Approved entries are written directly to `console.config.json` — the file watcher auto-reloads them.

### Adaptive Context (Layer 4)
`<project>/.console/project-memory.json` accumulates multi-session usage patterns (thresholds scale to how active the project actually is):
- **Command frequency**: Tracks every shell command run. When a command crosses its threshold, the system offers to make it a quick trigger.
- **File edit frequency**: Tracks every file the AI writes/edits. When a file crosses its threshold, the system offers to note it in CLAUDE.md.
- **Repeated questions**: Tracks questions the user asks. When a topic repeats enough, the system offers to add a `## <topic>` section to CLAUDE.md.
- **Candidate additions**: The AI's best answers (>300 chars) are stored as potential CLAUDE.md content.

Review with `review memory`. When thresholds trigger, the system sends a `memory_suggestion` WS event and shows a confirmation card in the UI; the user approves or rejects to append the section.

### Chat Memory (per-session history)
- **Per-project storage**: Session messages are stored inside each project's `.console/sessions/<id>.json` (not a central app-data folder).
- **Human-readable log**: `.console/chat-log.md` is an append-only transcript with `## Title (timestamp)` blocks per session.
- **Git-safe**: `.console/` is automatically added to the project's `.gitignore` when the first session (or memory entry) is created.
- **Central index**: `data/conversations/index.json` is a lightweight lookup table for session listing — no message content, just id/projectPath/title/updatedAt/messageCount.
- **Session migration**: Sessions created before a project was selected fall back to `data/conversations/<id>.json` until a project is known, then migrate into the project's `.console/` folder.
- **Session ↔ project locking**: a session is permanently tied to the project it was created for — always trust the small `projectName` subtitle in the sidebar over the session's title, which can drift from what it's actually about.

This is distinct from the persistent cross-session memory above — session history is per-chat and only visible within that one conversation; `.console/memory.md` is durable facts visible across every future session.

### Project Discovery
- **Auto-detect**: Scans the base directory for project folders containing `console.config.json`, `CLAUDE.md`, `README.md`, `ABOUT-TOBI.md`, or `UNIVERSAL_CONTEXT.md`.
- **Code-only fallback**: a folder with none of the above is no longer invisible — if it has real source files (any of ~15 recognized languages, now including Go/Rust/Java/Ruby/PHP/C#, not just JS/Python), a recognized config file (`Cargo.toml`, `go.mod`, `requirements.txt`, etc.), or a real `.git` directory, it's still discovered with an auto-generated summary of its detected stack.
- **CLAUDE.md priority**: `CLAUDE.md` is always sorted first as the "main doc" regardless of readdir order.
- **Script auto-derivation**: `package.json` scripts are automatically converted into trigger entries (`npm run dev`, `npm run test`, etc.) without needing a `console.config.json`, each gated on `node_modules` existing first (clear "run npm install first" message instead of a raw npm error). Hand-authored entries always win on exact action collision.
- **Codebase indexing**: On project select, `POST /api/projects/:id/index` builds a directory tree, detects languages and entry points across ~7 languages, reads key config files, detects the framework/stack (React, Express, Flask, Django, Spring Boot, Laravel, Vite, etc.), and builds a whole-project repo map of top-level exports/functions/classes (via the real TypeScript compiler API for JS/TS/TSX, falling back to regex for other languages or if parsing fails) plus each file's local imports and reverse "imported by" links, detected API routes, and monorepo sub-package detection.
- **File watcher**: Changes to `console.config.json` on disk are live-reloaded — NLP is retrained and the semantic matcher is rebuilt automatically.

### Web Search / Deep Research
- **DuckDuckGo scraping**: No API key required. Accessible via `GET /api/search?q=` and `GET /api/deep-research?q=`.
- **Frontend toggles**: Search/Deep Research/Reason buttons in the AI input bar modify the AI's behavior for research-heavy queries.

### Folder Picker
- The "Browse for folder" button opens a real native folder dialog (`<input type="file" webkitdirectory>`), but browsers deliberately never expose an absolute path to a web page through it — so it only recovers a folder *name*. The server then looks for a matching folder under the current scan directory or its parent (covers the common case of a sibling folder), and shows a clear error suggesting you paste the full path if it can't find one automatically. For any folder elsewhere on disk, type or paste the full path directly into the text field (e.g. `C:\Users\you\Desktop\SomeFolder`) — that always works.

## Global Quick Start (npx)

No clone, no install. From any project folder on any machine with Node.js installed:

```powershell
npx local-project-console
```

This downloads and launches the console in your browser, scanning the current
directory for projects automatically.

### Codebase Configuration Initializer

To generate a tailored `console.config.json` for the current project:

```powershell
npx local-project-console init
```

The initializer scans the target directory for:
- **npm scripts** (`package.json`) — auto-derived into runnable trigger entries
- **Python projects** — detects Flask, Django, and standalone scripts; suggests
  `flask run`, `python manage.py runserver`, or `python app.py` as appropriate
- **Rust/Cargo** — generates `cargo run` and `cargo test` entries
- **Go modules** — generates `go run .` and `go test ./...` entries

It also generates an **overview** answer entry describing the detected stack
and languages. The resulting `console.config.json` is ready to commit to your
repository so every team member gets the same commands out of the box.

```powershell
git add console.config.json
git commit -m "Add Project Console config for <project-name>"
```

Pass a specific directory instead of the current folder:

```powershell
npx local-project-console init C:\path\to\project
```

## Quick Start (local development)

### Web UI

Double-click `start.bat` in the root folder. It will:
1. Install dependencies if needed.
2. Offer Web UI or CLI Chat mode.
3. Launch the server and open the browser.

Or run manually:
```powershell
Set-Location -Path "C:\Users\tobil\Desktop\project-console"
npm install
npm run dev     # tsx server/index.js, http://127.0.0.1:3000
npm run lint    # tsc --noEmit
```

### Background Daemon (no terminal window)

```powershell
.\scripts\start-daemon.ps1   # Starts hidden, polls until ready, writes port to logs/daemon.port
.\scripts\stop-daemon.ps1    # Stops by killing the process listening on the port
.\scripts\add-to-startup.ps1 # Adds a shortcut to shell:startup so it launches on login
```

The daemon runs `npm run dev` in a hidden window with output redirected to `logs/daemon.log`.
It scans ports 3000-3009 to discover the actual bound port (the server auto-fallbacks if
port 3000 is already in use). Stop is port-based (finds the process by what port it's listening
on), so it works correctly even when the wrapper `cmd.exe` exits before the Node server does.

### Welcome Tour
When the web UI opens to the welcome screen, click **Take the Tour** to launch a 4-step guided
overlay explaining project selection, AI mode activation, and key commands. The tour is a pure
local state machine (no server round-trips, no shared-state mutations) — dismiss at any step via
the X button or the backdrop click.

## AI Setup (Optional)

1. Install Ollama from [ollama.com/download/windows](https://ollama.com/download/windows)
2. Pull a model: `ollama pull qwen2.5-coder:7b` — or, for Ollama Cloud (no download, runs on Ollama's GPUs), run `ollama signin` and pick a `:cloud` model from the dropdown once AI mode is on.
3. Toggle AI ON in the terminal header.

The embedding model (all-MiniLM-L6-v2, ~23MB) downloads automatically on first trigger-mode match and caches at `.cache/xenova/` — no manual setup needed.

## Shell Commands

### Running projects
```
"run the site" / "run the project"   — detects project type, shows suggestion chips
"npx serve ."                        — direct shell command (skips matching pipeline)
"python -m http.server 8080"         — direct shell command
"where is the link" / "link?"        — shows running dev server URL
"stop server" / "kill server"        — stops a running dev server
```

### Learning & telemetry
```
"review learning" / "check learning"       — see near-miss suggestions
"approve suggestions"                      — add all suggested phrases
"approve suggestions 1 3"                  — approve specific ones by index
"telemetry review" / "telemetry stats"     — intent match statistics + learned confidence model status
"telemetry suggest" / "suggest thresholds" — get threshold tuning recommendations (learned or heuristic)
"threshold set <intent> <floor>"           — override confidence floor (e.g. 0.5)
"threshold reset <intent>"                 — restore default (0.6)
"telemetry auto-apply"                     — auto-apply suggestions for this project
"auto apply all"                           — auto-apply for all projects
"check collisions" / "intent collisions"   — find overlapping intent embeddings
```

### AI distillation
```
"review distillations" / "check distillations" — see AI-derived trigger suggestions
"apply distillation 1"                          — apply a specific suggestion
"apply all distillations"                       — apply all pending suggestions
"clear distillations"                           — clear pending records
```

### Project memory
```
"review memory" / "project memory" — usage patterns (frequent commands, files, questions)
```

### Security
```
"stop server" / "kill server" — stop a running dev server process
```

### Clear data
```
"telemetry clear" — reset telemetry data for current project
"clear distillations" — clear AI distillation records
```

## Intent Expansion (Phased)

Trigger-mode intent backlog implemented in phases (spec: `console-intent-expansion-prompt.md`, kept
local — gitignored). Worked **one intent per pass** against a recorded control baseline battery;
every phase re-verifies the baseline byte-for-byte plus the new-intent batteries with a standalone
harness (real modules, real embeddings), `npm run check-intents`, and `npm run lint`.

| Phase | Intents | Status |
|---|---|---|
| 0 | Prep: read pipeline files, build harness, record control baseline | Done |
| 1 | `run_tests`, `project.context.dev_server_status`, `file_find` | Done (harness-verified, not yet live-chat-verified) |
| 2 | `git_fetch`, `git_ahead_behind`, `git_tag`, `project.workflow.checkpoint`, `project.context.recent_activity` | Done (harness-verified, not yet live-chat-verified) |
| 3 | `system.chit_chat.needs_ai_mode`, `git_stash_list` | Done (harness-verified, not yet live-chat-verified) |
| 2 (chit-chat) | `system.chit_chat.ack`, `system.chit_chat.joke`, widened pools + time-of-day | Done (harness-verified) |
| 3 (basics) | `open_in_vscode`, `open_in_explorer`, `open_site`, `copy_path`, `git_remote_info`, `running_processes`, `session_info` | Done (harness-verified, not yet live-chat-verified) |
| 4 | Close-out: CLAUDE.md consolidation, live `check collisions`, final summary | Planned |

**Phase 1 (2026-08-03):**
- **`run_tests`** — executes the project's real test command by marker detection (`package.json`
  `scripts.test` → `npm test`, `Cargo.toml` → `cargo test`, `go.mod` → `go test ./...`,
  `pyproject.toml`/`requirements.txt` → `python -m pytest`); immediate, no confirmation.
  One intentional dispatch change: `run the tests` now runs tests instead of answering about them
  (`project.context.tests` stays question-shaped, and the spec's "forbidden" action-flavored
  phrases — `execute tests`, `kick off the tests`, etc. — remain owned by that informational
  intent).
- **`project.context.dev_server_status`** — "is the server running" / "is the site live" /
  "what port is the dev server on" answer from `runningProcesses` + `state.lastDevUrls` (same
  data as the link pre-check), with the port-collision warning. Read-only, immediate. Note:
  `what port is the server on` is excluded — `system.chit_chat.port` already owns that exact
  phrase. Pre-checked URL shapes (`what is the url`, `whats the url`, `what is the url of the
  server`, `what url is it on`) are deliberately not example seeds — the connection.js link
  pre-check owns them live, and `whats the url` was measured at 0.734 for the unrelated
  `what is the link` input. One documented harness deviation from the baseline battery: `what is
  the link` now routes here instead of `project.knowledge.stack` — forced by the spec's own seed
  `what is the server link` (~0.85, can't drop below the floor); live behavior is unchanged since
  the pre-check intercepts it before the matcher.
- **`file_find`** — "where is main.py" / "find the config file": parses the name loosely and runs
  the sandboxed `findFiles()` tool; caps results at 15. Read-only, immediate.
- Supporting fixes: `parseFileNameOnly` widened for the "the \<name\> file" shape (both `file_read`
  and `file_find`); a measured `PRE_SEMANTIC_OVERRIDES` literal routes "who uses X" to
  `project.context.file_relations` (without it, the new `file_find` intent stole that documented
  intent's territory — measured 0.826 vs 0.770); `run_tests` strips the keyFiles truncation marker
  before parsing `package.json` (codebase convention).
- Verification status: **harness-verified only** (49/49 dispatch + handler checks against real
  modules and real NetPulse `console.config.json` entries — the spec §4.3 control battery plus
  per-intent and adjacent batteries, with the one documented `what is the link` deviation above).
  Not yet re-verified through a live chat session — that's the Phase 4 close-out step.

**Phase 2 (2026-08-03):**
- **`git_fetch`** — read-only `git fetch` (updates remote-tracking refs, never touches the
  working tree); immediate. No `pull`-shaped phrases — `git_pull` owns those.
- **`git_ahead_behind`** — "am I behind origin": runs `git status -sb` (prints the
  `[origin/main: ahead 2, behind 1]` bracket directly); read-only, immediate.
- **`git_tag`** — no name → `git tag` list (immediate); a name → `git tag <name>` behind the
  standard confirm flow, with the same `isSafeParamValue` injection check as `git_branch_create`
  applied before the prompt. The name regex is character-class-bounded, so shell metacharacters
  can't even enter the captured name.
- **`project.workflow.checkpoint`** — explicit user-asked checkpoint commit via the same
  `createCheckpoint` the auto-checkpoint-before-risky-commands flow uses; immediate (recoverable
  commit). Non-git projects get `createCheckpoint`'s own "not a git repository" message.
- **`project.context.recent_activity`** — "what files changed recently": on-demand file-mtime
  scan (`findRecentActivity()` in `codebaseIndexer.js`, same ignore conventions as the biggest-
  files/todos scans), answers about file modification times on disk, distinct from `git status`
  (working tree) and `git log` (commits).
- Verification status: **harness-verified only** (98/98 — full Phase-1 control battery unchanged
  + 5 new batteries + adjacent must-not-steal checks). Live chat verification pending (Phase 4).

**Phase 3 (2026-08-03):**
- **`system.chit_chat.needs_ai_mode`** — "turn on ai mode" / "ask the ai" / "can the ai do this"
  with AI off previously scattered onto unrelated intents (identity/structure/commands) or the
  fallback. The AI toggle is a frontend-only control, so this intent answers with guidance
  pointing at the header AI toggle (varied canned replies, immediate). Registered in both
  `BUILTIN_INTENTS` and `PURE_CHITCHAT_INTENTS` — the double registration matters: it's a
  zero-argument safe-sounding canned reply, so garbled input gets the same guard as
  greeting/gratitude.
- **`git_stash_list`** — read-only `git stash list` (same immediate treatment as `git log`/
  `git branch`, same isGitRepo gate as `git stash`); the pre-existing `git_stash`/`git_stash_pop`
  clusters used to absorb these question-shaped phrasings.
- Verification status: **harness-verified only** (133/133 — the full 98-input Phase-2 battery kept
  as regression, all still green, plus 2 new batteries + 6 more adjacent must-not-steal checks).
  Live chat verification pending (Phase 4).

**Phase 2 — Chit-Chat Expansion (2026-08-03):**
- **`system.chit_chat.ack`** — brief acknowledgment replies ("nice", "cool", "great", "perfect",
  "good stuff", "sweet", "nice work", "awesome work", etc.). 11 examples. Handler picks from 5
  varied replies. Confirm-prompt responses go through `handleConfirmResponse`, NOT the matcher —
  these can never approve a pending command.
- **`system.chit_chat.joke`** — 8 deterministic programmer jokes (no network, no AI): dark mode
  bugs, binary people, SQL bar join, developer cache, hardware/software, debugging needles, "works
  on my machine", Java/C# glasses. Handler uses `pickRandom`.
- **Greeting handler widened**: added time-of-day opener (morning/afternoon/evening/night via
  `new Date().getHours()`) as an extra `pickRandom` element; pool expanded from ~5 to 10+
  variants.
- **Status pool widened**: added `'you there', 'you still there', 'still there', 'are you there',
  'are you awake', 'still alive', 'ping', 'pong', 'everything running', 'all good still',
  'how is the project', 'console status', 'are you up', 'system status'`.
- **Gratitude pool widened**: added `'good job', 'nice work', 'great job', 'well done'` —
  ownership clean: praise → gratitude, acks → ack.
- **Farewell pool widened** from 10 to ~20 variants.
- All new chit-chat intents registered in BOTH `BUILTIN_INTENTS` AND `PURE_CHITCHAT_INTENTS`
  (the garbled-input guard set — missing either = unreachable or unguarded).
- `npm run check-intents`: zero NEW exact/near dupes (pre-existing ones left per owner rule).
- Full harness: CONTROL battery byte-identical, all new + adjacent batteries green (159/159).
- Verified: harness + lint + check-intents all pass.

**Phase 3 — Trigger-Mode Basic Calls (2026-08-03):** Seven deterministic, immediate,
non-destructive "do this for me" intents — no confirm flow, no AI, no new WS round-trips beyond one
new frontend event. All registered in `BUILTIN_INTENTS`.
- **`project.action.open_in_vscode`** — spawns `code <project.path>` (detached, `stdio: ignore`);
  if the CLI isn't on PATH, answers with File → Open Folder guidance instead of the raw error.
- **`project.action.open_in_explorer`** — spawns the OS file explorer, branching on platform
  (`explorer` on Windows, `open` on macOS, `xdg-open` on Linux).
- **`project.action.open_site`** — reads `state.lastDevUrls`; with no recorded URL it answers
  guidance ("run the site" / "what is the link"), never spawns. With one, opens the browser
  (`start`/`open`/`xdg-open`).
- **`project.action.copy_path`** — emits a new `copy_to_clipboard` WS event (`useConsole.ts` has
  the `navigator.clipboard` handler) + an answer showing the path. The only Phase-3 intent with a
  frontend counterpart.
- **`git_remote_info`** — read-only `git remote -v`, same `isGitRepo` gate as `git_diff`;
  answers "not a git repo yet" instead of throwing.
- **`project.context.running_processes`** — GLOBAL listing across all projects from the shared
  `runningProcesses` map + `lastDevUrls` (command, URL, since-when). Distinct from
  `dev_server_status` (question-shaped "is it running", one project) — this one lists everything.
- **`project.context.session_info`** — session count + most recent 3 from the central
  `conversationStore` index (read-only).
- Wiring note: `copy_to_clipboard` is the one new WS message type — server emits it,
  `useConsole.ts`'s `handleWebSocketMessage` switch handles it (kept in sync per conventions).
- Measured seed-trimming: `open the site` / `open the website` were removed from `open_site`'s
  examples — exact cross-intent dupes with `run_project` (pre-existing owner keeps them, verified
  via check-intents before/after).
- Verification status: **harness-verified only** (280/280 — the full 133-input Phase-3 battery kept
  as regression, all green, plus 7 new batteries = 120 new dispatch checks + 7 handler-shape checks
  + 21 new adjacent must-not-steal checks). Three adjacent probes were investigated and confirmed
  **pre-existing** (byte-identical at the pre-Phase-3 commit, deliberately not fixed here): (1)
  `open the project` → the stage-1b config-entry floor (0.590 vs the fake `test project` trigger
  ≥ 0.55) diverts it to pytest instead of staying on `run_project` — same documented trade-off
  class as `run this project` 0.517 in matcher.js; (2) `git remote add origin <url>` never reaches
  the matcher in the live app (connection.js's typed-command bypass runs it directly), so the
  harness's `git_status` misroute is unreachable in production; (3) `what is the dev url` is an
  unseeded shape that slips past both the link pre-check regex and `dev_server_status`'s
  deliberately-excluded "what is the url" family → NLP-stage misroute to `stack`. Live chat
  verification pending (Phase 4).

## Architecture

```
server/
├── index.js                  — Orchestrator. Routes, WS init, project discovery. Shares one
│                                http.Server between Express and Vite's dev middleware so Vite's
│                                own HMR websocket isn't destroyed by the app's WS upgrade filter.
│                                Also runs the confidence-model retrain + threshold/near-miss
│                                auto-apply sweeps on startup.
├── state.js                  — Shared mutable state + confirmation TTL sweeps.
├── wsServer.js                — WebSocket singleton + broadcast().
├── matcher.js                 — matchInput() pipeline: multi-intent → semantic → NLP → local
│                                router → fallback.
├── semanticMatcher.js         — Embedding + Fuse.js matching engine + PRE_SEMANTIC_OVERRIDES.
├── localRouter.js             — Bounded, single-call local-model classification tier (last
│                                resort before giving up, independent of the AI-mode toggle).
├── intentsData.js             — Merges 69 intents (~2,100 phrases) from server/intents/*.js.
├── scripts/checkIntentDuplicates.js — `npm run check-intents`: static exact/near-duplicate
│                                phrase scanner, no server needed.
├── nlpEngine.js                — NLP.js classifier; retrains from confirmed near-miss promotions.
├── learnedIntents.js           — Persists near-miss-promoted phrases across restarts.
├── commandGuesser.js           — Regex-pattern best-guess fallback (OS-aware).
├── contextResolver.js          — Last-5-turn pronoun resolution.
├── contextInjector.js          — Codebase context enrichment per intent type.
├── paramCommand.js             — Parameterized trigger-mode commands ({placeholder} params,
│                                safe substitution, no AI needed).
├── tools.js                    — 12 sandboxed file/git/memory tools for AI mode.
├── memoryStore.js              — Persistent cross-session AI memory (.console/memory.md).
├── confidenceModel.js          — Learned confidence model (Stage 1 ML — logistic regression).
├── ollama.js                   — REST client for localhost:11434, local + Cloud models.
├── ollamaContext.js            — System prompt builder: tool defs, 5 AI modes, repo map,
│                                memory injection.
├── projectScanner.js           — Discovers projects, reads CLAUDE.md/README.md/context files.
├── scriptEntries.js            — Auto-derives config entries from package.json scripts.
├── codebaseIndexer.js          — Directory tree, language/entry-point detection, repo map.
├── configInitializer.js        — Codebase config initializer (`npx local-project-console init`).
│                                Scans target directory for stack markers (npm, Python, Rust, Go)
│                                and generates a tailored console.config.json.
├── conversationStore.js        — Session CRUD + .console/ management + gitignore helper.
├── executor.js                 — Shell command spawner, URL detection, port-retry, buffered
│                                output streaming. `windowsHide: true` prevents flashing cmd
│                                windows in daemon/background modes (Windows only).
├── outputSummarizer.js         — Post-command heuristic summary (errors/warnings/results).
├── dangerousPatterns.js        — Hard blocklist (force-push, rm -rf, shutdown, etc.).
├── gitSafety.js                — Checkpoint commits + undo.
├── webSearch.js                — DuckDuckGo HTML scraping.
├── fileWatcher.js               — chokidar watcher for console.config.json changes.
├── nearMissLogger.js            — Layer 1: near-miss recording.
├── learningEngine.js            — Layer 1: suggestion generation, phrase injection.
├── intentTelemetry.js           — Layer 2: match-stage logging, threshold overrides, auto-tune
│                                (now backed by confidenceModel.js when enough data exists).
├── distillation.js              — Layer 3: AI exchange analysis, config entry suggestions.
├── projectMemory.js             — Layer 4: usage tracking, CLAUDE.md augmentation.
├── readmeRunParser.js           — Trigger-mode README/CLAUDE.md parser for run command discovery.
├── mockProjects.js              — Fake project seeder for non-Windows dev.
├── routes/                      — projectRoutes, sessionRoutes, searchRoutes, monitoringRoutes
│                                  (`/api/metrics`, `/api/active-servers`, `/api/dashboard`).
├── wsHandlers/                  — connection.js, builtinIntents.js, matchedEntry.js,
│                                  aiQuery.js, aiStream.js.
├── intents/                     — Split intent phrase files (chitChatIntents.js,
│                                  gitIntents.js, projectKnowledgeIntents.js, etc.) merged by
│                                  intentsData.js.
└── scripts/                     — start-daemon.ps1, stop-daemon.ps1, add-to-startup.ps1,
                                   checkIntentDuplicates.js.

src/                          — React 19 + Vite frontend.
├── hooks/useConsole.ts       — All state + WS/fetch handlers.
├── App.tsx                   — Render root, folder picker, WebSocket init, fullscreen chat.
├── components/ErrorBoundary.tsx — Top-level safety net; catches render-time exceptions instead
│                                of letting the whole app unmount to a blank white page.
├── components/               — Terminal, WelcomeScreen, BentoGrid, SpotlightCard, Dashboard.
├── components/ui/            — AIAssistantInterface with search/research/reason toggles.
└── types.ts                  — Project, TerminalMessage, ChatSession, etc.

bin/cli.js                    — npm binary entry point (`npx local-project-console`). Parses
│                                commands, launches production server, polls
│                                `globalThis.__consoleServerPort`, auto-opens browser.
start.bat                     — Launcher with mode selection + port fallback.
server/cli-client.js          — Interactive CLI chat mode (no browser), with server auto-discovery.
scripts/                       — Daemon launchers (start-daemon.ps1, stop-daemon.ps1,
                                  add-to-startup.ps1).
```
