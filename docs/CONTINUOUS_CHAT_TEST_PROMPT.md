# Continuous Chat Test Prompt — High-Volume Tuning for Project Console

Use this as the single prompt to **continuously hammer** the chat, tune intents, and make responses sound human.

## Quick start

```powershell
# one-shot, all 3 modes, ~600 inputs (matcher only, no server needed)
node --import tsx server/scripts/continuousChatHarness.js

# high-volume: 1000 intent-cover with typos
node --import tsx server/scripts/continuousChatHarness.js --mode intent-cover --count 1000 --typos

# continuous (infinite loop, 200ms between iterations)
node --import tsx server/scripts/continuousChatHarness.js --mode all --count 300 --loop --delay 200

# user-style replay only (your own history → variations)
node --import tsx server/scripts/continuousChatHarness.js --mode user-replay --count 300 --typos

# LIVE: drives the real chat over the WebSocket protocol (needs a running console)
node --import tsx server/scripts/continuousChatHarness.js --live --port 3000 --project "Oja"

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
  -> classify this before fixing it (see below)
Fallback cluster:
  'what is': 5 inputs  -> new intent: "what is the meaning of life" style → how_do_i or needs_ai_mode
```

* **FAIL** = paraphrase of a known intent routed elsewhere. **Do NOT paste the failing input
  into an intent's examples.** Classify it first (see the "Fix protocol" below) and use the
  fix type that matches the failure.
* **Fallback cluster** = inputs that fell through to `fallback` grouped by bigram → if a
  cluster is frequent, create a new intent (or map to existing `how_do_i`/`needs_ai_mode`).
* **Risky-on-chitchat** = `hey`/`lol` → `deploy` etc. → widen `QUESTION_BLOCKED_INTENTS` in `server/matcher.js:71` or add `preSemanticOverrides`.

## Fix protocol — classify before you touch anything

Every FAIL is one of four kinds, and the fix differs per kind:

| Kind | Symptom | Fix |
|---|---|---|
| Matcher misfire | wrong intent selected | narrow pre-semantic pin + a `matcherBatteries.js` row |
| Slot-extraction miss | right intent, wrong/missing entities | fix the slot pattern, not the examples |
| Threshold problem | fell through to fallback/AI when it should not have (or the reverse) | per-intent threshold change with evidence — never a global loosening |
| New/ambiguous capability | no intent owns the job at all | new intent (needs ≥3 independent phrasings), or a held-out eval row if it is genuinely ambiguous |

A confirmed trap (one confirmed failure of a shape you have seen before) becomes a **narrow
literal pin plus a battery row** — the pattern this repo already uses. A one-off phrasing
becomes a **near-miss** and goes through the existing near-miss → suggestion → gated-promotion
path (`learningEngine.applySuggestions`). A genuinely new or ambiguous phrasing goes into the
**frozen held-out eval set** (`server/scripts/eval/heldOutEval.json`) so it is tested rather
than trained on.

## Response naturalness

The harness also audits `server/wsHandlers/chitChat/*.js`:

```
- chitChat/tools.js: single-string response (no variation)
  Fix: wrap with pickRandom(chatReplyPool('...', project, [ '...', '...', ... ]))
  like greeting/status/ack/empathy do (basic.js:16-32)
```

Every canned answer should have **3-5 variants** via `pickRandom(chatReplyPool(...))` so repeated `hey`/`thanks` never echos identically. Add your tone there.

## Live WS mode

```powershell
node --import tsx server/scripts/continuousChatHarness.js --live --port 3000 --project "Oja"
```

`--live` drives the **real** chat pipeline over the WebSocket protocol (the same messages
the CLI and the web client send). The matcher-only modes prove which intent a phrase would
select; the live probe proves what the console actually does with it:

```
live turns: 200  answered: 197  no-response: 2  errors: 1  avg: 143ms  p95: 380ms
PROBLEM TURNS (3):
  'run the site' -> no-response
EMPTY ANSWERS (1):
  'what is the goal'
```

Use it for confirm/handler smoke and answer quality. Note that a scripted run auto-DECLINES
confirm prompts, so a mutation flow will report as declined rather than executed — drive
those interactively.

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
