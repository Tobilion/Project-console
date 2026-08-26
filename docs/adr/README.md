# Architecture Decision Records

This directory records the load-bearing architectural decisions of the console.
Each record explains *why* an order, split, or contract exists — not just what
it is. The invariants documented here were each learned the hard way: a past
edit or refactor violated one and broke behavior that no single file made
obvious. Read these before touching the systems they describe.

- [0001 — Matching-pipeline stage order](0001-matching-pipeline-stage-order.md)
- [0002 — Safety-layer order](0002-safety-layer-order.md)
- [0003 — Four-way memory-store split](0003-memory-store-split.md)
- [0004 — WS/CLI parity contract](0004-ws-cli-parity.md)

Conventions for new records:

- Status: `Accepted` (superseding records update the status of the old one).
- Keep them short (~60-120 lines) and specific: the triggering incident, the
  decision, the consequences, and which harness enforces it.
- Every record that corresponds to an automated guard names the exact
  check-* harness or test that fails when the invariant is violated.
