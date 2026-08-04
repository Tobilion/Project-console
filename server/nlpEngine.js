import { NlpManager } from 'node-nlp';
import { NLP_SEED_INTENTS } from './nlpSeedIntents.js';

class IntentClassifier {
  constructor() {
    this.manager = new NlpManager({
      languages: ['en'],
      forceNER: true,
      nlu: { log: false }
    });
    this.isTrained = false;
    this.initializeDefaultIntents();
  }

  initializeDefaultIntents() {
    for (const [phrase, intent] of NLP_SEED_INTENTS) {
      this.manager.addDocument('en', phrase, intent);
    }
  }

  clearProjectDocs(projects) {
    if (!projects) return;
    projects.forEach((project, projectIndex) => {
      if (project.config && project.config.entries) {
        project.config.entries.forEach((entry, entryIndex) => {
          if (Array.isArray(entry.triggers)) {
            entry.triggers.forEach(trigger => {
              const intentName = entry.type === 'command'
                ? `project.action.${projectIndex}.${entryIndex}`
                : `project.knowledge.${projectIndex}.${entryIndex}`;
              this.manager.removeDocument('en', trigger, intentName);
            });
          }
        });
      }
    });
  }

  /**
   * Adds one confirmed real-usage phrase to the classifier's training set without a full
   * retrain — call `retrainFromLearned()` after a batch of these to actually refit the model.
   * This is what lets nlpEngine (an actual trained NLP.js classifier, not just curated examples)
   * improve from real usage instead of only ever training on the fixed phrases hand-written in
   * `initializeDefaultIntents()` below. Confirmed live 2026-07-29: the semantic matcher's example
   * list already gets new confirmed phrases from `learningEngine.js`'s near-miss auto-promotion
   * (see semanticMatcher.js / learnedIntents.js), but this classifier never did — it was retrained
   * once at startup and then frozen for the rest of the process's life, silently missing out on
   * every phrase the near-miss loop had already validated as correct.
   */
  addLearnedPhrase(phrase, intentName) {
    this.manager.addDocument('en', phrase, intentName);
  }

  /** Refits the classifier against everything added via addLearnedPhrase() since last train(). */
  async retrainFromLearned() {
    await this.manager.train();
    this.isTrained = true;
  }

  async train(projects) {
    this.clearProjectDocs(projects);
    if (projects) {
      projects.forEach((project, projectIndex) => {
        if (project.config && project.config.entries) {
          project.config.entries.forEach((entry, entryIndex) => {
            if (Array.isArray(entry.triggers)) {
              entry.triggers.forEach(trigger => {
                const intentName = entry.type === 'command'
                  ? `project.action.${projectIndex}.${entryIndex}`
                  : `project.knowledge.${projectIndex}.${entryIndex}`;
                this.manager.addDocument('en', trigger, intentName);
              });
            }
          });
        }
      });
    }

    // Confirmed live 2026-07-30 (reported directly: "every time it scans the site reloads",
    // triggered by scanning C:\Users\tobil\Desktop\tobi-portfolio): `this.manager.save()` used to
    // run here with no path argument, which node-nlp resolves to `./model.nlp` relative to
    // process.cwd() — the console's own repo root, since it's launched via `npm run dev` from
    // there. That file is nowhere in Vite's `watch.ignored` list (only `data/`/`.cache/`/
    // `*.console/` are excluded — see index.js/vite.config.ts), so every retrain rewrote it and
    // Vite treated it as a real source change, forcing a full-page reload. Nothing in this file
    // (or anywhere else in the codebase) ever calls `.load()` to read `model.nlp` back — the
    // classifier is always rebuilt fresh from `initializeDefaultIntents()` + learned phrases on
    // every process start (see train() below and index.js's startup sequence) — so this save was
    // pure dead weight with an active bug attached, not a working persistence feature. Removed
    // rather than just re-pointed at an already-ignored directory like `data/`, since there's no
    // code path that would ever read it back; if real save/load persistence is wanted later, it
    // should write under `data/` (already excluded from Vite's watch) and pair the save with an
    // actual `.load()` call on startup instead of writing a file nothing consumes.
    await this.manager.train();
    this.isTrained = true;
  }

  async classify(input) {
    if (!this.isTrained) {
      await this.train();
    }
    const response = await this.manager.process('en', input);
    
    if (response.intent !== 'None' && response.score > 0.45) {
      return {
        intent: response.intent,
        score: response.score,
        answer: response.answer
      };
    }
    return null;
  }
}

export const nlpEngine = new IntentClassifier();
