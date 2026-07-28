# BUG FIX PROMPT — Local Project Console

## Context
Fix **5 critical user-facing bugs** in the Local Project Console. Codebase at `C:\Users\tobil\Downloads\local-project-console (1)`.

---

## 🐛 BUGS TO FIX

### BUG 1: Home screen not scrollable
**File**: `src/components/WelcomeScreen.tsx:24`
**Issue**: `overflow-hidden` prevents scrolling when content overflows
```tsx
// CURRENT (line 24):
<div className="h-full flex flex-col items-center justify-center relative overflow-hidden">
```
**Fix**: Change to `overflow-y-auto` with proper min-height

---

### BUG 2: Quick Start Guide button does nothing
**File**: `src/components/WelcomeScreen.tsx:69-71`
**Issue**: Button has no `onClick` handler
```tsx
// CURRENT:
<button className="flex items-center gap-2 px-6 py-3 bg-white/5 border border-white/10 text-gray-300 rounded-xl font-bold text-sm hover:bg-white/10 transition-colors">
  <BookOpen size={16} /> Quick Start Guide
</button>
```
**Fix**: Add handler to show help/overview or navigate to docs

---

### BUG 3: Session click doesn't auto-select its project
**File**: `src/hooks/useConsole.ts` → `switchSession` (lines 96-111) and `useSessions.ts` `switchSession` (lines 37-53)
**Issue**: When clicking a chat in sidebar, it loads messages but **doesn't switch `activeProject`** to the session's project. User sees wrong project context.

**Current flow**:
1. User clicks session in sidebar → `switchSession(s.id)` called
2. `useSessions.switchSession` fetches session, loads messages
3. Only AFTER does it try: `setActiveProject(projects.find(p => p.id === s.projectId))` — but `projects` is stale closure!

**Fix**: In `useConsole.ts` `handleSelectProject` / `switchSession`, ensure project switch happens BEFORE or atomically with session switch. Pass projectId to `switchSession` so server can validate.

---

### BUG 4: "npm serve" / "npx serve ." / direct commands not recognized → stuck UI
**Files**: Multiple — this is a **matching pipeline gap**

#### 4a: Semantic matcher missing keyword for `npm serve`
**File**: `server/semanticMatcher.js` (keyword fallback, ~lines 273-282)
**Current**: Only matches `/npm\s+run\b/i` — misses `npm serve`, `npm start`, `npm run serve`
```js
// CURRENT (line 273-282):
if (/\bnpm\s+run\b/i.test(inputStr)) {
  kwMatched = true; _stages.push({ stage: 'keyword', intent: 'npm_run', confidence: 0.5, matched: true });
  return { intent: 'npm_run', confidence: 0.5, source: 'keyword' };
}
```

#### 4b: Direct command pattern in connection.js doesn't match `npm serve`
**File**: `server/wsHandlers/connection.js:540`
**Current pattern**: `/^(npx\s+\S+|python\s+\S+|npm\s+(run|start|install|build)\s+\S+|node\s+\S+|tsx\s+\S+)$/i`
- **Misses**: `npm serve` (serve not in group), `npm run serve` (matches but then npm_run handler needs to handle "serve")

#### 4c: `npm_run` handler doesn't extract "serve" script name
**File**: `server/wsHandlers/builtinIntents.js:333-375`
- Regex `/(?:run|execute)\s+(?:the\s+)?["']?(\w+(?:-\w+)*)["']?/i` only catches "run X" patterns
- Doesn't handle "npm serve" → should map to `run_project` or `npm_run` with script="serve"

#### 4d: UI blocks input when stuck (no escape hatch)
**File**: `src/components/Terminal.tsx:497`
```tsx
disabled={!activeProject || isBlocked || aiThinking}
```
- `isBlocked = !!pendingConfirm || !!pendingToolConfirm`
- When a confirmation is pending OR tool confirm pending, **entire input locks**
- User can't cancel, can't type new command, can't switch sessions
- "Cancel in chat or when I go to another chat it's the same issue" — state persists

---

### BUG 5: Session switching doesn't clear pending confirmations
**File**: `src/hooks/useSessions.ts:37-53` `switchSession`
**Issue**: When switching sessions, any pending `confirm_prompt` or `tool_confirm_prompt` from previous session persists and blocks new session.

---

## 🔧 REQUIRED FIXES (Priority Order)

### Fix 1: WelcomeScreen scroll + Quick Start button
```tsx
// src/components/WelcomeScreen.tsx

// Line 24: Change overflow
<div className="h-full flex flex-col items-center justify-center relative overflow-y-auto">

// Lines 69-71: Add onClick
<button 
  onClick={() => { /* trigger help or show quick start modal */ }}
  className="flex items-center gap-2 px-6 py-3 bg-white/5 border border-white/10 text-gray-300 rounded-xl font-bold text-sm hover:bg-white/10 transition-colors"
>
  <BookOpen size={16} /> Quick Start Guide
</button>
```
**Quick Start action**: Call `onSendMessage('help')` or show a modal with key commands.

---

### Fix 2: Session click → auto-select project
```tsx
// src/hooks/useConsole.ts — modify handleSelectProject and switchSession

const handleSelectProject = useCallback(async (p: Project) => {
  projects.setActiveProject(p);
  sessions.setShowWelcome(false);
  if (!sessions.activeSessionId) {
    sessions.createSession(p.id, p.name);
  } else {
    // Link current session to this project
    await sessions.linkSessionToProject(sessions.activeSessionId, p.id);
    sessions.fetchSessions();
  }
  projects.handleSelectProject(p);
}, [projects, sessions]);

// In useSessions.ts switchSession — ensure project switch happens:
const switchSession = useCallback(async (sessionId: string, projects?: Project[]) => {
  setActiveSessionId(sessionId);
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    const data = await res.json();
    if (data.session) {
      const s: StoredSession = data.session;
      setMessages(s.messages.map(m => ({ ... })));
      // CRITICAL: Switch project if session has one
      if (s.projectId && projects) {
        const project = projects.find(p => p.id === s.projectId);
        if (project) setActiveProject(project);
      }
      return s;
    }
  } catch {}
  return null;
}, [projects, setActiveProject]);
```

---

### Fix 3: Add keyword matching for `npm serve`, `npm start`, direct commands
```js
// server/semanticMatcher.js — add to keyword fallback (after line ~282)

if (/\bnpm\s+(serve|start|dev|build|test|install|run)\b/i.test(inputStr)) {
  kwMatched = true; 
  _stages.push({ stage: 'keyword', intent: 'npm_run', confidence: 0.5, matched: true });
  return { intent: 'npm_run', confidence: 0.5, source: 'keyword' };
}
if (/\bnpx\s+serve\b/i.test(inputStr)) {
  kwMatched = true;
  _stages.push({ stage: 'keyword', intent: 'run_project', confidence: 0.5, matched: true });
  return { intent: 'run_project', confidence: 0.5, source: 'keyword' };
}
if (/^(python|node)\s+\S+/i.test(inputStr)) {
  kwMatched = true;
  _stages.push({ stage: 'keyword', intent: 'run_project', confidence: 0.45, matched: true });
  return { intent: 'run_project', confidence: 0.45, source: 'keyword' };
}
```

---

### Fix 4: Expand direct command pattern
```js
// server/wsHandlers/connection.js:540
// CURRENT:
const directCmdPattern = /^(npx\s+\S+|python\s+\S+|npm\s+(run|start|install|build)\s+\S+|node\s+\S+|tsx\s+\S+)$/i;

// FIX: Add serve, allow more npm subcommands
const directCmdPattern = /^(npx\s+\S+|python\s+\S+|npm\s+(run|start|install|build|serve|test|dev)\s+\S*|node\s+\S+|tsx\s+\S+)$/i;
```

---

### Fix 5: `npm_run` handler — handle "serve" script
```js
// server/wsHandlers/builtinIntents.js:333-375 — in npm_run action
// After extracting scriptName, also check for "serve" shortcut
if (!runMatch) {
  // Try "npm serve" or "serve" directly
  const serveMatch = input.match(/\b(?:npm\s+)?serve\b/i);
  if (serveMatch && scripts.serve) {
    executeCommand('npm run serve', project.path, ws, project.id);
    return true;
  }
  // Try "npm start" or "start" directly  
  const startMatch = input.match(/\b(?:npm\s+)?start\b/i);
  if (startMatch && scripts.start) {
    executeCommand('npm start', project.path, ws, project.id);
    return true;
  }
}
```

---

### Fix 6: UI escape hatch — never fully block input
```tsx
// src/components/Terminal.tsx

// Option A: Allow typing even when blocked, but show warning
const isInputDisabled = !activeProject || aiThinking; // REMOVE isBlocked

// Option B: Add "Escape" key to dismiss pending confirmations
const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
  if (e.key === 'Escape' && (pendingConfirm || pendingToolConfirm)) {
    // Send cancel to server
    if (pendingConfirm) onConfirm(false);
    if (pendingToolConfirm) onToolConfirm(false);
    return;
  }
  // ... rest
}, [pendingConfirm, pendingToolConfirm, onConfirm, onToolConfirm, ...]);
```

---

### Fix 7: Clear pending states on session switch
```tsx
// src/hooks/useConsole.ts — in switchSession or handleWebSocketMessage

const switchSession = useCallback(async (sessionId: string) => {
  // Clear any pending confirmations/tool confirms from previous session
  terminal.setPendingConfirm(null);
  terminal.setPendingToolConfirm(null);
  setShowSearchOverlay(false);
  
  setActiveSessionId(sessionId);
  // ... rest
}, [terminal, ...]);
```

---

## 🧪 TEST SCENARIOS

After fixes, verify:

| Scenario | Expected |
|----------|----------|
| Home screen with many projects | Scrollable |
| Click "Quick Start Guide" | Shows help/overview |
| Click session in sidebar for Project A | Loads messages + switches to Project A |
| Type "npm serve" | Runs `npm run serve` (or suggests it) |
| Type "npx serve ." | Runs directly (confirmation) |
| Type "npm start" | Runs `npm start` |
| Long-running command → press Escape | Cancels confirmation / dismisses prompt |
| Switch session while confirmation pending | New session not blocked |

---

## 📋 FILES TO MODIFY

| File | Changes |
|------|---------|
| `src/components/WelcomeScreen.tsx` | Fix scroll, add Quick Start handler |
| `src/hooks/useConsole.ts` | Fix session→project linking, clear pending on switch |
| `src/hooks/useSessions.ts` | Pass projects to switchSession |
| `server/semanticMatcher.js` | Add keyword fallbacks for npm serve/start |
| `server/wsHandlers/connection.js` | Expand directCmdPattern |
| `server/wsHandlers/builtinIntents.js` | Handle serve/start in npm_run |
| `src/components/Terminal.tsx` | Add Escape key handler, don't block input on isBlocked |

---

## ⚠️ SAFETY NOTES
- Don't weaken `isCommandAllowed` or `isCommandBlocked`
- Keep confirmation flow for risky commands
- Escape key should only dismiss UI prompts, not cancel running processes
- Run `npm run lint` after changes