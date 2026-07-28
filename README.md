# Local Project Console v4

A local, offline command dispatcher and optional AI assistant for managing multiple software projects from a single web interface. Runs entirely on your machine — zero external API calls, zero data leaves your computer.

## Overview

The Console scans `C:\Users\tobil\Desktop\Projects` (or any specified directory) for project folders containing `console.config.json`, `CLAUDE.md`, `README.md`, `ABOUT-TOBI.md`, and `UNIVERSAL_CONTEXT.md`. It exposes a web UI (Express + Vite + React 19) and a WebSocket-based chat interface with two modes:

- **Trigger Mode** (default, AI OFF): Fuzzy-matched command dispatcher. Type "run tests" and it executes `npm test`; ask "what's the architecture?" and it reads from CLAUDE.md. All responses are canned — no LLM involved.
- **AI Mode** (opt-in toggle): Every message goes to a local Ollama model (e.g. `qwen2.5-coder:7b`). The AI has sandboxed file/git tools and can read, write, edit, search, and run commands in the active project.

## Key Features

### Core Infrastructure
- **Offline-first**: Node.js + Express backend, React 19 + Vite frontend. No external APIs, no telemetry, no accounts.
- **WebSocket chat**: Real-time bidirectional communication. Streams AI tokens, command output, and server URLs live.
- **Port fallback**: `start.bat` auto-selects the first available port from 3000-3010.
- **CLI client**: `start.bat` also offers an interactive CLI chat mode (no browser needed).
- **Host binding**: Defaults to `127.0.0.1` (local only). Set `HOST=0.0.0.0` for LAN access — but be aware there is no authentication.
- **Cross-platform**: built and tested primarily on Windows, but the server, sandboxed file tools, and safety blocklist are all `process.platform`-aware and work on macOS/Linux too. `start.bat` (port-fallback launcher) is Windows-only — on macOS/Linux just run `npm run dev` directly.

### Trigger Mode (Dispatcher)
- **Semantic intent matching**: 4-stage pipeline — embedding cosine similarity (all-MiniLM-L6-v2) → Fuse.js fuzzy → keyword patterns → NLP.js. ~41 intents with ~1,065 example phrases.
- **Project-specific triggers**: Commands and answers defined in each project's `console.config.json` are embedded dynamically alongside base intents.
- **Multi-intent queries**: "show structure and run tests" is split on conjunctions and both intents are handled.
- **Conversation context**: Remembers the last 5 turns, resolves pronouns ("it", "the main file") and short queries into full intents.
- **Risky command confirmation**: Destructive commands require explicit UI approval with one-time security tokens.
- **Git safety checkpoints**: Before any risky command runs, `git add -A && git commit -m "console-checkpoint: ..."` creates a rollback point.
- **Dangerous pattern blocklist**: Hard-coded patterns for `rm -rf /`, force-pushes, `shutdown`, fork bombs, etc. are rejected outright.
- **Command allowlist**: Only approved executables (`npm`, `node`, `git`, `python`, `npx`, `vite`, etc.) can be run through the console — arbitrary command execution blocked.
- **WebSocket origin check**: WS connections from non-local origins are rejected.
- **Realpath sandbox**: `resolveSafe` resolves symlinks via `realpathSync.native` before checking path escape, preventing symlink-based sandbox escapes.
- **SSRF protection**: `deepResearch` only fetches from allowed hosts (duckduckgo.com).
- **Dev server URL detection**: Command output is scanned for `http://localhost:\d+` URLs and displayed as clickable links in the UI.
- **Dev server auto-detach**: Long-running processes (`npx serve`, `python -m http.server`, `npm run dev`) auto-detach after URL detection — output stops streaming, the server keeps running in the background. Stop with "stop server".

### AI Mode
- **Opt-in toggle**: AI mode is OFF by default. Flipping it ON sends every message in that session to Ollama — no per-query re-consent. Detection order on toggle-on: is Ollama reachable at all → is the internet reachable (prefer an Ollama Cloud model as the default if so) → else fall back to a local model → if neither is available, AI mode fails with a message explaining why. This only picks a *default*; you can always override it via the model picker.
- **Model selection**: Choose any model available in your local Ollama instance, or an Ollama Cloud model (`:cloud`-suffixed, e.g. `qwen3-coder-480b:cloud`) for heavier requests — cloud models proxy through the same local Ollama daemon (`ollama signin` + internet required), so there's no separate API key or provider integration to configure.
- **Mode picker**: Default / Search / Deep Research / Reason modes modify the system prompt for different AI behaviors.
- **Tool-call loop**: The AI can call sandboxed tools (`readFile`, `writeFile`, `editFile`, `findFiles`, `insertAtLine`, `searchCode`, `listFiles`, `getProjectInfo`, `getGitStatus`, `executeCommand`, `undoLastChange`) with up to 6 rounds of tool calls.
- **Token streaming**: AI responses stream token-by-token to the UI. `<tool_call>` JSON blocks are intercepted server-side — the user never sees raw JSON.
- **Gated tools**: `writeFile`, `editFile`, `insertAtLine`, and risky `executeCommand` require explicit user approval before execution.
- **Path sandbox**: All file tools are scoped to the active project's directory. Any attempt to resolve outside the project root is rejected.
- **File upload**: Real files can be attached via `FileReader` in the AI input bar for the AI to analyze.
- **Project context injection**: The AI's system prompt includes CLAUDE.md content (~6000 chars), entry-point code snippets, and the project's directory structure.

### Matching Intelligence (Self-Learning)
- **Near-miss logging** (Layer 1): Every input that hits the command guesser or fallback text is recorded in `data/near-misses/<projectId>.jsonl`. When the user confirms/rejects a guessed command, the entry is marked accepted/rejected.
- **Learning engine**: When a guess pattern fires 3+ times for the same resolved command, a suggestion is generated to promote the input phrases into the intent's example list. The user reviews via "review learning" and approves via "approve suggestions".
- **Intent telemetry** (Layer 2): Every match logs which pipeline stage won (embedding/fuzzy/keyword) and at what confidence — stored in `data/telemetry/<projectId>.jsonl`. Per-intent statistics are aggregated.
- **Threshold auto-tuning**: Telemetry analysis can suggest per-intent CONFIDENCE_FLOOR adjustments. Suggestions are auto-applied on startup when enough data exists (10+ matches per intent). Manual override with `threshold set <intent> <floor>`.
- **False-positive feedback**: When the user rejects a guessed command, the linked telemetry entry is marked `falsePositive`, which feeds into the threshold suggestion engine.
- **Intent collision detection**: `check collisions` compares all intent embedding vectors pairwise and reports any with cosine similarity ≥0.9 — these intents may be hard for the model to distinguish.

### AI Distillation (Layer 3)
After every AI tool-call loop completes, `server/distillation.js` analyzes the exchange and logs suggestions for trigger-mode improvements:
- **Command entry**: If the AI ran an `npm run <script>` command, suggests adding it as a trigger-mode entry in `console.config.json`.
- **Knowledge entry**: If the AI read a file and produced a substantive explanation (>200 chars), suggests a canned answer entry extracted from that explanation.
- **File pattern**: If the AI created/edited a file, logs the path for future pattern detection.

Review with `review distillations`, apply with `apply distillation <n>` or `apply all distillations`. Approved entries are written directly to `console.config.json` — the file watcher auto-reloads them.

### Adaptive Context (Layer 4)
`<project>/.console/project-memory.json` accumulates multi-session usage patterns:
- **Command frequency**: Tracks every shell command run. When a command hits 20 executions, the system offers to make it a quick trigger.
- **File edit frequency**: Tracks every file the AI writes/edits. When a file hits 10 edits, the system offers to note it in CLAUDE.md.
- **Repeated questions**: Tracks questions the user asks. When a topic appears 3+ times, the system offers to add a `## <topic>` section to CLAUDE.md.
- **Candidate additions**: The AI's best answers (>300 chars) are stored as potential CLAUDE.md content.

Review with `review memory`. When thresholds trigger, the system sends a `memory_suggestion` WS event; the user responds "yes"/"sure" in chat or via a UI button to append the section.

### Chat Memory
- **Per-project storage**: Session messages are stored inside each project's `.console/sessions/<id>.json` (not a central app-data folder).
- **Human-readable log**: `.console/chat-log.md` is an append-only transcript with `## Title (timestamp)` blocks per session.
- **Git-safe**: `.console/` is automatically added to the project's `.gitignore` when the first session is created.
- **Central index**: `data/conversations/index.json` is a lightweight lookup table for session listing — no message content, just id/projectPath/title/updatedAt/messageCount.
- **Session migration**: Sessions created before a project was selected fall back to `data/conversations/<id>.json` until a project is known, then migrate into the project's `.console/` folder.

### Project Discovery
- **Auto-detect**: Scans the base directory for project folders containing `console.config.json`, `CLAUDE.md`, `README.md`, `ABOUT-TOBI.md`, or `UNIVERSAL_CONTEXT.md`.
- **CLAUDE.md priority**: `CLAUDE.md` is always sorted first as the "main doc" regardless of readdir order.
- **Script auto-derivation**: `package.json` scripts are automatically converted into trigger entries (`npm run dev`, `npm run test`, etc.) without needing a `console.config.json`. Hand-authored entries always win on exact action collision.
- **Codebase indexing**: On project select, `POST /api/projects/:id/index` builds a directory tree, detects languages and entry points (Vite/CRA React apps auto-detect `src/App.tsx`), and reads key config files.
- **File watcher**: Changes to `console.config.json` on disk are live-reloaded — NLP is retrained and the semantic matcher is rebuilt automatically.

### Web Search / Deep Research
- **DuckDuckGo scraping**: No API key required. Accessible via `GET /api/search?q=` and `GET /api/deep-research?q=`.
- **Frontend toggles**: Search/Deep Research/Reason buttons in the AI input bar modify the AI's behavior for research-heavy queries.

### Folder Picker
- The "Browse for folder" button opens a real native folder dialog (`<input type="file" webkitdirectory>`), but browsers deliberately never expose an absolute path to a web page through it — so it only recovers a folder *name*. The server then looks for a matching folder under the current scan directory or its parent (covers the common case of a sibling folder), and shows a clear error suggesting you paste the full path if it can't find one automatically. For any folder elsewhere on disk, type or paste the full path directly into the text field (e.g. `C:\Users\you\Desktop\SomeFolder`) — that always works.

## Quick Start

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

## AI Setup (Optional)

1. Install Ollama from [ollama.com/download/windows](https://ollama.com/download/windows)
2. Pull a model: `ollama pull qwen2.5-coder:7b`
3. Toggle AI ON in the terminal header

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
"telemetry review" / "telemetry stats"     — intent match statistics
"telemetry suggest" / "suggest thresholds" — get threshold tuning recommendations
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

## Architecture

```
server/
├── index.js                  — Orchestrator. Routes, WS init, project discovery. Shares one
│                                http.Server between Express and Vite's dev middleware so Vite's
│                                own HMR websocket isn't destroyed by the app's WS upgrade filter.
├── state.js                  — Shared mutable state + confirmation TTL sweeps.
├── wsServer.js               — WebSocket singleton + broadcast().
├── matcher.js                — matchInput() pipeline: multi-intent → semantic → NLP → fallback.
├── semanticMatcher.js        — Embedding + Fuse.js matching engine.
├── intentsData.js            — 41 intents, ~1,065 example phrases (single source of truth).
├── nlpEngine.js              — NLP.js classifier (legacy fallback).
├── commandGuesser.js         — 12 regex patterns for best-guess fallback.
├── contextResolver.js        — Last-5-turn pronoun resolution.
├── contextInjector.js        — Codebase context enrichment per intent type.
├── tools.js                  — 11 sandboxed file/git tools for AI mode.
├── ollama.js                 — REST client for localhost:11434.
├── ollamaContext.js          — System prompt builder with 9 tool defs, 5 AI modes.
├── projectScanner.js         — Discovers projects, reads CLAUDE.md/README.md/context files.
├── scriptEntries.js          — Auto-derives config entries from package.json scripts.
├── codebaseIndexer.js        — Directory tree, language/entry-point detection.
├── conversationStore.js      — Session CRUD + .console/ management.
├── executor.js               — Shell command spawner, URL detection, output streaming.
├── dangerousPatterns.js       — Hard blocklist (force-push, rm -rf, shutdown, etc.).
├── gitSafety.js              — Checkpoint commits + undo.
├── webSearch.js              — DuckDuckGo HTML scraping.
├── fileWatcher.js            — chokidar watcher for console.config.json changes.
├── nearMissLogger.js         — Layer 1: near-miss recording.
├── learningEngine.js         — Layer 1: suggestion generation, phrase injection.
├── intentTelemetry.js        — Layer 2: match-stage logging, threshold overrides, auto-tune.
├── distillation.js           — Layer 3: AI exchange analysis, config entry suggestions.
├── projectMemory.js          — Layer 4: usage tracking, CLAUDE.md augmentation.
├── mockProjects.js           — Fake project seeder for non-Windows dev.
├── routes/                   — projectRoutes, sessionRoutes, searchRoutes.
└── wsHandlers/               — connection.js, builtinIntents.js, matchedEntry.js,
                                aiQuery.js, aiStream.js.

src/                          — React 19 + Vite frontend.
├── hooks/useConsole.ts       — All state + WS/fetch handlers.
├── App.tsx                   — Render root, folder picker, WebSocket init.
├── components/ErrorBoundary.tsx — Top-level safety net; catches render-time exceptions instead
│                                of letting the whole app unmount to a blank white page.
├── components/               — Terminal, WelcomeScreen, BentoGrid, SpotlightCard.
├── components/ui/            — AIAssistantInterface with search/research/reason toggles.
└── types.ts                  — Project, TerminalMessage, ChatSession, etc.

start.bat                     — Launcher with mode selection + port fallback.
server/cli-client.js          — Interactive CLI chat mode (no browser).
```
