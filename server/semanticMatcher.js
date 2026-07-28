import { pipeline, env } from '@xenova/transformers';
import Fuse from 'fuse.js';
import { INTENTS } from './intentsData.js';
import { getEffectiveThreshold } from './intentTelemetry.js';
import { broadcast } from './wsServer.js';

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

    // 0. Literal pre-checks for phrases confirmed (via live user testing, not just theory) to get
    // misclassified by pure embedding similarity to a superficially-similar but wrong intent —
    // e.g. "initialize git" / "deploy to my git" both landed on git_status ("check git") instead
    // of git_init / system.chit_chat.deploy, and "add X to gitignore" landed on a generic tech
    // preview response instead of git_ignore_add. These three tokens are unambiguous enough in
    // this app's domain that a literal match should always win outright, before the embedding
    // stage ever gets a vote. Keep this list short and deliberately narrow — it's a targeted fix
    // for confirmed traps, not a replacement for the semantic/fuzzy/keyword pipeline below.
    const PRE_SEMANTIC_OVERRIDES = [
      { intent: 'git_init', pattern: /\bgit\s+init\b|\b(initialize|init)\b.*\brepo(sitory)?\b|\b(initialize|init)\b.*\bgit\b/i },
      { intent: 'git_ignore_add', pattern: /\bgiti?gnore\b/i },
      { intent: 'system.chit_chat.deploy', pattern: /\bdeploy\b|\bpush\s+live\b/i },
    ];
    for (const { intent, pattern } of PRE_SEMANTIC_OVERRIDES) {
      if (pattern.test(inputStr)) {
        _stages.push({ stage: 'literal_override', intent, confidence: 0.9, matched: true });
        this._lastTelemetry = { stages: _stages, winner: 'literal_override', finalIntent: intent, finalConfidence: 0.9 };
        return { intent, confidence: 0.9, source: 'keyword' };
      }
    }

    // 1. Semantic matching via embedding cosine similarity
    try {
      const inputVec = await this.extractor(inputStr, {
        pooling: 'mean',
        normalize: true,
      });
      const inputData = inputVec.data;

      let bestIntent = null;
      let bestScore = -1;
      let bestMeta = null;
      let secondBestScore = -1;

      const consider = (sim, intent, meta) => {
        if (sim > bestScore) {
          secondBestScore = bestScore;
          bestScore = sim;
          bestIntent = intent;
          bestMeta = meta;
        } else if (sim > secondBestScore) {
          secondBestScore = sim;
        }
      };

      for (const [intent, data] of Object.entries(this.projectIntentVectors)) {
        for (const vec of data.vectors) {
          consider(this._cosineSimilarity(inputData, vec), intent, { projectIndex: data.projectIndex, entryIndex: data.entryIndex });
        }
      }

      for (const [intent, vectors] of Object.entries(this.intentVectors)) {
        for (const vec of vectors) {
          consider(this._cosineSimilarity(inputData, vec), intent, null);
        }
      }

      const effectiveFloor = bestIntent ? getEffectiveThreshold(bestIntent) : 0.6;
      const MIN_MARGIN = 0.03;
      const margin = bestScore - secondBestScore;
      _stages.push({ stage: 'semantic', intent: bestIntent, confidence: bestScore, margin, floor: effectiveFloor, matched: bestScore >= effectiveFloor && margin >= MIN_MARGIN });

      if (bestScore >= effectiveFloor && margin >= MIN_MARGIN) {
        this._lastTelemetry = { stages: _stages, winner: 'semantic', finalIntent: bestIntent, finalConfidence: bestScore };
        return { intent: bestIntent, confidence: bestScore, source: 'semantic', meta: bestMeta };
      }
    } catch (err) {
      _stages.push({ stage: 'semantic', matched: false, error: err.message });
    }

    // 2. Fuse.js fuzzy fallback
    try {
      const fuseResults = this.fuseIndex.search(inputStr);
      if (fuseResults.length > 0) {
        const top = fuseResults[0];
        const confidence = 1 - top.score;
        const item = top.item;
        const fuzzyFloor = inputStr.length <= 3 ? 0.35 : inputStr.length <= 4 ? 0.4 : 0.55;
        _stages.push({ stage: 'fuzzy', intent: item.intent, confidence, floor: fuzzyFloor, matched: confidence >= fuzzyFloor });
        if (confidence >= fuzzyFloor) {
          const result = { intent: item.intent, confidence, source: 'fuzzy' };
          if (item.isProject) {
            const parts = item.intent.split('.');
            const pIdx = parseInt(parts[2], 10);
            const eIdx = parseInt(parts[3], 10);
            result.meta = { projectIndex: pIdx, entryIndex: eIdx };
          }
          this._lastTelemetry = { stages: _stages, winner: 'fuzzy', finalIntent: result.intent, finalConfidence: confidence };
          return result;
        }
      } else {
        _stages.push({ stage: 'fuzzy', matched: false, reason: 'no results' });
      }
    } catch {
      _stages.push({ stage: 'fuzzy', matched: false, error: 'exception' });
    }

    // 3. Keyword fallback for common patterns
    let kwMatched = false;
    if (/\b(run|start|launch|open|execute)\b/.test(inputStr) &&
        /\b(project|site|app|code|server|application)\b/.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'run_project', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'run_project', finalConfidence: 0.45 };
      return { intent: 'run_project', confidence: 0.45, source: 'keyword' };
    }
    if (/\b(thanks|thank|thx|appreciate|cheers)\b/.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'system.chit_chat.gratitude', confidence: 0.5, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'system.chit_chat.gratitude', finalConfidence: 0.5 };
      return { intent: 'system.chit_chat.gratitude', confidence: 0.5, source: 'keyword' };
    }
    if (/\b(hi|hello|hey|howdy|sup|yo)\b/.test(inputStr) && inputStr.length < 30) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'system.chit_chat.greeting', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'system.chit_chat.greeting', finalConfidence: 0.4 };
      return { intent: 'system.chit_chat.greeting', confidence: 0.4, source: 'keyword' };
    }
    if (/\b(clear|cls|clean|wipe)\b/.test(inputStr) &&
        (/\b(console|screen|chat)\b/.test(inputStr) || inputStr.length < 10)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'system.chit_chat.clear', confidence: 0.5, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'system.chit_chat.clear', finalConfidence: 0.5 };
      return { intent: 'system.chit_chat.clear', confidence: 0.5, source: 'keyword' };
    }
    if (/\b(git|change|commit)\b/.test(inputStr) &&
        /\b(status|changed|log|diff|commit)\b/.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'system.chit_chat.git_status', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'system.chit_chat.git_status', finalConfidence: 0.4 };
      return { intent: 'system.chit_chat.git_status', confidence: 0.4, source: 'keyword' };
    }
    if (/\b(push|deploy.*git|upload.*github|send.*remote)\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_push', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_push', finalConfidence: 0.4 };
      return { intent: 'git_push', confidence: 0.4, source: 'keyword' };
    }
    if (/\binitialize git|init.*repo|start git/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_init', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_init', finalConfidence: 0.45 };
      return { intent: 'git_init', confidence: 0.45, source: 'keyword' };
    }
    if (/\bgiti?gnore\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_ignore_add', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_ignore_add', finalConfidence: 0.4 };
      return { intent: 'git_ignore_add', confidence: 0.4, source: 'keyword' };
    }
    if (/\b(remove|untrack|stop tracking).*git/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_rm_cached', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_rm_cached', finalConfidence: 0.45 };
      return { intent: 'git_rm_cached', confidence: 0.45, source: 'keyword' };
    }
    if (/\brun\s+(dev|start|serve|the\s+(site|project|app))\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'run_project', confidence: 0.5, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'run_project', finalConfidence: 0.5 };
      return { intent: 'run_project', confidence: 0.5, source: 'keyword' };
    }
    if (/\bnpm\s+(serve|start|dev|build|test|run)\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'npm_run', confidence: 0.5, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'npm_run', finalConfidence: 0.5 };
      return { intent: 'npm_run', confidence: 0.5, source: 'keyword' };
    }
    if (/\bnpx\s+serve\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'run_project', confidence: 0.5, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'run_project', finalConfidence: 0.5 };
      return { intent: 'run_project', confidence: 0.5, source: 'keyword' };
    }
    if (/^(python|node)\s+\S+/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'run_project', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'run_project', finalConfidence: 0.45 };
      return { intent: 'run_project', confidence: 0.45, source: 'keyword' };
    }
    if (/\b(install|npm i)\b/i.test(inputStr) && !/\bremove|delete|uninstall\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'npm_install', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'npm_install', finalConfidence: 0.4 };
      return { intent: 'npm_install', confidence: 0.4, source: 'keyword' };
    }
    if (/\bcommit\b.*\b(changes?|work|code|files?|message|save)\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_commit', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_commit', finalConfidence: 0.4 };
      return { intent: 'git_commit', confidence: 0.4, source: 'keyword' };
    }
    if (/\bcommit\b.*\bpush\b|\bpush\b.*\bcommit\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_commit_push', confidence: 0.5, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_commit_push', finalConfidence: 0.5 };
      return { intent: 'git_commit_push', confidence: 0.5, source: 'keyword' };
    }
    if (/\bpull\b.*\b(remote|origin|latest|changes|update)\b|\bgit pull\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_pull', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_pull', finalConfidence: 0.45 };
      return { intent: 'git_pull', confidence: 0.45, source: 'keyword' };
    }
    if (/\bbuild\b.*\b(project|app|site|code|bundle)\b|\bnpm run build\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'npm_build', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'npm_build', finalConfidence: 0.45 };
      return { intent: 'npm_build', confidence: 0.45, source: 'keyword' };
    }
    if (/\b(rescan|reindex|rescann|refresh index)\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'project_scan', confidence: 0.5, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'project_scan', finalConfidence: 0.5 };
      return { intent: 'project_scan', confidence: 0.5, source: 'keyword' };
    }
    if (/\bcommit history|git log|recent commits\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_log', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_log', finalConfidence: 0.45 };
      return { intent: 'git_log', confidence: 0.45, source: 'keyword' };
    }
    if (/\b(git )?branch\b.*\b(list|show|current|what)\b|\bwhat branch\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_branch', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_branch', finalConfidence: 0.4 };
      return { intent: 'git_branch', confidence: 0.4, source: 'keyword' };
    }
    if (/\b(switch branch|checkout|change branch)\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'git_checkout', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'git_checkout', finalConfidence: 0.45 };
      return { intent: 'git_checkout', confidence: 0.45, source: 'keyword' };
    }
    if (/\b(create|make|generate|write)\b.*\bfile\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'file_create', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'file_create', finalConfidence: 0.4 };
      return { intent: 'file_create', confidence: 0.4, source: 'keyword' };
    }
    if (/\b(delete|remove|erase|trash)\b.*\bfile\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'file_delete', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'file_delete', finalConfidence: 0.4 };
      return { intent: 'file_delete', confidence: 0.4, source: 'keyword' };
    }
    if (/\b(undo|revert|rollback|go back)\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'system.chit_chat.undo', confidence: 0.5, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'system.chit_chat.undo', finalConfidence: 0.5 };
      return { intent: 'system.chit_chat.undo', confidence: 0.5, source: 'keyword' };
    }
    if (/\b(help|commands?|what can you|how.*use|tutorial)\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'system.chit_chat.help', confidence: 0.45, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'system.chit_chat.help', finalConfidence: 0.45 };
      return { intent: 'system.chit_chat.help', confidence: 0.45, source: 'keyword' };
    }
    if (/\b(test|testing|spec)\b.*\b(run|how|show|what|suite|coverage)\b/i.test(inputStr)) {
      kwMatched = true; _stages.push({ stage: 'keyword', intent: 'project.context.tests', confidence: 0.4, matched: true });
      this._lastTelemetry = { stages: _stages, winner: 'keyword', finalIntent: 'project.context.tests', finalConfidence: 0.4 };
      return { intent: 'project.context.tests', confidence: 0.4, source: 'keyword' };
    }

    if (!kwMatched) _stages.push({ stage: 'keyword', matched: false });
    this._lastTelemetry = { stages: _stages, winner: null, finalIntent: null, finalConfidence: 0 };
    return null;
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
    // Split on common conjunctions (non-capturing groups to avoid split artifacts)
    const separators = /\s+(?:and|also|then|plus)\s+|,\s*|;\s*|\s+&\s+|\s+as well as\s+/i;
    const parts = input.split(separators).map(s => s.trim()).filter(s => s && s.length > 3);
    return parts.length > 1 ? parts : null;
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

    // Compute average vector per intent
    const avgVectors = {};
    for (const [intent, vectors] of Object.entries(this.intentVectors)) {
      if (vectors.length === 0) continue;
      const n = vectors[0].length;
      const avg = new Float64Array(n);
      for (const vec of vectors) {
        for (let i = 0; i < n; i++) avg[i] += vec[i];
      }
      for (let i = 0; i < n; i++) avg[i] /= vectors.length;
      avgVectors[intent] = avg;
    }

    const collisions = [];
    const seen = new Set();

    for (const [a, va] of Object.entries(avgVectors)) {
      for (const [b, vb] of Object.entries(avgVectors)) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (a === b || seen.has(key)) continue;
        seen.add(key);

        const sim = this._cosineSimilarity(va, vb);
        if (sim >= threshold) {
          collisions.push({ intentA: a, intentB: b, similarity: sim });
        }
      }
    }

    collisions.sort((a, b) => b.similarity - a.similarity);
    return collisions;
  }

  _cosineSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}

export const semanticMatcher = new SemanticMatcher();
