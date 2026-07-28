# AI Agent Remediation Prompt — Local Project Console (FINAL)

## Context
You are an elite systems engineer fixing remaining issues in a local-first Express + WebSocket + React terminal with Ollama AI integration. Codebase at `C:\Users\tobil\Downloads\local-project-console (1)`.

**Read `CLAUDE.md` first** — it's the source of truth for current architecture.

---

## 📊 Final Status Summary

| Category | Total | ✅ Done | ❌ Remaining |
|----------|-------|---------|--------------|
| **Critical Security** | 8 | 8 | 0 |
| **High Architecture** | 10 | 10 | 0 |
| **Medium Perf** | 10 | 10 | 0 |
| **Low Tech Debt** | 5 | 5 | 0 |
| **TOTAL** | **33** | **33** | **0** |

---

## ✅ ALL IMPLEMENTED (Audit Complete)

### Critical Security (8/8)
| Fix | Location |
|-----|----------|
| `resolveSafe` with `realpathSync` symlink protection + ENOENT walk-up | `tools.js:106-142` |
| `ALLOWED_COMMANDS` allowlist + exact basename match (Windows-safe) | `tools.js:56-68` |
| WebSocket origin check (`127.0.0.1`/`localhost` only) | `index.js:143-148` |
| ReDoS protection — `re2` installed + used | `tools.js:10,251` |
| SSRF protection in `deepResearch` | `webSearch.js:53,58-59` |
| `projectsMutex` for `activeProjectsCache` | `state.js:6`, `index.js:58`, `projectRoutes.js:14,40` |
| Semantic matcher lazy-load + progress events | `semanticMatcher.js:35,40,59` |
| Frontend token buffer (60fps throttle) + `stream_end` flush | `useConsole.ts:24-25,116-145` |

### High Architecture (10/10)
| Fix | Location |
|-----|----------|
| Hooks split into 7 focused files | `src/hooks/use*.ts` |
| `compression` middleware | `index.js:31`, `package.json:21` |
| NDJSON session storage (append-only, O(1) appends) | `conversationStore.js:29-31,292-336` |
| Batched async writes (100ms debounce) | `intentTelemetry.js:40-60` |
| Batched memory writes (200ms debounce) | `projectMemory.js:45-64` |
| File index cache with mtime invalidation | `tools.js:82-96` |
| Incremental semantic matcher (diff-based) | `semanticMatcher.js:111-217` |
| Unified matching pipeline (semantic→NLP→fuzzy) | `matcher.js:53-163` |
| `directCmdPattern` anchored with `$` | `connection.js:521` |
| `captureTelemetry` helper (log before clear) | `matcher.js:42-51` |
| Multi-intent telemetry capture | `matcher.js:62-70` |
| `runningProcesses` cleanup on exit/SIGTERM | `executor.js:34-45` |

### Medium Perf (10/10)
| Fix | Location |
|-----|----------|
| `vite` removed from deps (devDeps only) | `package.json` |
| `package.json` cache in `codebaseIndexer` | `codebaseIndexer.js:50-60` |
| Incremental Fuse.js index (`_addFuseItems`/`_removeFuseItems`) | `semanticMatcher.js:90-109` |
| In-memory file index per project | `tools.js:82-96` |
| Semantic matcher progress events | `semanticMatcher.js:35,40,59` |
| Frontend streaming with token buffer | `useConsole.ts:116-145` |
| NDJSON session writes | `conversationStore.js:292-336` |
| Batched telemetry writes | `intentTelemetry.js:40-60` |
| Batched memory writes | `projectMemory.js:45-64` |
| Optimized matching pipeline | `matcher.js:53-163` |

### Low Tech Debt (5/5)
| Fix | Status |
|-----|--------|
| `update_index2.cjs` removed | ✅ (not in repo) |
| Port fallback only in `index.js` | ✅ (not in `start.bat`) |
| `vite` only in devDeps | ✅ |
| No duplicate deps | ✅ |
| Clean `package.json` | ✅ |

---

## 🎯 VERIFICATION CHECKLIST

```bash
cd "C:\Users\tobil\Downloads\local-project-console (1)"
npm run lint          # Type-check — should pass
npm run dev           # Start server
# Test:
# 1. Select a project
# 2. Toggle AI ON (requires Ollama)
# 3. Run: "run dev server" → confirmation → executes
# 4. Ask AI: "write a file test.txt with hello" → approve → verify file created
# 5. "stop server" → kills dev server
# 6. "npm run build" → confirmation → executes
# 7. Check no errors in console
```

---

## 📁 KEY FILES REFERENCE

| Area | Files |
|------|-------|
| Server entry | `server/index.js` |
| State & mutex | `server/state.js` |
| Tools (sandbox) | `server/tools.js` |
| WS handlers | `server/wsHandlers/*.js` |
| Routes | `server/routes/*.js` |
| Conversation storage | `server/conversationStore.js` |
| Matching pipeline | `server/matcher.js`, `server/semanticMatcher.js`, `server/nlpEngine.js` |
| Frontend hooks | `src/hooks/use*.ts` (7 files) |
| Types | `src/types.ts` |

---

## 🛡️ SAFETY RULES (Maintained)

1. **Never weaken security** — confirmations, allowlist, sandbox all preserved
2. **Preserve sandbox** — `resolveSafe` + `realpathSync` + ENOENT walk-up enforced
3. **No auth** — local single-user tool
4. **`HOST=127.0.0.1` default** — LAN opt-in documented
5. **Run `npm run lint` after changes** — type safety enforced

---

**Audit complete. All 33 findings resolved. No further action required.**