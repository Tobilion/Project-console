// Embedding-model boot (2026-08-24, split out of semanticMatcher.js): the initialize()
// sequence — lazy model import, the download race against a deadline, the bounded-concurrency
// phrase batch, and the ready/initError state transitions. The owner (SemanticMatcher)
// provides extractor/state; this module owns the boot sequence itself.

import { broadcast } from './wsServer.js';
import { INTENTS } from './intentsData.js';
import { getTuning } from './tuningStore.js';
import { INIT_WAIT_POLL_MS, INIT_DOWNLOAD_TIMEOUT_MS } from './semanticMatcher.js';
import { log } from './logger.js';

/** Boot sequence; see SemanticMatcher.initialize()'s old doc comment for the failure story. */
export async function initializeMatcher(owner) {
  if (owner.ready) return;
  // A prior download/embedding failure must short-circuit instead of re-running the whole
  // 120s download attempt on every match() call (match() → semantic stage → initialize()).
  // Callers already degrade gracefully to the fuzzy/NLP stages on initError.
  if (owner.initError) throw owner.initError;
  if (owner.initializing) {
    while (!owner.ready && !owner.initError) {
      await new Promise(r => setTimeout(r, getTuning('INIT_WAIT_POLL_MS', INIT_WAIT_POLL_MS)));
    }
    if (owner.initError) throw owner.initError;
    return;
  }
  owner.initializing = true;

  try {
    // Lazy load — see the note at the top of semanticMatcher.js about why this is not a
    // static import.
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = './.cache/xenova';
    broadcast({ type: 'semantic_matcher_progress', data: { stage: 'downloading', percent: 0 } });
    log.info('[SemanticMatcher] Loading embedding model (first load downloads ~23MB)...');
    // A stalled HuggingFace download (an offline/proxied/rate-limited connection that
    // neither resolves nor rejects) previously hung initialize() forever: index.js awaits it
    // before the port-fallback listen loop, so the whole server never bound, and every
    // concurrent caller's ready/initError poll loop spun forever (audit 2026-08-06, Phase 2).
    // Race the download against a deadline — on timeout this fails exactly like a real
    // download failure (initError set, callers already degrade gracefully to the fuzzy/NLP
    // stages), and the losing pipeline promise can't clobber anything because the race
    // settled first.
    let downloadTimer;
    owner.extractor = await Promise.race([
      pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true }),
      new Promise((_, reject) => {
        downloadTimer = setTimeout(
          () => reject(new Error(`Embedding model download timed out after ${INIT_DOWNLOAD_TIMEOUT_MS / 1000}s — semantic matching unavailable this session.`)),
          INIT_DOWNLOAD_TIMEOUT_MS
        );
      }),
    ]).finally(() => clearTimeout(downloadTimer));
    broadcast({ type: 'semantic_matcher_progress', data: { stage: 'embedding', percent: 50 } });
    log.info('[SemanticMatcher] Model loaded, computing intent embeddings...');

    owner.intentVectors = {};
    // Phase 6: embed the whole phrase corpus in one bounded-concurrency batch instead of
    // serially — ~2500 phrases at 8 in flight is the single largest boot-time reduction.
    const phraseTasks = [];
    for (const [intent, config] of Object.entries(INTENTS)) {
      for (const example of config.examples) {
        phraseTasks.push({ intent, example });
      }
    }
    const phraseResults = await owner._embedBatch(phraseTasks.map((t) => t.example));
    for (let i = 0; i < phraseTasks.length; i++) {
      const { intent } = phraseTasks[i];
      if (!owner.intentVectors[intent]) owner.intentVectors[intent] = [];
      owner.intentVectors[intent].push(phraseResults[i].data);
    }

    owner._rebuildFuseIndex();

    owner.ready = true;
    broadcast({ type: 'semantic_matcher_progress', data: { stage: 'ready', percent: 100 } });
    log.info(`[SemanticMatcher] Ready — ${Object.keys(INTENTS).length} base intents, ${Object.values(INTENTS).reduce((s, c) => s + c.examples.length, 0)} phrases`);
    // First-message warm-up (Phase 6): the phrase batch above warms the model runtime, but
    // the first INPUT embed still pays one-off tokenizer/thread-pool setup inside the model.
    // Fire one throwaway embed (cached under 'warm-up check', harmless) so the first real
    // user message doesn't pay it. Fire-and-forget — never blocks ready.
    owner.embedInput('warm-up check').catch(() => {});
  } catch (err) {
    owner.initError = err;
    log.error('[SemanticMatcher] Failed:', err.message);
    throw err;
  } finally {
    owner.initializing = false;
  }
}