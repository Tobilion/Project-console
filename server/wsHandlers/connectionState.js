// Shared mutable state for the wsHandlers connection layer (Phase 11 split). Only the
// pieces that must be shared across multiple sibling modules live here; everything else
// stays module-local in its own leaf. `pendingConfirmations`/`pendingToolConfirmations`
// already live in server/state.js — this Map is the one piece that was local to
// connection.js before the split.
const pendingMemorySuggestions = new Map();

export { pendingMemorySuggestions };
