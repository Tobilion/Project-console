# ADR 0001 — Matching-pipeline stage order

- Status: Accepted
- Date: 2026-08-26

## Context

A user message must route to an intent (or command entry, or executable)
through a multi-stage matcher. Several stages are expensive or heuristic and
several are cheap and deterministic. The order in which the stages run is not
arbitrary: it is the product of repeated, live-verified failures where a
reordering or a new stage landing in the wrong slot caused intents to silently
misfire, drift onto a wrong-but-confident match, or become unreachable.

The current order (see `server/matcher.js`, `server/matcherStages.js`,
`server/semanticMatcher.js`):

1. Pre-semantic literal overrides (`preSemanticOverrides.js`)
2. Embedding scan (floor 0.6, margin 0.03, close-second pass)
3. Stage-1b config-entry scan (`bestProjectCommandEntry` vs 0.55, only when the
   winning builtin is `run_project`/`npm_run`)
4. Project config entries
5. Fuzzy (Fuse 0.55, length-scaled floor)
6. NLP classifier
7. Local router (Ollama, bounded single call)
8. Command guesser (platform-branched regex fallback)
9. Fallback suggestions + did-you-mean

## Decision

Keep the stage order fixed and treat it as an invariant. New behavior is added
by adding *stages in their correct slot* or by narrowing pre-semantic overrides
— never by reordering existing stages to "fix" one input.

The ordering rationale:

- **Pre-semantic first**: the embedding stage has confirmed blind spots
  (verb+noun traps where the git/deploy clusters own generic shapes). A narrow
  literal rule for a confirmed trap must run before anything that can vote on
  the same input, or it is unreachable.
- **Deterministic/cheap before expensive**: embeddings, Fuse, NLP, and the
  router are all more expensive than a literal match; nothing should pay for a
  model call when a rule already knows the answer.
- **Hand-written specificity before fuzzy generality**: config entries and
  curated examples encode intent; fuzzy/NLP are recall layers for shapes nobody
  wrote down.
- **NLP before router, router before guesser**: increasing generality, and each
  later stage only fires when earlier stages had no confident answer.

## Consequences

- A stage that returns a result shadows every later stage. "Fix" by inserting
  an override or re-ranking within a stage, not by moving stages.
- `matcher.js` gates only `source === 'semantic'` results with
  `getEffectiveThreshold()`. Fuzzy/keyword/router results are trusted as-is;
  changing that gate changes the whole tier's reachability.
- The `BUILTIN_INTENTS` Set membership is the dispatch gate — an intent missing
  from it is unreachable from every stage despite real examples/handlers. Every
  new intent is added there.
- Enforced by: `npm run check-matcher` (the battery pins routing for confirmed
  trap shapes and machine-dependent rows are marked machine-independent),
  `npm run check-handlers` (handler dispatch), `npm run check-intents`
  (duplicate phrase shapes).

## Alternative considered

Reordering embedding ahead of pre-semantic overrides would let "trap" inputs
match more "naturally" — but it makes the traps non-deterministic across
machines (embedding vectors differ with the model) and re-opens the 
live-verified misfires that the overrides exist to pin. Rejected.
