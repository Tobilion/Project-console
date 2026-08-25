// Project-intent vector management (2026-08-24, split out of semanticMatcher.js): the
// diff + embed + Fuse-update loop that keeps per-project config-entry triggers matchable by
// the embedding stage. The owner (SemanticMatcher) supplies extractor/_embedBatch/
// _rebuildFuseIndex and owns the mutex — every mutation route goes through it so watcher-
// driven and scan-driven updates stay atomic.

import { Mutex } from 'async-mutex';
import { computeProjectDiff } from './matcherProjectDiff.js';

export function createProjectIntentStore(owner) {
  // Serializes addProjectIntents / clearProjectIntents mutations (see those methods).
  const mutex = new Mutex();
  let lastProjectIntents = null;

  function computeDiff(projects) {
    const diff = computeProjectDiff(projects, lastProjectIntents);
    lastProjectIntents = diff.next;
    return { full: diff.full, changed: diff.changed, removed: diff.removed };
  }

  async function applyProjectIntents(projects) {
    const diff = computeDiff(projects);

    if (diff.full) {
      const totalEntries = projects.reduce((s, p) => s + (p.config?.entries?.length || 0), 0);
      if (totalEntries === 0) return;
      console.log(`[SemanticMatcher] Adding ${totalEntries} project-specific intents (full recompute)...`);
      owner.projectIntentVectors = {};
      owner.projectFuseItems = [];
      // Phase 6: collect every trigger first, embed the whole set in one bounded-concurrency
      // batch (same results as the serial loop, a fraction of the wall-clock), then assign
      // vectors back to their entries by index.
      const triggerGroups = new Map();
      for (let pIdx = 0; pIdx < projects.length; pIdx++) {
        const project = projects[pIdx];
        const entries = project.config?.entries || [];
        for (let eIdx = 0; eIdx < entries.length; eIdx++) {
          const entry = entries[eIdx];
          const triggers = entry.triggers || [];
          if (triggers.length === 0) continue;
          const intentName = entry.type === 'command'
            ? `project.action.${pIdx}.${eIdx}`
            : `project.knowledge.${pIdx}.${eIdx}`;
          triggerGroups.set(intentName, { pIdx, eIdx, triggers });
        }
      }
      const allTriggers = [];
      for (const group of triggerGroups.values()) {
        allTriggers.push(...group.triggers);
      }
      const results = await owner._embedBatch(allTriggers);
      let rIdx = 0;
      let count = 0;
      for (const [intentName, group] of triggerGroups) {
        const vectors = [];
        for (const trigger of group.triggers) {
          vectors.push(results[rIdx++].data);
          owner.projectFuseItems.push({ intent: intentName, text: trigger, isProject: true });
        }
        owner.projectIntentVectors[intentName] = { vectors, projectIndex: group.pIdx, entryIndex: group.eIdx };
        count++;
      }
      owner._rebuildFuseIndex();
      console.log(`[SemanticMatcher] ${count} project intents added`);
      return;
    }

    // Entries removed from a project no longer have vectors — drop them so removed entries
    // stop matching (and stop leaking memory). Runs before the changed-loop below: both can
    // arrive in the same diff (an entry replaced by another is reported as remove + add).
    const removedEntries = diff.removed || [];
    for (const { pIdx, eIdx, type } of removedEntries) {
      const intentName = type === 'command'
        ? `project.action.${pIdx}.${eIdx}`
        : `project.knowledge.${pIdx}.${eIdx}`;
      delete owner.projectIntentVectors[intentName];
      owner.projectFuseItems = owner.projectFuseItems.filter(f => f.intent !== intentName);
    }

    if (!diff.changed || diff.changed.length === 0) {
      if (removedEntries.length > 0) {
        owner._rebuildFuseIndex();
        console.log(`[SemanticMatcher] Removed ${removedEntries.length} deleted entries`);
      } else {
        console.log('[SemanticMatcher] No project intent changes detected');
      }
      return;
    }

    console.log(`[SemanticMatcher] Incremental update: ${diff.changed.length} entries changed`);
    // Phase 6: embed every changed entry's triggers in one bounded-concurrency batch, then
    // assign vectors back by index (identical results to the serial loop).
    const changedResults = await owner._embedBatch(diff.changed.flatMap(({ entry }) => entry.triggers || []));
    let cIdx = 0;
    for (const { pIdx, eIdx, entry } of diff.changed) {
      const intentName = entry.type === 'command'
        ? `project.action.${pIdx}.${eIdx}`
        : `project.knowledge.${pIdx}.${eIdx}`;

      // Remove old Fuse items for this intent
      owner.projectFuseItems = owner.projectFuseItems.filter(f => f.intent !== intentName);

      const triggers = entry.triggers || [];
      if (triggers.length === 0) {
        delete owner.projectIntentVectors[intentName];
        continue;
      }

      const vectors = [];
      for (const trigger of triggers) {
        vectors.push(changedResults[cIdx++].data);
        owner.projectFuseItems.push({ intent: intentName, text: trigger, isProject: true });
      }
      owner.projectIntentVectors[intentName] = { vectors, projectIndex: pIdx, entryIndex: eIdx };
    }
    owner._rebuildFuseIndex();
    console.log(`[SemanticMatcher] Incremental update complete — ${diff.changed.length} intents rebuilt`);
  }

  async function add(projects) {
    if (!owner.extractor) return;
    if (!projects) return;
    // Watcher-driven (index.js) and scan-driven (projectRoutes.js) updates can arrive
    // concurrently and all mutate the same project-intent vectors + Fuse items; route every
    // mutation through one mutex so diffs and index rebuilds stay atomic.
    await mutex.runExclusive(() => applyProjectIntents(projects));
  }

  async function clear() {
    // Same mutex as add — a clear landing mid-add would otherwise wipe state the
    // in-flight add is still writing to (watcher events call clear then add back-to-back).
    await mutex.runExclusive(() => {
      owner.projectIntentVectors = {};
      owner.projectFuseItems = [];
      // Drop the diff snapshot too: the next addProjectIntents must see the cleared state as a
      // full recompute, otherwise an unchanged project set diff's to "no changes" and the empty
      // vector store silently stays empty until restart (confirmed live 2026-08-06 audit).
      lastProjectIntents = null;
      if (owner.ready) owner._rebuildFuseIndex();
    });
  }

  return { add, clear };
}