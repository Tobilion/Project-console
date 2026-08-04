import { pipeline, env } from '@xenova/transformers';
import Fuse from 'fuse.js';
import { INTENTS } from './intentsData.js';
import { getEffectiveThreshold } from './intentTelemetry.js';
import { broadcast } from './wsServer.js';
import { findPreSemanticOverride } from './preSemanticOverrides.js';
import { matchKeywordRule } from './keywordRules.js';
import { runSemanticStage, runFuzzyStage } from './matcherStages.js';
import { scanAllVectors, bestProjectActionVector, averageIntentVectors, cosineSimilarity } from './intentVectorScan.js';

env.cacheDir = './.cache/xenova';

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
  }

  async initialize() {
    if (this.ready) return;
    if (this.initializing) {
      while (!this.ready && !this.initError) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (this.initError) throw this.initError;
      return;
    }
    this.initializing = true;

    try {
      broadcast({ type: 'semantic_matcher_progress', data: { stage: 'downloading', percent: 0 } });
      console.log('[SemanticMatcher] Loading embedding model (first load downloads ~23MB)...');
      this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
      });
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
      // 0.4 was cutting off single-edit typos on short inputs (e.g. "hep" -> "help") before
      // they ever reached the code's own fuzzyFloor check below. 0.55 lets more near-misses
      // through to that second gate, which still filters on confidence per input length.
      threshold: 0.55,
      includeScore: true,
      minMatchCharLength: 2,
      ignoreLocation: true,
    });
  }

  /** Add items to the Fuse index incrementally without a full rebuild. */
  _addFuseItems(items) {
    if (!this.fuseIndex) return;
    for (const item of items) {
      this.fuseIndex.add(item);
    }
  }

  /** Remove items from the Fuse index by a predicate. */
  _removeFuseItems(predicate) {
    if (!this.fuseIndex) return;
    const toRemove = [];
    for (let i = this.fuseIndex.list.length - 1; i >= 0; i--) {
      if (predicate(this.fuseIndex.list[i])) {
        toRemove.push(this.fuseIndex.list[i]);
      }
    }
    for (const item of toRemove) {
      try { this.fuseIndex.remove((doc) => doc === item); } catch {}
    }
  }

  /** Compute diff between last known state and current projects, returning only added/changed entries. */
  _computeProjectDiff(projects) {
    const current = projects.map(p => ({
      id: p.id,
      entries: (p.config?.entries || []).map(e => ({
        type: e.type, triggers: e.triggers || [], action: e.action,
      })),
    }));
    if (!this.lastProjectIntents) {
      this.lastProjectIntents = current;
      // Full recompute
      return { full: true, changed: null };
    }
    const changed = [];
    for (let pIdx = 0; pIdx < current.length; pIdx++) {
      const cur = current[pIdx];
      const prev = this.lastProjectIntents.find(p => p.id === cur.id);
      if (!prev) {
        // New project — all its entries are new
        for (let eIdx = 0; eIdx < cur.entries.length; eIdx++) {
          changed.push({ pIdx, eIdx, entry: cur.entries[eIdx] });
        }
      } else {
        const maxEntries = Math.max(prev.entries.length, cur.entries.length);
        for (let eIdx = 0; eIdx < maxEntries; eIdx++) {
          const curEntry = cur.entries[eIdx];
          const prevEntry = prev.entries[eIdx];
          if (!curEntry) continue; // entry removed — handle below
          if (!prevEntry || JSON.stringify(curEntry.triggers) !== JSON.stringify(prevEntry.triggers)) {
            changed.push({ pIdx, eIdx, entry: curEntry });
          }
        }
      }
    }
    this.lastProjectIntents = current;
    return { full: false, changed };
  }

  async addProjectIntents(projects) {
    if (!this.extractor) return;
    if (!projects) return;

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

    if (!diff.changed || diff.changed.length === 0) {
      console.log('[SemanticMatcher] No project intent changes detected');
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

  clearProjectIntents() {
    this.projectIntentVectors = {};
    this.projectFuseItems = [];
    if (this.ready) this._rebuildFuseIndex();
  }

  async match(input) {
    if (!this.ready) {
      try {
        await this.initialize();
      } catch {
        return null;
      }
    }

    const inputStr = input.trim().toLowerCase();
    if (!inputStr) return null;

    const _stages = [];

    // 0. Literal pre-checks for phrases confirmed (via live user testing, not just theory) to
    // get misclassified by pure embedding similarity to a superficially-similar but wrong
    // intent. Data + rationale live in preSemanticOverrides.js (Phase 5 split, 2026-08-04) —
    // the check itself is unchanged.
    const override = findPreSemanticOverride(inputStr);
    if (override) {
      _stages.push({ stage: 'literal_override', intent: override.intent, confidence: 0.9, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'literal_override', finalIntent: override.intent, finalConfidence: 0.9 };
      return { intent: override.intent, confidence: 0.9, source: 'keyword' };
    }

    // 1. Semantic matching via embedding cosine similarity (stage runner in matcherStages.js,
    // Phase 5 split — floor/margin/collision/closeSecond logic and telemetry shape unchanged)
    try {
      const sem = await runSemanticStage(inputStr, {
        extractor: this.extractor,
        projectIntentVectors: this.projectIntentVectors,
        intentVectors: this.intentVectors,
        getFloor: getEffectiveThreshold,
      });
      _stages.push(sem.stage);
      if (sem.result) {
        this._lastTelemetry = { stages: _stages, winner: 'semantic', finalIntent: sem.result.intent, finalConfidence: sem.result.confidence };
        return sem.result;
      }
    } catch (err) {
      _stages.push({ stage: 'semantic', matched: false, error: err.message });
    }

    // 2. Fuse.js fuzzy fallback (stage runner in matcherStages.js, Phase 5 split)
    const fz = runFuzzyStage(inputStr, this.fuseIndex);
    _stages.push(fz.stage);
    if (fz.result) {
      this._lastTelemetry = { stages: _stages, winner: 'fuzzy', finalIntent: fz.result.intent, finalConfidence: fz.result.confidence };
      return fz.result;
    }

    // 3. Keyword fallback for common patterns (rules + first-match-wins semantics in
    // keywordRules.js, Phase 5 split — per-rule confidences and telemetry shape unchanged)
    const kwRule = matchKeywordRule(inputStr);
    if (kwRule) {
      _stages.push({ stage: 'keyword', intent: kwRule.intent, confidence: kwRule.confidence, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: kwRule.intent, finalConfidence: kwRule.confidence };
      return { intent: kwRule.intent, confidence: kwRule.confidence, source: 'keyword' };
    }

    _stages.push({ stage: 'keyword', matched: false });
    this._lastTelemetry = { stages: _stages, winner: null, finalIntent: null, finalConfidence: 0 };
    return null;
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
   * Best-effort "did you mean" suggestions for when match() comes back empty. Reuses the
   * Fuse.js fuzzy index (built from both base-intent example phrases and project-specific
   * triggers) instead of the plain embedding search, since Fuse ranks by literal string
   * similarity — closer to what a human would guess caused the near-miss than cosine
   * similarity would be at this point (the input already failed the embedding pass).
   */
  getSuggestions(input, limit = 5) {
    if (!this.fuseIndex || !input?.trim()) return [];
    const results = this.fuseIndex.search(input.trim().toLowerCase());
    const seen = new Set();
    const out = [];
    for (const r of results) {
      const text = r.item.text;
      if (seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= limit) break;
    }
    return out;
  }

  _splitConjunctions(input) {
    // Confirmed live 2026-07-29: `push this code with comment "Massive Memory and Learning
    // improvements"` has "and" sitting right inside a quoted commit message that was never meant
    // to be split at all — this function has no concept of quote boundaries, so it would happily
    // chop that string into two "intents" at the word "and" regardless of the quotes around it.
    // The regex bug that actually caused the observed truncation lived in builtinIntents.js's own
    // comment-parsing (now fixed — see extractCommentMessage), but this splitter had the same
    // blind spot and could still misfire the same way for any other quoted argument (file
    // content, a URL, etc.) that happens to contain one of these conjunction words. Since a
    // multi-intent split is only ever a convenience for genuinely separate requests ("show
    // structure and run tests"), not something any quoted-argument command needs, just skip
    // splitting entirely whenever the input contains a quote character — safer to fall through to
    // normal single-intent matching (which already treats the whole string as one request) than
    // to risk cutting a quoted value in half.
    if (/["']/.test(input)) return null;
    // Split on common conjunctions (non-capturing groups to avoid split artifacts)
    const separators = /\s+(?:and|also|then|plus)\s+|,\s*|;\s*|\s+&\s+|\s+as well as\s+/i;
    const parts = input.split(separators).map(s => s.trim()).filter(s => s && s.length > 3);
    return parts.length > 1 ? parts : null;
  }

  /**
   * Raw best-scoring intent with NO floor or margin gating — used by matcher.js's no-match
   * path to offer a non-blocking "did you mean" chip when nothing cleared the normal gates but
   * the embedding still strongly favors one intent (callers gate on the returned confidence
   * themselves; this app's threshold is 0.45). Returns { intent, confidence, meta } or null.
   */
  async nearestIntent(inputStr) {
    if (!this.extractor) return null;
    try {
      const inputVec = await this.extractor(inputStr, {
        pooling: 'mean',
        normalize: true,
      });
      let bestIntent = null;
      let bestScore = -1;
      let bestMeta = null;
      const consider = (sim, intent, meta) => {
        if (sim > bestScore) {
          bestScore = sim;
          bestIntent = intent;
          bestMeta = meta;
        }
      };
      scanAllVectors(inputVec.data, this.projectIntentVectors, this.intentVectors, consider);
      if (bestIntent) return { intent: bestIntent, confidence: bestScore, meta: bestMeta };
      return null;
    } catch (err) {
      return null;
    }
  }

  async matchMulti(input) {
    const parts = this._splitConjunctions(input);
    if (!parts) return null;

    const results = [];
    const seenIntents = new Set();

    for (const part of parts) {
      const r = await this.match(part);
      if (r && !seenIntents.has(r.intent)) {
        seenIntents.add(r.intent);
        results.push({ ...r, originalPhrase: part });
      }
    }

    if (results.length <= 1) return null;
    return results;
  }

  /**
   * Average the per-phrase embedding vectors for each intent into a single
   * representative vector, then compare every pair. Returns pairs whose cosine
   * similarity exceeds `threshold` — these intents may be hard for the model
   * to distinguish.
   */
  findIntentCollisions(threshold = 0.9) {
    if (!this.intentVectors) return [];
    const avgVectors = averageIntentVectors(this.intentVectors);
    const collisions = [];
    const seen = new Set();
    for (const [a, va] of Object.entries(avgVectors)) {
      for (const [b, vb] of Object.entries(avgVectors)) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (a === b || seen.has(key)) continue;
        seen.add(key);
        const sim = cosineSimilarity(va, vb);
        if (sim >= threshold) {
          collisions.push({ intentA: a, intentB: b, similarity: sim });
        }
      }
    }
    collisions.sort((a, b) => b.similarity - a.similarity);
    return collisions;
  }
}

export const semanticMatcher = new SemanticMatcher();
