# ADR 0004 — WS/CLI parity contract

- Status: Accepted
- Date: 2026-08-26

## Context

The CLI (`server/cli-client.js` + `server/cliRenderer.js`) is a second renderer
of the same WebSocket protocol the web frontend uses. It connects to the same
server and must behave as a full chat client. Historically, message types the
CLI did not handle fell through its `switch` `default` case and vanished with
zero signal. Three real types were silently dropped before this was fixed:
`warning`, `server_url`, and `update_available`. A user running the CLI (or
`start.bat`'s [C] option) simply never saw them.

The web frontend routes WS messages through `src/hooks/wsMessageCases.ts` /
`wsStreamingCases.ts`. The CLI routes them through its own `switch` in
`cli-client.js`. There is no shared renderer — the two are kept in sync by
convention enforced by a harness.

## Decision

Every WS message type with user-visible behavior must have a corresponding
`case` in the CLI's `switch`: either rendered, or an explicit commented no-op
documenting why (e.g. `openPanel` is web-only because the CLI is text-only).
The rule is enforced by `scripts/checkWsMessageCases.ts` (run via
`npm run check-ws-cases`), which fails when a key in the web case table has no
CLI case.

When adding a new WS message type:

1. Add it to the server emitter.
2. Add the web case in `wsMessageCases.ts` / `wsStreamingCases.ts`.
3. Add the CLI case (rendered or documented no-op).
4. Extend `checkWsMessageCases.ts` when the type has user-visible behavior.

## Consequences

- The CLI and web clients can never silently diverge on protocol coverage — a
  new type that only lands on one side fails the harness.
- Additive fields on existing messages (e.g. `actionIds` on answers for the
  undo toast, `openPanel`) do not require new CLI cases; the CLI ignores them
  deliberately and the ignore is documented in the relevant `case`.
- The harness scans `cli-client.js` *and* `cliRenderer.js` — keep CLI rendering
  logic in the renderer module so the scan stays correct.
- Enforced by: `npm run check-ws-cases` (133 rows: every `WS_CORE_CASES` key
  requires a CLI case).

## Alternative considered

Extracting a shared renderer that both clients use would eliminate the
divergence class entirely, but the web and CLI surfaces are fundamentally
different (rich HTML/markdown vs plain text, interactivity vs stdin/stdout) and
a shared abstraction would be mostly conditionals. The harness is the cheaper,
honest enforcement. Deferred as a refactor only if the case table grows
unmanageably.
