# ADR 0003 — Four-way memory-store split

- Status: Accepted
- Date: 2026-08-26

## Context

The console persists several distinct kinds of per-project "memory", and at
least one past refactor confused two of them with severe consequences: a split
that was meant to touch only `projectMemoryStore.js` accidentally overwrote
`memoryStore.js`, and the server failed to start (commit `8e10090`). The root
cause was that the distinction lived in a human's head, not in the repo.

The four stores and why each is separate:

| Store | File(s) | Contents | Author | Injected into AI prompt? |
| --- | --- | --- | --- | --- |
| `memoryStore.js` | `<project>/.console/memory.md` | AI-authored durable facts (`saveMemory` tool), capped 200 entries | AI | Yes (4000-char, most-recent-first) |
| `projectMemoryStore.js` | JSON usage patterns (commands/files/questions) | Behavior-derived patterns with adaptive thresholds | System | No (drives memory_suggestion offers) |
| `notesStore.js` | `<project>/.console/notes.md` | User free text, capped 200 entries | User | Only when the user explicitly asks it read back |
| `codeIndex/` | `<project>/.console/code-index.json` | Semantic chunk vectors + mtime manifest | System | No (retrieval-only, searchable via intents) |

The three files (`memory.md`, `notes.md`, `code-index.json`) coexist in the
same `.console/` directory; the JSON stores live under `data/`. They have
different authors, different gating (AI facts go through `saveMemory` gating;
user notes are never AI-written), and different prompt-injection rules. These
differences are the reason for the split, not an accident of file layout.

## Decision

Keep the four stores separate and never merge, move, or "share" their exports.
When splitting or moving a module's exports, check every external importer of
that module before committing (lint/tsc does not check export names).

## Consequences

- `formatMemoryForPrompt()` injects only `memoryStore` content into the AI
  system prompt; `notesStore` content is never auto-injected. Confusing the two
  would leak user-authored notes into every model call (a privacy regression)
  or silently drop the AI's durable memory.
- Confusing `memoryStore` with `projectMemoryStore` overwrites the wrong file —
  the `8e10090` class of server-start failure.
- `codeIndex` persists typed-array-as-object vectors as a corruption case that
  resets the store; it is validated independently on load.
- Enforced by: `npm run check-handlers` (notes/memory handler rows against temp
  dirs), the `npm test` suite, and manual import-audit during any refactor.

## Alternative considered

Unifying all four behind one "store" abstraction looked cleaner, but the
different authors, gating, injection, and corruption semantics would all have to
be special-cased inside it — a single abstraction that must not share behavior
is worse than four honest stores. Rejected.
