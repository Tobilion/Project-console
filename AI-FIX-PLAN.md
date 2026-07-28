# Fix Plan: 3 User Issues

## Issue 1 — "run dev" should actually run the dev server

### Files to modify:
1. `server/intentsData.js` — Move phrases between intents
2. `server/wsHandlers/builtinIntents.js` — `npm_run` handler may need adjustment

### Changes needed:

**A. In `server/intentsData.js`, remove these phrases from `run_project`:**
```
'run dev', 'npm run dev', 'start the dev server', 'launch the dev server',
'run the dev server', 'start developing', 'run dev server', 'open dev server'
```
Also remove "how do i start this", "how to launch", "how to start" — those are "commands" intent, not "run".

**B. Add these phrases to `npm_run` in the same file:**
```
'run dev', 'npm run dev', 'start dev server', 'start the dev server',
'launch dev server', 'run the dev server', 'start developing',
'run development server', 'start the development server',
'run dev server', 'start the live server', 'start a live server',
'run the live site', 'launch the live site', 'start dev mode',
'run in dev mode'
```

**C. Verify `npm_run` handler in `builtinIntents.js` correctly extracts script names:**
The current regex at line 276:
```javascript
const runMatch = input.match(/(?:run|execute)\s+(?:the\s+)?["']?(\w+(?:-\w+)*)["']?/i);
```
This works for "run dev" but NOT for "start the dev server" or "start a live server". Add another extraction pattern for "start" phrases:
```javascript
// For "start the dev server" or "start a live server"
const startMatch = input.match(/start\s+(?:the\s+|a\s+)?(?:live\s+)?(?:dev\s+)?(?:server|site|app)/i);
```
When startMatch fires, the script is "dev" (for "start dev server") or "start" (for "start the live server" → just `npm start`). Add a mapping:
- "start the dev server", "run dev", "start dev server", etc. → `npm run dev`
- "start the live site", "start the app" → `npm start` (or `npm run dev` depending on project conventions)

Make the handler robust: first extract what kind of server/site, then map to the likely npm script.

---

## Issue 2 — Folder picker for scan path

### Files to modify:
1. `src/App.tsx` — Add hidden directory input + make icon clickable
2. `src/hooks/useConsole.ts` — Add handler for directory-picked event

### Changes needed:

**In `src/App.tsx`:**

Add a hidden `<input>` element for directory selection near the scan form:
```tsx
<input
  ref={folderInputRef}
  type="file"
  webkitdirectory=""
  onChange={handleFolderPick}
  className="hidden"
/>
```

Make the `FolderSearch` icon a clickable button that triggers the input:
```tsx
<button type="button" onClick={() => folderInputRef.current?.click()} className="...">
  <FolderSearch size={18} />
</button>
```

Add `handleFolderPick` function that reads the selected folder path from the file input, sets it as `scanPath`, and optionally auto-submits the scan form.

**Note about `webkitdirectory`:** This attribute opens a native folder picker. The `path` property on the first selected file gives the full path (on Chromium-based browsers including Edge). For Firefox, `webkitdirectory` is supported but path visibility may differ. For broader support, use `nwdirectory` with Electron or fall back to manual typing.

**Caveat:** Browsers intentionally obfuscate the full path for security on `<input type="file">`. Chromium exposes `file.path` in its File API but this is non-standard. The most reliable cross-browser approach is:
1. Try `e.target.files[0].path` (Chromium/Electron) for the folder path
2. If undefined, fall back to `e.target.files[0].webkitRelativePath` and parse it
3. If neither works, keep the text input as fallback

**Alternative (recommended for Electron):** Since this is a local dev tool running on the user's own machine, the cleanest approach is to add an Electron `dialog.showOpenDialog` IPC call. But the current setup is just a browser app served via Vite/Express — so the `webkitdirectory` approach is the best available.

---

## Issue 3 — AI mode feedback and model selector

### Files to modify:
1. `src/components/WelcomeScreen.tsx` — Fix model name rendering
2. `src/hooks/useConsole.ts` — Add toggle confirmation message
3. `src/components/ui/AIAssistantInterface.tsx` or `Terminal.tsx` — Show AI connection status

### Changes needed:

**A. Fix model name in WelcomeScreen (line 44):**
```tsx
// Before:
<Cpu size={14} /> {ollamaStatus.models[0]}
// After:
<Cpu size={14} /> {ollamaStatus.models[0].name}
```

**B. On AI toggle → show confirmation message:**

In `useConsole.ts`, modify `handleAIToggle` to show a system message when AI is turned ON:
```typescript
const handleAIToggle = async () => {
    if (!wsRef.current) return;
    const newState = !aiEnabled;
    wsRef.current.send(JSON.stringify({ type: 'ai_toggle', payload: { enabled: newState } }));
    setAiEnabled(newState);
    
    // When turning ON, check Ollama and show confirmation
    if (newState) {
      try {
        const res = await fetch('/api/ollama/status');
        const status = await res.json();
        if (status.running && status.models?.length > 0) {
          const modelName = status.models[0].name;
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            type: 'system',
            content: `AI Assistant activated — connected to Ollama (model: ${modelName}).\nAll messages will now be handled by the AI. Toggle OFF to return to trigger mode.`
          }]);
        } else if (status.running) {
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            type: 'system',
            content: 'AI Assistant activated — Ollama is running but no models are installed. Run `ollama pull qwen2.5-coder:7b` in a terminal.'
          }]);
        } else {
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            type: 'error',
            content: 'Ollama is not running. Open the Ollama application and try again.'
          }]);
        }
      } catch {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          type: 'error',
          content: 'Could not reach Ollama. Is it installed and running?'
        }]);
      }
    } else {
      // When turning OFF, show confirmation
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        type: 'system',
        content: 'AI Assistant deactivated — returning to trigger mode.'
      }]);
    }
};
```

**C. Test the full AI chat flow:**

After fixing the above, the path should be:
1. Toggle AI ON → confirmation message appears with model name
2. Send "hello" → `handleAIQuery` is called (because `sessionContext.aiEnabled === true`)
3. `checkOllama()` → returns true (Ollama is running)
4. `chatStream()` → calls `POST /api/chat` to Ollama
5. Tokens stream back via `streamWithToolDetection`
6. Response shows up in chat

If step 3 fails → the "Ollama is not running" error message should appear.

If step 4 fails → the `catch` block in `handleAIQuery` shows "AI error: ...".

**D. Model selector in Terminal.tsx:**

The existing dropdown (lines 64-72) uses `ollamaStatus.models.map((m: any) => ...)` which should work for any `OllamaModel[]` array. If models are available it should show them. The dropdown is already connected to `onSetModel` which sends `ai_set_model` via WS. This should already work — verify by checking if `ollamaStatus.models` is actually populated in the user's environment.

---

## Verification checklist

After all changes:

- [ ] "run dev" → executes `npm run dev` instead of printing entry-point info
- [ ] "start a live server" → executes `npm run dev` or equivalent
- [ ] "I mean start a live server" → the context resolver should pick up the previous "run dev" context and map it correctly; if not, "start a live server" should match via the new `npm_run` phrases
- [ ] Clicking folder icon → opens native directory picker → populates scan path
- [ ] Toggling AI ON → shows confirmation message with model name
- [ ] Toggling AI ON → next message routes to Ollama → response appears in chat
- [ ] Toggling AI OFF → shows deactivation message
- [ ] Model selector dropdown shows installed Ollama models
- [ ] Switching model in dropdown → subsequent AI messages use selected model
- [ ] `WelcomeScreen.tsx` no longer renders `[object Object]` for model name
- [ ] `npm run lint` passes (the existing WelcomeScreen error is fixed)
