# Continuous Chat Test Prompt — High-Volume Tuning for Project Console

Use this as the single prompt to **continuously hammer** the chat, tune intents, and make responses sound human.

## Quick start

```powershell
# one-shot, all 3 modes, ~600 inputs
node --import tsx server/scripts/continuousChatHarness.js

# high-volume: 1000 intent-cover with typos
node --import tsx server/scripts/continuousChatHarness.js --mode intent-cover --count 1000 --typos

# continuous (infinite loop, 200ms between iterations)
node --import tsx server/scripts/continuousChatHarness.js --mode all --count 300 --loop --delay 200

# user-style replay only (your own history → variations)
node --import tsx server/scripts/continuousChatHarness.js --mode user-replay --count 300 --typos

# JSON report for CI / jq
node --import tsx server/scripts/continuousChatHarness.js --json > harness-report.json
```

## The 3 modes

### 1. `random-ai` — how someone talks to an AI
Templates like `hey` / `can you help me with my project` / `make me a todo app` / `I am tired` / `why isnt this working` / `Can you write a function to sort an array?` with:
- filler: `please`, `can you`, `hey`, `so`, `um`, `yo`
- emojis/punct: `!`, `...`, `:)`, `🙏`
- typos: swap/drop/dup/replace (edit distance 1) — `--typos` flag
- case: `lower`, `Title`, `UPPER`

**Goal:** ensure casual chatter never fires `git_push`/`deploy`/`file_delete` (risky-guard holds).

### 2. `intent-cover` — different ways to get the same intent
For every `INTENTS` entry, takes a random example and varies it:
- synonym: `open` ↔ `show`/`launch`, `run` ↔ `start`/`launch`, etc.
- word-order shuffle (3+ words, 20% chance)
- filler prefix/suffix (`please ` / ` for me`)
- typos (`--typos`)
- punct/case

**Goal:** which intents break on paraphrase → add the failing variation as a new example phrase.

### 3. `user-replay` — how *you* talk
Reads `data/conversations/*.ndjson` `user` messages (your real history). If history is sparse, falls back to intent examples. Generates style variations:
- `lowercase`, `please` prefix, `pls` contraction, typo, `can you` → `can u`

**Goal:** tune to your voice; catch the exact phrasings you actually type.

## What the report tells you

```
intent-cover: 145/156 ok (93.0%)  fail=11
fallback (no intent): 23        <- candidates for NEW intents
risky-on-chitchat: 0            <- must stay 0; if >0, fix QUESTION_BLOCKED_INTENTS
Top FAILs:
  'show screensaver for me' exp:system.screensaver.open got:fallback conf:0.420
  -> add 'show screensaver for me' to screensaverIntents.js examples
Fallback cluster:
  'what is': 5 inputs  -> new intent: "what is the meaning of life" style → how_do_i or needs_ai_mode
```

* **FAIL** = paraphrase of a known intent routed elsewhere → add that exact phrasing to `server/intents/*Intents.js`.
* **Fallback cluster** = inputs that fell through to `fallback` grouped by bigram → if a cluster is frequent, create a new intent (or map to existing `how_do_i`/`needs_ai_mode`).
* **Risky-on-chitchat** = `hey`/`lol` → `deploy` etc. → widen `QUESTION_BLOCKED_INTENTS` in `server/matcher.js:71` or add `preSemanticOverrides`.

## Response naturalness

The harness also audits `server/wsHandlers/chitChat/*.js`:

```
- chitChat/tools.js: single-string response (no variation)
  Fix: wrap with pickRandom(chatReplyPool('...', project, [ '...', '...', ... ]))
  like greeting/status/ack/empathy do (basic.js:16-32)
```

Every canned answer should have **3-5 variants** via `pickRandom(chatReplyPool(...))` so repeated `hey`/`thanks` never echos identically. Add your tone there.

## Live WS mode (optional)

```powershell
node --import tsx server/scripts/continuousChatHarness.js --live --port 3000
```

Connects to `ws://127.0.0.1:<port>/stream` and sends the same inputs through the full handler pipeline (confirm gates, projectIndex, etc.) — use for `revert`/`open file` smoke, not just matcher.

## Tuning loop (recommended)

1. `node --import tsx server/scripts/continuousChatHarness.js --mode intent-cover --count 1000 --typos` → note top FAILs
2. Add each FAIL's `input` as an example to its `expected` intent's `examples` in `server/intents/*.js`
3. If a fallback cluster is frequent (e.g. `what is the meaning` ×8), create a new intent in `server/intents/` + register in `server/intentRegistry.js:74` + add handler in `server/wsHandlers/`
4. For chitchat, add `2-3` more strings to the pool in `server/wsHandlers/chitChat/*.js`
5. `npm run check-matcher && npm run check-handlers && npx vite build` — then re-run the harness
6. For long soak: `... --loop --delay 100 --count 500` and watch `risky` stays `0` over hours

## Files

* Harness: `server/scripts/continuousChatHarness.js` (matcher-direct, no server needed)
* Prompt: `docs/CONTINUOUS_CHAT_TEST_PROMPT.md` (this file)
* History source: `data/conversations/*.ndjson`
* Intents: `server/intents/*.js` + `server/intentRegistry.js`
* Responses: `server/wsHandlers/chitChat/*.js`, `server/builtinHelpers.js:pickRandom`
