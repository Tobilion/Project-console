# Local Router Upgrade — Detailed Execution Prompt

Read this first if you're picking up this work in a new session. It's the full plan agreed on
2026-07-29 for making trigger mode genuinely understand intent and handle more tasks on its own,
before ever escalating to full AI mode. Update it in place as work completes — mark items done,
don't append a changelog (same convention as `CLAUDE.md`).

## Vision

Tobi wants Project Console's trigger mode (AI OFF) to be a capable assistant in its own right —
not just a canned-response dispatcher that bounces everything non-trivial to "turn on AI mode."
Trigger mode should correctly understand ordinary requests (file ops, git ops, project questions,
requests with an embedded filename/comment/URL) and execute them directly. Full AI mode's
multi-turn reasoning loop should be the last resort for genuinely open-ended work (new features,
refactors, multi-step reasoning) — not the fallback for things trigger mode fails to parse.

## Research findings (why this plan, not a dependency install)

Four existing projects were evaluated as potential prior art. None get installed — all are either
wrong fits or Python packages with no net capability gain over what this codebase already has:

- **Rasa** — ruled out entirely. Rasa Open Source is in maintenance mode; its own maker pivoted
  to LLM-based understanding ("Hello Rasa"/CALM) for the same reason trigger mode keeps breaking:
  pure trained intent classifiers never stop needing new special cases.
- **RouteLLM** (LMSYS) — not usable even via a Python sidecar. Its trained routers are tied to a
  specific cloud model pair's preference data (GPT-4 vs Mixtral), not general-purpose. Its value
  is purely as published validation that a "cheap/fast tier decides, escalate to the expensive
  tier only when needed" architecture works well in practice — the shape we're building, not the
  code.
- **Semantic Router** (aurelio-labs, MIT, actively maintained) — the real blueprint. Its local
  execution mode (embeddings + a single tightly-scoped local-model call for parameter extraction)
  is proven — their own docs report local 7B-class models outperforming GPT-3.5 on this exact
  task. Not installed as a Python dependency because this codebase already owns both underlying
  ingredients natively: `@xenova/transformers` embeddings (already powering `semanticMatcher.js`)
  and an Ollama HTTP client (`server/ollama.js`). A Python sidecar would add a second process, a
  second language runtime, and a second copy of an embedding model in RAM on a machine with no
  GPU and 16GB RAM — for zero capability this stack doesn't already have. Port the technique
  natively instead.
- **Aider** — not run as a subprocess (it's a full competing CLI application that does its own
  model calls, git commits, and file writes end-to-end; shelling out to it would mean ceding this
  app's own confirm-before-write safety flow, which `CLAUDE.md` says not to weaken without
  discussion). Two specific proven techniques are worth porting into this codebase's own files:
  the repo-map-for-context idea, and the structured SEARCH/REPLACE edit reliability pattern.

## Hard constraints — do not violate these

- **Stay 100% local-capable.** Everything here must work fully offline with a local Ollama model;
  the optional `:cloud` models remain a user choice, never a requirement.
- **Do not weaken the existing safety model.** `writeFile`/`editFile`/`insertAtLine`/
  `appendToFile`/risky `executeCommand` must still require explicit user confirmation before
  running. The router tier below only changes *how an intent gets decided* — the execution path
  once an intent is chosen (confirm flow, git checkpointing, sandboxed `tools.js` functions) does
  not change and must not be duplicated or bypassed.
- **Respect the hardware.** Tobi's machine (Intel i7-8550U, no discrete GPU, 16GB/15.8GB usable
  RAM) means CPU-only inference. Any new model call this plan introduces must be small and bounded
  — short prompt, low `max_tokens`, low temperature, a real timeout — so it stays fast relative to
  a full AI-mode conversation. This is the whole point of the tiered design: don't turn the "fast"
  tier into a second slow one.
- **No new dependencies.** No `npm install`, no `pip install`, no sidecar process. Everything is
  built from what's already in the codebase (`@xenova/transformers`, the existing Ollama client,
  existing regex/string tooling).
- **Trigger mode must still work with Ollama off.** The new router tier is additive. If Ollama
  isn't running or the call times out, fall through to today's existing behavior (commandGuesser
  guess → suggestion chips) exactly as now — zero regression risk if the model is unavailable.

## The three pieces

### 1. Router tier — fast single-call local-model classify + extract — **implemented 2026-07-29**

**Problem it fixes:** the confirmed-live bugs this conversation surfaced (git_add vs file_create
ambiguity, dropped push comments, "attach the github link" having nowhere to go before a fix) are
all instances of the same root cause — embeddings/Fuse/keyword matching measures surface
similarity, not meaning, so novel phrasings keep slipping through. Every fix so far has been
another literal regex added to `PRE_SEMANTIC_OVERRIDES` — a list that will never stop growing.

**Design:** insert a new fallback tier between the existing embedding/fuzzy/keyword pipeline and
whatever happens today when nothing matches confidently.

- Today's pipeline (embedding → fuzzy → keyword → `PRE_SEMANTIC_OVERRIDES` literal checks) stays
  exactly as-is and keeps first priority — it's instant and correct for the confident majority of
  cases. No regressions to the fast path.
- When today's pipeline comes back low-confidence / no-match (instead of falling straight to
  `commandGuesser`'s naive regex guess), make **one bounded call** to the local Ollama model:
  - Prompt: the user's message + a compact list of available intents/tools and their required
    parameters (reuse the shape already defined in `ollamaContext.js`'s `BUILTIN_TOOL_DEFS` /
    `intentsData.js` intent names — don't maintain a second schema).
  - Ask for strict JSON back: `{"intent": "<name_or_null>", "args": {...}, "confidence":
    "high"|"medium"|"low"}`.
  - Low `max_tokens` (this is a classification, not a conversation), low/zero temperature for
    determinism, no streaming — one blocking call.
  - Parse defensively — models sometimes wrap JSON in markdown fences or add commentary before/
    after it. Reuse the `<tool_call>{...}</tool_call>`-extraction robustness pattern already
    proven in `aiStream.js` rather than writing a second, less battle-tested parser.
  - Set a short timeout (5-8s). On timeout, error, or low confidence: fall through to exactly
    today's existing behavior (commandGuesser → suggestions → offer to escalate to AI mode).
  - On a confident match: dispatch to the *same* `handleBuiltinIntent()` / `matchedEntry.js`
    execution path already used today. The router only decides *which* intent fired — it must
    not duplicate or bypass the existing confirm-before-write flow.

**Files:** new `server/localRouter.js` (the classify+extract call and JSON parsing), wired into
the fallback chain in `server/matcher.js` as stage 4 (after semantic/NLP/fuzzy, before the plain
suggestion-chip fallback). New `chatOnce()` in `server/ollama.js` (non-streaming `/api/chat`,
`stream: false`) — `chatStream()` wasn't reusable since the router needs one blocking JSON
response, not a token stream. `matchInput()` gained a 4th `options` param (`{ model }`);
`connection.js` passes `sessionContext.aiModel` through so the router uses whatever model the
user already has selected, independent of the `aiEnabled` toggle. Router hits are logged as a
near-miss with `source: 'router'` (parity with the existing 'guess'/'fallback' sources) so
`review learning` can surface phrasings worth promoting into real examples later.

**Drive-by fix required to make this work at all:** `matcher.js`'s `BUILTIN_INTENTS` Set (the
gate every matching stage — semantic, NLP, and now router — must pass before an intent can
actually dispatch) was missing `file_append`, `file_read`, and `git_remote_add`, even though
`builtinIntents.js` has real handlers for all three and `git_remote_add` has a dedicated
`PRE_SEMANTIC_OVERRIDES` literal-keyword hit in `semanticMatcher.js`. That override could match
with 0.9 confidence and still silently die at the `BUILTIN_INTENTS.has()` check and fall through
to the generic fallback — meaning the "Can I attach the github link" fix this file's own history
describes as "confirmed live" was not actually reachable end-to-end. Fixed by adding all three to
the Set (`server/matcher.js`). Since `localRouter.js` imports this same Set as its allowed-intent
list, the fix was required for the router to ever route to those three intents too.

**Not yet done from this piece's design:** the router prompt currently does not include a
repo-map / disambiguation context slice (that's piece 2 below) and its `args` output, while
parsed, is not yet used by dispatch — `handleBuiltinIntent()` still re-parses filename/comment/URL
directly from the raw input string exactly as it does for every other matching stage, so no
duplicate parsing logic was introduced. Re-test against the four failure-case phrasings in
"Success criteria" below once a real Ollama + model is available (this sandbox has neither — see
the standing verification caveat at the bottom of this doc).

### 2. Repo map — Aider-style whole-project context — **implemented 2026-07-29**

**Problem it fixes:** even once the router tier understands *what* the user is asking for, it
(and full AI mode) can still fail to resolve *which* file/thing they mean, because
`codebaseIndexer.js` currently only snippets a couple of entry-point files. Aider's fix — a
lightweight signature map (function/class/export names) across the *whole* project, small enough
to fit in a small model's context — is what lets even a 7B model resolve "the config file" or
"that component" with real project awareness instead of guessing.

**Design:** extend `codebaseIndexer.js` to build a capped-size, per-file signature summary
(regex-based extraction of top-level exports/functions/classes per language already represented in
the project — no new parser dependency). Feed this into: (a) the router tier's prompt when it
needs to disambiguate a loose file reference, and (b) full AI mode's existing system prompt
(`ollamaContext.js`'s `buildSystemPrompt()`), replacing/extending the current entry-snippets-only
approach.

**Files:** `server/codebaseIndexer.js` (new repo-map builder, size-capped), `server/ollamaContext.js`
(include it in the system prompt), `server/localRouter.js` (include a trimmed slice when
disambiguating).

**What was built:** `buildRepoMap()` in `codebaseIndexer.js` regex-scans every `.js/.jsx/.ts/.tsx/
.mjs/.cjs/.py` file in the project tree (already collected by `readProjectTree()`) for top-level
export/function/class names — JS/TS patterns cover `export function/class/const/let/var`, `export
default function/class`, `module.exports.x =`, `exports.x =`, and plain top-level `function`/
`class`; Python covers `def`/`async def`/`class`. Patterns are anchored at `^` with no leading
whitespace, so only top-level declarations are picked up — this is a "what does this file expose"
map, not a full outline, and deliberately misses nested/inner functions. Capped at
`MAX_REPO_MAP_FILES` (150 files, shallowest paths first), `MAX_FILE_READ_BYTES` (20000 — only the
head of huge generated files is scanned), and `MAX_SIGNATURES_PER_FILE` (12). Per-file signatures
are cached by absolute path with mtime invalidation (`repoMapFileCache`, same shape as the
existing `keyFileCache`), so unchanged files aren't re-scanned on every `indexProject()` call.
Stored as `idx.repoMap` (array of `{path, signatures}`); a new `formatRepoMap(repoMap, maxChars)`
export renders it into a capped `path: sigA, sigB, ...` text block — exported because the two
consumers need different caps.

`ollamaContext.js`'s `formatIndex()` now appends a "Project signature map" section (capped at
6000 chars — `MAX_SYSTEM_PROMPT_REPO_MAP_CHARS`) after the existing entry-snippet excerpts,
extending rather than replacing them (the entry-point excerpts are still real file content, which
is more useful than a signature list for the 1-2 files that actually matter most). `matcher.js`'s
router stage now also passes a much smaller slice (`ROUTER_REPO_MAP_CHARS` = 1200 chars) into
`routeViaLocalModel()`'s new `repoMapSlice` option, appended to the classification prompt with an
explicit instruction that it's for context only — the router still only picks an *intent*, never
a resolved file path as fact, so handlers still call `findFiles`/`readFile` themselves before
acting on any filename, exactly as before this change.

**Simplification from the original design:** the plan said to include the repo-map slice in the
router's prompt "when it needs to disambiguate a loose file reference" — implemented instead as
always-included-when-available, since detecting "this input needs file disambiguation" would be
its own fragile heuristic, and 1200 chars is cheap enough on top of an already-bounded call not to
need conditional inclusion. Revisit if router latency in practice (once tested against a real
Ollama instance) turns out to be a problem.

Verified with a throwaway script (not committed) that ran `indexProject('.')` against this repo
itself: 62 files got real signatures out of the scan (e.g. `server/codebaseIndexer.js:
formatRepoMap, indexProject, extractSignatures, pathParts, detectLanguages, findEntryPoints`), and
`formatRepoMap()`'s char cap correctly truncates mid-list. Still not tested inside an actual
Ollama prompt/response round-trip — no working Ollama in this sandbox, same standing caveat.

### 3. Reliable edit format — reduce silent editFile failures — **implemented 2026-07-29**

**Problem it fixes:** `editFile`'s exact-substring match on `oldString` silently fails ("Text not
found") whenever a model's quoted string doesn't match the file byte-for-byte — a common failure
mode for smaller local models that don't reproduce whitespace/quoting exactly.

**Design:** this is a robustness tightening, not a format rewrite (the app already added
`insertAtLine`/`appendToFile` this session for the cases plain find-and-replace doesn't suit).
Two changes: (a) in `server/tools.js`'s `editFile`, add a whitespace-normalized fallback match
before giving up, and return a clearer error suggesting a fresh `readFile` when even that fails;
(b) in `ollamaContext.js`, tighten the `editFile` tool description to more explicitly instruct the
model to call `findFiles`/`readFile` immediately before proposing `oldString`, so what it quotes
reflects the file's actual current byte content.

**Files:** `server/tools.js` (`editFile` fallback match), `server/ollamaContext.js` (tool
description wording).

**What was built:** `server/tools.js` gained two module-level helpers — `normalizeLine()` (trim +
collapse internal whitespace to one space) and `findNormalizedLineMatch(contentLines, oldLines)`
(slides `oldString`'s lines over the file's real lines, comparing each pair post-normalization,
returning the starting line index of the first fully-matching contiguous block, or -1). `editFile`
tries the existing exact `content.includes(oldString)` path first (unchanged, still the fast
common case); only on failure does it split both sides into lines and try the normalized match.
On a fallback hit, it replaces that exact original line range with `newString` verbatim and
returns success with a note that it matched via the fallback (so it's visible in the chat/tool
result, not silent). On total failure it now names both things it tried and tells the caller to
re-read the file before retrying, instead of the old bare "Text not found in X." This only
tolerates whitespace/indentation drift, not wrong wording — a genuinely incorrect `oldString`
still correctly fails rather than editing the wrong block (verified below).

`ollamaContext.js`'s `editFile` tool description was tightened to explicitly instruct the model to
call `findFiles`/`readFile` immediately before proposing `oldString` (not from memory or an
earlier turn), mention that a whitespace-tolerant fallback exists but only covers spacing, and
tell it to re-read rather than re-guess if editFile still fails.

**Verified** (native `re2` dependency in `tools.js` can't load in this sandbox — wrong-platform
prebuilt binary, a pre-existing environment gap, not something this change touches — so the exact
`normalizeLine`/`findNormalizedLineMatch`/`editFile` logic was copied into a standalone throwaway
script and run directly): (1) an `oldString` with different indentation/spacing than the real
file correctly falls back and replaces the right block; (2) an exact match still takes the fast
path unchanged; (3) a genuinely wrong `oldString` (different code entirely) correctly returns
"not found" rather than over-matching. Still not tested through the real `editFile` (with the
sandboxing/path-escape logic) or a live model — same standing `npm install`/real-Ollama caveat as
the other two pieces.

## Order of execution

1. Router tier — directly fixes the most-reported problem (misrouted/misunderstood requests).
2. Repo map — improves disambiguation quality for both the router tier and full AI mode.
3. Edit format reliability — smaller, standalone robustness improvement.

These are independent; each can ship and be tested on its own.

## Success criteria

- Re-test the exact failure cases from this conversation's real transcripts — "add a file"/"can
  you help me add a file" (should resolve to `file_create`, not `git_add`), "push the site with
  the comment 'bug fixes'" (comment must survive regardless of which push-style intent matches),
  "Can I attach the github link" (must route to `git_remote_add`), "add file Tobijagz to folder
  with text 'I am the goat'" (must create the file, not return a directory listing) — and confirm
  the router tier resolves novel rephrasings of these even without a matching literal override.
- Confirm trigger mode behaves identically to today when Ollama is not running — no regression.
- Manual re-read for syntax/consistency, plus `npm run lint` and a real `npm run dev` smoke test
  once a working build environment is available (standing caveat this entire project: the sandbox
  used to build prior fixes had no working VM, so nothing has been build/lint-tested yet).

## Explicitly out of scope this pass

- No Python sidecar process, no new npm/pip dependencies.
- No change to the full AI-mode multi-turn tool-call loop itself (`aiQuery.js`/`aiStream.js`)
  beyond sharing the new repo-map context.
- `PRE_SEMANTIC_OVERRIDES` and `commandGuesser` are not removed — they remain the fast, zero-model
  first pass. The router tier is a new fallback layer underneath them, not a replacement.
