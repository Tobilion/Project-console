# ADR 0002 — Safety-layer order

- Status: Accepted
- Date: 2026-08-26

## Context

The console can execute arbitrary shell commands and write files, driven by
natural language and by an optional local-AI agent. No single mechanism is
sufficient to make that safe, so the design composes several independent layers.
The layers run in a fixed order, and two invariants hold across all of them:

1. A later layer can only *add* restriction, never waive an earlier one.
2. No layer may be bypassed by the very thing it guards (the model cannot
   self-approve; the sandbox never weakens the confirm gate).

The layer order (from outermost, hard refusal to innermost, execution):

1. **Hard blocklist** — `server/dangerousPatterns.js`. Last-resort absolute
   prohibitions (disk wipe, etc.). Not a security boundary by itself.
2. **Command-risk classifier** — `server/commandRisk.js`
   (`isDestructiveCommand`). Computes the effective risk of an `executeCommand`
   (destructive git/npm verbs, recursive deletes, disk-formatting tools).
   A caller-supplied `risky: true` can only add risk, never waive the
   classifier's own finding.
3. **Confirm gates** — `server/toolGate.js` + `connectionConfirm.js`
   (`ALWAYS_CONFIRM_TOOLS`, `GATED_TOOLS`, `CUSTOM_RISKY_TOOLS`). Write/file
   tools and risky commands require explicit human approval. The model cannot
   self-approve; the only exceptions are explicit session grants for the
   non-risky file tools, and neither mechanism can auto-approve
   `risky: true` executeCommand / runTests / stopProcess.
4. **Git checkpoints** — `server/gitSafety.js`. Confirmed mutations run after a
   checkpoint commit so they are revertable.
5. **Sandboxing** — `server/executorSandbox.js` + `server/toolSandbox.js`.
   Opt-in restricted env for confirmed risky commands (environment allowlist,
   cwd pinned). The sandbox applies *after* approval — it never substitutes for
   it, and it provides no network/OS-level file boundary.
6. **SSRF guards** — `server/urlSafety.js`. All outbound fetches (webSearch,
   webhook delivery, registry/manifest fetches) reject private/loopback targets.

## Decision

Keep this order fixed. A command must pass blocklist → classifier → gate →
checkpoint → sandbox in sequence; no later layer may skip an earlier one.

## Consequences

- The confirm gate is the load-bearing layer. Anything that auto-approves
  mutations (e.g. a "Code mode" that pre-grants risky commands) violates the
  invariant and is explicitly deferred pending sign-off.
- A `risky: false` claim on an `executeCommand` still asks, checkpoints, and
  journals when the classifier fires.
- The sandbox setting never bypasses or weakens the confirm flow — it strictly
  applies after approval, and is deliberately excluded for `stopProcess` and
  dev-server port retries.
- Path escapes (including symlinks) are rejected in the file tools; the server
  binds to 127.0.0.1 by default.
- Enforced by: `npm run check-tools` (tool gate/permission rows),
  `npm run check-handlers` (confirm-gated handler rows), and the
  `server/test/fuzzSafety.test.js` differential (every blocklist entry is also
  flagged by the risk classifier).

## Alternative considered

Moving the sandbox ahead of the confirm gate (sandbox first, then ask) would
reduce the number of prompts — but a sandboxed risky command can still do
irreversible harm (a sandboxed `git push` still reaches GitHub), so the human
decision must always come first. Rejected.
