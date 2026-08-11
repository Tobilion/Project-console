import { Mutex } from 'async-mutex';
import Fuse from 'fuse.js';
import { INTENTS } from './intentsData.js';
import { broadcast } from './wsServer.js';
import { bestProjectActionVector } from './intentVectorScan.js';
import { runMatchPipeline } from './matcherMatch.js';
import { computeNearestIntent } from './matcherNearest.js';
import { matchMultiParts } from './matcherMulti.js';
import { computeIntentCollisions } from './matcherCollisions.js';
import { computeProjectDiff } from './matcherProjectDiff.js';
import { searchFuseSuggestions } from './matcherFuse.js';
import { getTuning } from './tuningStore.js';

// Tunable knobs (Phase 4: magic numbers standardized).
// 0.4 was cutting off single-edit typos on short inputs (e.g. "hep" -> "help") before
// they ever reached the code's own fuzzyFloor check below. 0.55 lets more near-misses
// through to that second gate, which still filters on confidence per input length.
// Phase 8 (2026-08-11): these exports are the DEFAULTS — the settings UI can shadow any of
// them at runtime via data/tuning.json (tuningStore.js); each use site reads getTuning(
// 'NAME', <this default>) so untouched knobs resolve here with zero behavior change.
export const FUSE_THRESHOLD = 0.55;
export const FUSE_MIN_MATCH_CHAR_LENGTH = 2;
/** Poll interval while waiting for another caller's in-flight initialize(). */
export const INIT_WAIT_POLL_MS = 200;
/** Deadline for the embedding-model download inside initialize() — see that method. */
export const INIT_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Default number of "did you mean" suggestions to return. */
export const SUGGESTION_DEFAULT_LIMIT = 5;
/** Default cosine threshold for flagging intent pairs that may be hard to distinguish. */
export const COLLISION_DEFAULT_THRESHOLD = 0.9;

// @xenova/transformers is an OPTIONAL dependency (package.json): it pulls sharp, whose native
// libvips download has failed installs on slow/restricted networks. The lazy import below means
// a machine without the package just takes the initError path (fuzzy/NLP stages still work) —
// a static top-level import would crash the whole server instead.

class SemanticMatcher {
  constructor() {
    this.extractor = null;
    this.intentVectors = null;
    this.projectIntentVectors = {};
    this.fuseIndex = null;
    this.projectFuseItems = [];
    this.ready = false;
    this.initializing = false;
    this.initError = null;
    this._lastTelemetry = null;
    this.lastProjectIntents = null;
    // Serializes addProjectIntents / clearProjectIntents mutations (see those methods).
    this._projectIntentsMutex = new Mutex();
  }

  async initialize() {
    if (this.ready) return;
    if (this.initializing) {
      while (!this.ready && !this.initError) {
        await new Promise(r => setTimeout(r, getTuning('INIT_WAIT_POLL_MS', INIT_WAIT_POLL_MS)));
      }
      if (this.initError) throw this.initError;
      return;
    }
    this.initializing = true;

    try {
      // Lazy load — see the note at the top of this file about why this is not a static import.
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = './.cache/xenova';
      broadcast({ type: 'semantic_matcher_progress', data: { stage: 'downloading', percent: 0 } });
      console.log('[SemanticMatcher] Loading embedding model (first load downloads ~23MB)...');
      // A stalled HuggingFace download (an offline/proxied/rate-limited connection that
      // neither resolves nor rejects) previously hung initialize() forever: index.js awaits it
      // before the port-fallback listen loop, so the whole server never bound, and every
      // concurrent caller's ready/initError poll loop spun forever (audit 2026-08-06, Phase 2).
      // Race the download against a deadline — on timeout this fails exactly like a real
      // download failure (initError set, callers already degrade gracefully to the fuzzy/NLP
      // stages), and the losing pipeline promise can't clobber anything because the race
      // settled first.
      let downloadTimer;
      this.extractor = await Promise.race([
        pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true }),
        new Promise((_, reject) => {
          downloadTimer = setTimeout(
            () => reject(new Error(`Embedding model download timed out after ${INIT_DOWNLOAD_TIMEOUT_MS / 1000}s — semantic matching unavailable this session.`)),
            INIT_DOWNLOAD_TIMEOUT_MS
          );
        }),
      ]).finally(() => clearTimeout(downloadTimer));
      broadcast({ type: 'semantic_matcher_progress', data: { stage: 'embedding', percent: 50 } });
      console.log('[SemanticMatcher] Model loaded, computing intent embeddings...');

      this.intentVectors = {};
      for (const [intent, config] of Object.entries(INTENTS)) {
        const vectors = [];
        for (const example of config.examples) {
          const result = await this.extractor(example, {
            pooling: 'mean',
            normalize: true,
          });
          vectors.push(result.data);
        }
        this.intentVectors[intent] = vectors;
      }

      this._rebuildFuseIndex();

      this.ready = true;
      broadcast({ type: 'semantic_matcher_progress', data: { stage: 'ready', percent: 100 } });
      console.log(`[SemanticMatcher] Ready — ${Object.keys(INTENTS).length} base intents, ${Object.values(INTENTS).reduce((s, c) => s + c.examples.length, 0)} phrases`);
    } catch (err) {
      this.initError = err;
      console.error('[SemanticMatcher] Failed:', err.message);
      throw err;
    } finally {
      this.initializing = false;
    }
  }

  _rebuildFuseIndex() {
    const fuseItems = [];
    for (const [intent, config] of Object.entries(INTENTS)) {
      for (const example of config.examples) {
        fuseItems.push({ intent, text: example, isProject: false });
      }
    }
    for (const item of this.projectFuseItems) {
      fuseItems.push(item);
    }
    this.fuseIndex = new Fuse(fuseItems, {
      keys: ['text'],
      // Rationale for FUSE_THRESHOLD (0.55): see the constant declaration at the top of this file.
      threshold: getTuning('FUSE_THRESHOLD', FUSE_THRESHOLD),
      includeScore: true,
      minMatchCharLength: getTuning('FUSE_MIN_MATCH_CHAR_LENGTH', FUSE_MIN_MATCH_CHAR_LENGTH),
      ignoreLocation: true,
    });
  }

  /**
   * Rebuilds the Fuse index from current items with current tuning values. Returns false when
   * the matcher isn't ready yet (nothing to rebuild) — a no-op then, not an error. Used by the
   * tuning routes (tuningRoutes.js) so threshold changes apply to the next match without a
   * restart; the intent vectors are unaffected by these knobs.
   */
  refreshFuseIndex() {
    if (!this.ready) return false;
    this._rebuildFuseIndex();
    return true;
  }

  /**
   * Refresh the embedding vectors for one intent after its examples grew at runtime (the
   * learning engine's applySuggestions). initialize() embeds every INTENTS example once and
   * nothing told the embedding stage about learned phrases — Fuse got rebuilt immediately
   * but the cosine scan kept scoring against stale vectors until restart. Individual phrase
   * embedding failures are skipped: Fuse still covers the phrase, so a single bad embed must
   * not sink the batch.
   */
  async addLearnedExamples(intent, phrases) {
    if (!this.extractor || !phrases || phrases.length === 0 || !this.intentVectors) return;
    const vectors = this.intentVectors[intent] || [];
    for (const phrase of phrases) {
      try {
        const result = await this.extractor(phrase, { pooling: 'mean', normalize: true });
        vectors.push(result.data);
      } catch {
        // skip — see method doc
      }
    }
    this.intentVectors[intent] = vectors;
  }

  /** Compute diff between last known state and current projects, returning only added/changed entries. */
  _computeProjectDiff(projects) {
    const diff = computeProjectDiff(projects, this.lastProjectIntents);
    this.lastProjectIntents = diff.next;
    return { full: diff.full, changed: diff.changed, removed: diff.removed };
  }

  async addProjectIntents(projects) {
    if (!this.extractor) return;
    if (!projects) return;
    // Watcher-driven (index.js) and scan-driven (projectRoutes.js) updates can arrive
    // concurrently and all mutate the same project-intent vectors + Fuse items; route every
    // mutation through one mutex so diffs and index rebuilds stay atomic.
    await this._projectIntentsMutex.runExclusive(() => this._applyProjectIntents(projects));
  }

  async _applyProjectIntents(projects) {
    const diff = this._computeProjectDiff(projects);

    if (diff.full) {
      const totalEntries = projects.reduce((s, p) => s + (p.config?.entries?.length || 0), 0);
      if (totalEntries === 0) return;
      console.log(`[SemanticMatcher] Adding ${totalEntries} project-specific intents (full recompute)...`);
      this.projectIntentVectors = {};
      this.projectFuseItems = [];
      let count = 0;
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
          const vectors = [];
          for (const trigger of triggers) {
            const result = await this.extractor(trigger, { pooling: 'mean', normalize: true });
            vectors.push(result.data);
            this.projectFuseItems.push({ intent: intentName, text: trigger, isProject: true });
          }
          this.projectIntentVectors[intentName] = { vectors, projectIndex: pIdx, entryIndex: eIdx };
          count++;
        }
      }
      this._rebuildFuseIndex();
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
      delete this.projectIntentVectors[intentName];
      this.projectFuseItems = this.projectFuseItems.filter(f => f.intent !== intentName);
    }

    if (!diff.changed || diff.changed.length === 0) {
      if (removedEntries.length > 0) {
        this._rebuildFuseIndex();
        console.log(`[SemanticMatcher] Removed ${removedEntries.length} deleted entries`);
      } else {
        console.log('[SemanticMatcher] No project intent changes detected');
      }
      return;
    }

    console.log(`[SemanticMatcher] Incremental update: ${diff.changed.length} entries changed`);
    for (const { pIdx, eIdx, entry } of diff.changed) {
      const intentName = entry.type === 'command'
        ? `project.action.${pIdx}.${eIdx}`
        : `project.knowledge.${pIdx}.${eIdx}`;

      // Remove old Fuse items for this intent
      this.projectFuseItems = this.projectFuseItems.filter(f => f.intent !== intentName);

      const triggers = entry.triggers || [];
      if (triggers.length === 0) {
        delete this.projectIntentVectors[intentName];
        continue;
      }

      const vectors = [];
      for (const trigger of triggers) {
        const result = await this.extractor(trigger, { pooling: 'mean', normalize: true });
        vectors.push(result.data);
        this.projectFuseItems.push({ intent: intentName, text: trigger, isProject: true });
      }
      this.projectIntentVectors[intentName] = { vectors, projectIndex: pIdx, entryIndex: eIdx };
    }
    this._rebuildFuseIndex();
    console.log(`[SemanticMatcher] Incremental update complete — ${diff.changed.length} intents rebuilt`);
  }

  async clearProjectIntents() {
    // Same mutex as addProjectIntents — a clear landing mid-add would otherwise wipe state the
    // in-flight add is still writing to (watcher events call clear then add back-to-back).
    await this._projectIntentsMutex.runExclusive(() => {
      this.projectIntentVectors = {};
      this.projectFuseItems = [];
      // Drop the diff snapshot too: the next addProjectIntents must see the cleared state as a
      // full recompute, otherwise an unchanged project set diff's to "no changes" and the empty
      // vector store silently stays empty until restart (confirmed live 2026-08-06 audit).
      this.lastProjectIntents = null;
      if (this.ready) this._rebuildFuseIndex();
    });
  }

  async match(input) {
    // Full stage pipeline (pre-semantic overrides -> embedding -> fuzzy -> keyword) lives in
    // matcherMatch.js (Phase 3 decomposition); this reads the singleton's live state.
    return runMatchPipeline(this, input);
  }

  /**
   * Best-scoring project config command entry (project.action.*) for one project, computed
   * independently of the global builtin cluster — used by matcher.js stage 1b to let a
   * project's own hand-authored command entries win over generic run-family builtins
   * (run_project / npm_run) instead of losing the embedding race to their large phrase
   * clusters. Returns { entryIndex, vectorIndex, score } or null.
   */
  async bestProjectCommandEntry(input, projectIndex) {
    if (!this.ready) {
      try {
        await this.initialize();
      } catch {
        return null;
      }
    }
    const inputStr = (input || '').trim().toLowerCase();
    if (!inputStr) return null;
    try {
      const v = await this.extractor(inputStr, { pooling: 'mean', normalize: true });
      return bestProjectActionVector(v.data, this.projectIntentVectors, projectIndex);
    } catch {
      return null;
    }
  }

  getAndClearLastTelemetry() {
    const t = this._lastTelemetry;
    this._lastTelemetry = null;
    return t;
  }

  /**
   * Best-effort "did you mean" suggestions for when match() comes back empty — delegates to
   * the Fuse.js search in matcherFuse.js (Phase 3 decomposition).
   */
  getSuggestions(input, limit = getTuning('SUGGESTION_DEFAULT_LIMIT', SUGGESTION_DEFAULT_LIMIT)) {
    return searchFuseSuggestions(this.fuseIndex, input, limit);
  }

  /**
   * Raw best-scoring intent with NO floor or margin gating — used by matcher.js's no-match
   * path to offer a non-blocking "did you mean" chip when nothing cleared the normal gates but
   * the embedding still strongly favors one intent (callers gate on the returned confidence
   * themselves; this app's threshold is 0.45). Returns { intent, confidence, meta } or null.
   */
  async nearestIntent(inputStr) {
    return computeNearestIntent(this.extractor, inputStr, this.projectIntentVectors, this.intentVectors);
  }

  async matchMulti(input) {
    return matchMultiParts(this, input);
  }

  /**
   * Average the per-phrase embedding vectors for each intent into a single
   * representative vector, then compare every pair. Returns pairs whose cosine
   * similarity exceeds `threshold` — these intents may be hard for the model
   * to distinguish.
   */
  findIntentCollisions(threshold = getTuning('COLLISION_DEFAULT_THRESHOLD', COLLISION_DEFAULT_THRESHOLD)) {
    return computeIntentCollisions(this.intentVectors, threshold);
  }
}

export const semanticMatcher = new SemanticMatcher();
