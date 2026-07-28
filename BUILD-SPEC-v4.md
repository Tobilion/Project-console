# Build Spec v4 — Local Offline AI Console

Upgrade the Local Project Console from a trigger-to-action dispatcher into a **true offline AI assistant** that understands natural language, reads/writes/edits files, and manages all projects autonomously.

---

## Core Principle: AI is Opt-In Only

The LLM (Ollama) is **never used by default**. The system always starts in **offline trigger mode** (current behavior). AI features only activate when you explicitly choose to:

1. **Global toggle** — a UI switch at the top of the console to enable/disable AI mode
2. **Per-query opt-in** — when the trigger system finds "no match", instead of just showing suggestions, it asks: *"No trigger matched. Want me to try the local AI with this?"*
3. **Transparent** — every AI action (file read, file write, command execution) is shown in the chat before it happens

This means the existing trigger system stays as the primary path. The AI is a secondary, explicitly-invoked fallback.

## Architecture Overview (Before vs After)

```
BEFORE (always):                      AFTER (opt-in AI mode):
User Input                             User Input → [AI Toggle ON?]
  ↓                                       ├── NO → [Same as Before]
NLP Classifier (node-nlp)                 └── YES → LLM (Ollama local)
  ↓                                                   ↓
  ├─ Builtin (greeting, help...)                 ├─ Natural conversation
  ├─ Trigger match (config.json)                 ├─ Tool calls (read/write/exec)
  └─ "No match" suggestions                      └─ Project knowledge queries
```

---

## Phase 1: Ollama Integration (Foundation)

### 1.1 Install & Configure Ollama (Optional — Only If You Enable AI)

```powershell
# Download from ollama.com, then:
ollama pull qwen2.5-coder:7b   # 8GB RAM minimum
# or
ollama pull qwen2.5-coder:14b  # 16GB RAM recommended sweet spot
```

The server detects if Ollama is running at `http://localhost:11434` on startup. If unavailable, AI mode is greyed out and the system works exactly as it does today. No dependency, no crash.

### 1.2 Backend: Ollama Client Module

**New file: `server/llmClient.js`** (~120 lines)

```
Purpose: Wrapper around Ollama's REST API (http://localhost:11434/api/chat).
         Handles streaming, tool call parsing, conversation history.

Responsibilities:
- sendMessage(messages, tools, onToken) — streams response tokens to callback
- parseToolCalls(response) — extracts structured tool requests from LLM output
- buildSystemPrompt(projects) — generates context-aware system prompt with:
  * Available projects (name, path, config entries)
  * Available tools and their schemas
  * Current date/time
  * User identity (Tobi)
- manageConversationHistory(sessionId) — keeps last N exchanges for context
- handleEmbeddings — optional: embed project files for RAG-based Q&A

API call format:
  POST http://localhost:11434/api/chat
  {
    "model": "qwen2.5-coder:7b",
    "messages": [...],
    "stream": true,
    "tools": [...]
  }
```

### 1.3 Tool Definitions

**New file: `server/tools.js`** (~200 lines)

Define the tool schemas the LLM can call (OpenAI-compatible function-calling format):

| Tool | Description | Parameters |
|---|---|---|
| `readFile` | Read file contents | `path: string` |
| `writeFile` | Write/replace a file | `path: string, content: string` |
| `editFile` | Find-and-replace edit | `path: string, oldString: string, newString: string` |
| `searchCode` | Grep for pattern in project | `projectId: string, pattern: string, include?: string` |
| `listFiles` | List directory contents | `path: string, pattern?: string` |
| `executeCommand` | Run shell command in project | `projectId: string, command: string, risky?: boolean` |
| `getProjectInfo` | Get project overview | `projectId: string` |
| `getGitStatus` | Git status for project | `projectId: string` |
| `undoLastChange` | Rollback last git checkpoint | `projectId: string` |

Each tool function:
1. Validates inputs
2. Executes the operation
3. Returns structured result `{ success: boolean, data: any, error?: string }`
4. Respects the existing safety layer (dangerous patterns, risky confirmation)

---

## Ollama Is Free & Local (Not External AI)

To be explicit about the model I'm recommending:

| Concern | How It's Met |
|---|---|
| **Cost** | $0. Ollama is MIT open-source. Models are free (Qwen, DeepSeek, Llama — all open-weight). |
| **Offline** | Runs 100% on your machine. Kill the internet and it still works. No API calls. |
| **Data privacy** | Zero data leaves your PC. No telemetry, no accounts, no cloud. |
| **External AI call?** | Only if you explicitly toggle AI mode and type a query. The default path (trigger matching) never touches any LLM. |
| **Hardware** | Qwen2.5-Coder 7B runs on 8GB RAM. If your machine can't run it, AI mode simply stays disabled. |

If you ever want to use a cloud model (Claude, GPT) instead, the spec supports that as a secondary provider — but **only after the system asks "This requires an external API call. Allow?"** and you confirm.

## Phase 2: Rebuild Message Pipeline

### AI Toggle & Consent Flow in Frontend

Add to `src/App.tsx` and `src/components/Terminal.tsx`:

1. **Global AI toggle** — a switch in the header: `[AI Mode: Off ● / On ○]`. Default: OFF.
2. **When AI mode is OFF** — system behaves exactly as today. No LLM touched.
3. **When AI mode is ON** — unmatched queries show: *"No trigger found. Use local AI to handle this? [Yes] [No]"* before any LLM call. If No, falls back to suggestions.
4. **External provider consent** — if you configure a cloud model (Claude, GPT), every query requiring it shows: *"This needs an external API call to [provider]. Allow? [Yes — this time] [Yes — always for this session] [No]"*
5. **File edit approval** — before any write/edit tool executes, the chat shows a preview diff with [Apply] [Reject] buttons.

### 2.2 New Execution Flow in `server/index.js`

Replace the current `ws.on('message')` handler with a **dual-path router**:

```
User Message
    ↓
  [LLM Available?] ──No──→ [Fallback to old NLP classifier + trigger matching]
    ↓ Yes
  [Build context: active project, file tree, conversation history]
    ↓
  [Send to Ollama API with tools]
    ↓
  [Stream tokens to frontend]
    ↓
  [LLM responds with text OR tool call]
    ├─ Text → Display in chat
    └─ Tool call → Execute tool → Send result back to LLM → Continue loop
```

**Key changes:**
- Remove the `matchInput` / NLP-first routing
- Keep the safety layer (dangerous patterns check) inside each tool
- Keep the git checkpoint system tied to `executeCommand` tool
- Add a timeout/limit on tool-call loops (max 10 iterations to prevent infinite loops)

### 2.2 Frontend: Streaming Response Handler

Update `src/components/Terminal.tsx` to handle:

- **Streaming token chunks** — render tokens as they arrive (typewriter effect)
- **Tool call notifications** — show "🧰 Reading file src/engine/odds.ts..." inline
- **Tool results** — collapse long results behind "Show output" toggle
- **Code diffs** — render file edits with a diff view (added green, removed red)
- **Markdown rendering** — already partially supported via `react-markdown`

New WebSocket message types:

```json
{ "type": "token", "data": "partial tokens..." }
{ "type": "tool_start", "data": { "tool": "readFile", "args": {...} } }
{ "type": "tool_end", "data": { "tool": "readFile", "result": {...} } }
{ "type": "diff", "data": { "path": "src/file.ts", "added": [...], "removed": [...] } }
```

---

## Phase 3: File Operations & Project Awareness

### 3.1 Codebase Indexer

**New file: `server/codebaseIndexer.js`** (~150 lines)

On project scan, build a lightweight index of each project:

```
project-id/
  structure: tree of files (max depth 3, exclude node_modules, .git, venv, dist)
  key-files: contents of README.md, CLAUDE.md, package.json, console.config.json
  languages: detected languages and their file counts
  entry-points: main files (index.js, main.tsx, App.tsx, main.py, etc.)
```

This index is sent as **system prompt context** so the LLM knows what each project contains without needing to explore from scratch.

### 3.2 File Edit Safety

Implement the **Aider-style edit format** for file modifications:

```
path/to/file.ts
<<<<<<< SEARCH
old code to replace
=======
new code
>>>>>>>
```

The `editFile` tool:
1. Finds the SEARCH block in the file
2. If not found, tries fuzzy matching (line proximity, whitespace tolerance)
3. Reports exact match failure if too ambiguous
4. Applies the replacement
5. Verifies file integrity after write (checks truncation — relevant to Tobi's recurring issue)

### 3.3 Read-Only File Preview

Add a file preview panel to the frontend alongside the terminal:
- Shows the file being edited with syntax highlighting
- Updates in real-time as edits stream in
- Toggle between preview and terminal views

---

## Phase 4: Advanced Features (from v4 spec)

### 4.1 File System Watcher

**New file: `server/fileWatcher.js`** (~80 lines)

```javascript
import chokidar from 'chokidar';

export function watchProjectConfigs(projectsDir, onConfigChange) {
  const watcher = chokidar.watch('**/console.config.json', {
    cwd: projectsDir,
    ignoreInitial: true
  });
  watcher.on('change', (filePath) => {
    onConfigChange(filePath);
    // Re-scan that project, update cache, notify frontend
  });
  return watcher;
}
```

### 4.2 Cross-Project Global Commands

Add a virtual "All Projects" project in the frontend. When selected, user queries like "show me git status of all projects" go through the LLM, which calls `getGitStatus` for each project and aggregates results.

Alternatively: reserve a special prefix `@global` or `*` that routes to the aggregation handler without needing a project selected.

### 4.3 xterm.js + node-pty (Optional/Advanced)

For interactive terminal sessions (long-running dev servers, `python` REPL, `npm install`):

**Frontend:** `npm install xterm @xterm/xterm @xterm/addon-fit`

**Backend:** `npm install node-pty`

When a long-running command is detected (or explicitly requested), spawn a `node-pty` process and bind it to an xterm.js instance in a modal/split-panel.

---

## Phase 5: Persistence & Memory

### 5.1 Conversation History

Store chat sessions in a local SQLite database (or JSON files):
- Each WebSocket session gets a session ID
- Messages are persisted with timestamps
- LLM conversation context is rebuilt from recent messages on reconnect

**New file: `server/conversationStore.js`** (~100 lines)

### 5.2 Project Memory

The LLM should remember facts learned about each project across sessions:
- "The odds engine is in `src/engine/odds.ts`"
- "Dream Kick uses Three.js r152+"
- Stored as key-value pairs in a project-level JSON file

---

## File Structure (After Upgrade)

```
server/
  index.js                  # Main entry - updated dual-path router
  llmClient.js              # NEW - Ollama API wrapper
  tools.js                  # NEW - Tool definitions and executors
  projectScanner.js         # Keep - update to call codebaseIndexer
  codebaseIndexer.js        # NEW - Builds project context index
  fileWatcher.js            # NEW - Chokidar config watcher
  conversationStore.js      # NEW - SQLite/JSON conversation persistence
  nlpEngine.js              # Keep as fallback
  executor.js               # Keep - called by tools.executeCommand
  dangerousPatterns.js      # Keep
  gitSafety.js              # Keep
  matcher.js                # Keep as fallback

src/
  App.tsx                   # Updated - add file preview, tool status
  components/
    Terminal.tsx            # Updated - streaming tokens, tool calls, diffs
    FilePreview.tsx         # NEW - syntax-highlighted file viewer
    ProjectMemory.tsx       # NEW - show learned facts about project
    BentoGrid.tsx           # Keep
    SpotlightCard.tsx       # Keep
    TextScramble.tsx        # Keep
    GlowOrbs.tsx            # Keep
  types.ts                  # Updated - new message types
```

---

## Implementation Order

| Step | What | Depends On |
|---|---|---|
| 1 | Install Ollama + pull model | Nothing |
| 2 | Create `server/llmClient.js` | Ollama running |
| 3 | Create `server/tools.js` with readFile, writeFile, executeCommand | llmClient |
| 4 | Update `server/index.js` dual-path router | tools, llmClient |
| 5 | Update frontend for streaming tokens | index.js |
| 6 | Create `server/codebaseIndexer.js` | projectScanner |
| 7 | Add editFile, searchCode, listFiles tools | tools |
| 8 | Add diff rendering to frontend | Terminal.tsx |
| 9 | Create `server/fileWatcher.js` | — |
| 10 | Cross-project global commands | tools |
| 11 | Conversation persistence | — |
| 12 | xterm.js + node-pty (optional) | — |

---

## Acceptance Criteria

The upgrade is complete when:

1. **Natural conversation works** — "hi", "what can you do", "explain CU Bet's odds engine" all produce sensible LLM-generated answers, not pre-configured responses
2. **File editing works** — "add a loading spinner to Terminal.tsx" results in the file being read, edited, and written correctly
3. **Git safety preserved** — risky command execution still creates checkpoints; dangerous patterns still blocked
4. **Project context works** — "what's the tech stack of Dream Kick?" reads package.json and answers correctly
5. **Offline** — kill internet, console still functions fully via Ollama
6. **No files >400 lines** — each module stays clean and separated

---

## Appendix: Example Conversations

**User:** "What's the git status of CU Bet?"
**System:** [calls getGitStatus("cu-bet-simulator")]
**LLM:** "You have 3 modified files in CU Bet:
- `src/engine/odds.ts` (staged)
- `src/components/BetSlip.tsx` (unstaged)
- `package.json` (unstaged)"

---

**User:** "Add a CLI --help flag to Log Analyzer's main.py"
**System:** [reads main.py, edits it, verifies]
**LLM:** "Done. I added argparse argument parsing with --help, --file, and --verbose flags to `main.py`. The help output shows usage info for all available commands. Run `python main.py --help` to test it."

---

**User:** "Why is the portfolio build failing?"
**System:** [runs npm run build, captures error output]
**LLM:** "Build fails because `Spline` component import is wrong in `App.tsx:12`. It says `import Spline from '@splinetool/react-spline'` but the installed version exports it differently. The fix: change to `import { Spline } from '@splinetool/react-spline'`."
