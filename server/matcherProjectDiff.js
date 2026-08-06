// Phase 3 decomposition leaf: project-state diffing for SemanticMatcher (extracted verbatim
// from semanticMatcher.js — see that file's _computeProjectDiff for the original). Pure
// function: the caller owns `lastProjectIntents` and adopts `next` on return.
//
// Returns { full, changed, removed, next }:
//   - full: true means the caller must rebuild the entire vector store (no `lastProjectIntents`
//     snapshot, or the project set/order changed — see below).
//   - changed: entries whose triggers changed or that are new (applied by the caller).
//   - removed: entries that no longer exist (their old vectors must be deleted by the caller).

export function computeProjectDiff(projects, lastProjectIntents) {
  const current = projects.map(p => ({
    id: p.id,
    entries: (p.config?.entries || []).map(e => ({
      type: e.type, triggers: e.triggers || [], action: e.action,
    })),
  }));
  if (!lastProjectIntents) {
    // Full recompute
    return { full: true, changed: null, removed: null, next: current };
  }
  // Vectors are keyed by positional indices (project.action.<pIdx>.<eIdx>), so any project
  // added, removed, or reordered shifts every later project's keys. Patching just the diff
  // would leave stale vectors pointing at the wrong project — treat the whole set as changed
  // and let the caller's full recompute path rebuild with fresh positions.
  const prevIds = lastProjectIntents.map(p => p.id).join('\u0000');
  const curIds = current.map(p => p.id).join('\u0000');
  if (prevIds !== curIds) {
    return { full: true, changed: null, removed: null, next: current };
  }
  const changed = [];
  const removed = [];
  for (let pIdx = 0; pIdx < current.length; pIdx++) {
    const cur = current[pIdx];
    const prev = lastProjectIntents[pIdx];
    const maxEntries = Math.max(prev.entries.length, cur.entries.length);
    for (let eIdx = 0; eIdx < maxEntries; eIdx++) {
      const curEntry = cur.entries[eIdx];
      const prevEntry = prev.entries[eIdx];
      if (!curEntry) {
        // Entry removed from the project — report its type so the caller can delete the
        // stale vector/Fuse items keyed `project.<type>.<pIdx>.<eIdx>`.
        if (prevEntry) removed.push({ pIdx, eIdx, type: prevEntry.type });
        continue;
      }
      if (!prevEntry || JSON.stringify(curEntry.triggers) !== JSON.stringify(prevEntry.triggers)) {
        changed.push({ pIdx, eIdx, entry: curEntry });
      }
    }
  }
  return { full: false, changed, removed, next: current };
}
