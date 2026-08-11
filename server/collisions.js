// Phase 7 (2026-08-11): baseline-persisted intent-collision monitoring. The `check
// collisions` chat command shows the CURRENT overlaps on demand (connectionTelemetry.js);
// this module remembers what the last boot saw, so the startup sweep can alert when NEW
// collisions appeared since — a new overlap between intent clusters usually means a phrase
// example regressed (the same drift the check-matcher/check-intents harnesses catch, but for
// embeddings, and without needing to remember to run anything).
//
// Persistence: data/collisions.json (gitignored) — { baseline: [{intentA, intentB,
// similarity}], updatedAt }. Pair identity is unordered (A↔B is one pair).
//
// checkCollisionBaseline() is called from server/index.js after the semantic matcher is
// ready and initNotifications() has loaded the rules. It never blocks boot: it runs in the
// background, fires the opt-in 'collision-found' notification event for genuinely new pairs,
// then persists the new baseline. Nothing else reads the baseline, so a corrupt/missing file
// just means "first boot" — the current collisions become the baseline silently.

import fs from 'fs';
import path from 'path';
import { semanticMatcher } from './semanticMatcher.js';
import { notify } from './notify.js';

const COLLISIONS_FILE = path.join(process.cwd(), 'data', 'collisions.json');

const DEFAULT_THRESHOLD = 0.9;

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

function loadBaseline() {
  try {
    if (!fs.existsSync(COLLISIONS_FILE)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(COLLISIONS_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.baseline)) return new Map();
    const map = new Map();
    for (const c of parsed.baseline) {
      if (c && typeof c.intentA === 'string' && typeof c.intentB === 'string') {
        map.set(pairKey(c.intentA, c.intentB), c.similarity);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function persistBaseline(collisions, updatedAt) {
  try {
    fs.mkdirSync(path.dirname(COLLISIONS_FILE), { recursive: true });
    fs.writeFileSync(COLLISIONS_FILE, JSON.stringify({ baseline: collisions, updatedAt }, null, 2));
  } catch {
    // best-effort — a failed persist means the next boot reports the same collisions again
  }
}

/**
 * Compute current collisions, notify about pairs the persisted baseline did not contain,
 * and store the new baseline. Fire-and-forget; safe to call once at startup. Returns the
 * list of new pairs for callers that want to answer inline (none today — see connection
 * telemetry's `check collisions` for the on-demand view).
 */
export async function checkCollisionBaseline(threshold = DEFAULT_THRESHOLD) {
  const current = semanticMatcher.findIntentCollisions(threshold) || [];
  const baseline = loadBaseline();
  const now = Date.now();

  const newPairs = current.filter((c) => !baseline.has(pairKey(c.intentA, c.intentB)));
  persistBaseline(current, now);

  if (newPairs.length === 0) return [];

  const summary = newPairs
    .slice(0, 6)
    .map((c) => `\`${c.intentA}\` ↔ \`${c.intentB}\` (${(c.similarity * 100).toFixed(1)}%)`)
    .join('\n');
  await notify('console', 'collision-found', {
    title: `New intent collisions on this boot (${newPairs.length})`,
    body: `${summary}${newPairs.length > 6 ? `\n…and ${newPairs.length - 6} more` : ''}\nRun \`check collisions\` in any chat for the full list.`,
  });
  return newPairs;
}
