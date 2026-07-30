#!/usr/bin/env node
/**
 * Dev-only static checker for intentsData.js's example phrases (2026-07-30, requested directly —
 * "how can we make managing ~2000 phrases easier"). Complements, rather than replaces, the
 * console's own live "check collisions" chat command: that command computes real embedding
 * cosine similarity between whole intents (needs the transformer model loaded, so it only works
 * against a running server). This script is a cheap, instant, no-server-needed text-level check —
 * catches the easy, common mistake (copy-pasting a phrase into the wrong intent, or duplicating
 * one within the same intent) before you ever get to the point of running the live check.
 *
 * Usage: `node server/scripts/checkIntentDuplicates.js` (or `npm run check-intents`).
 * Exits 0 always — this is advisory, not a build gate; use judgment on what it reports.
 */
import { INTENTS } from '../intentsData.js';

function normalize(phrase) {
  return phrase
    .toLowerCase()
    .replace(/['"`]/g, '') // "how's it going" vs "hows it going" should compare equal
    .replace(/[^\w\s]/g, ' ') // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain iterative-DP Levenshtein — no dependency, fine at this scale once length-bucketed below.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

function main() {
  // Flatten to { intent, original, normalized } for every example across every intent.
  const all = [];
  for (const [intent, config] of Object.entries(INTENTS)) {
    for (const phrase of config.examples || []) {
      all.push({ intent, original: phrase, normalized: normalize(phrase) });
    }
  }
  console.log(`Scanning ${all.length} example phrases across ${Object.keys(INTENTS).length} intents...\n`);

  // --- Exact duplicates (same normalized text) ---
  const byNormalized = new Map();
  for (const item of all) {
    if (!byNormalized.has(item.normalized)) byNormalized.set(item.normalized, []);
    byNormalized.get(item.normalized).push(item);
  }

  const withinIntentDupes = [];
  const crossIntentDupes = [];
  for (const [normalized, items] of byNormalized) {
    if (items.length < 2) continue;
    const intents = new Set(items.map((i) => i.intent));
    if (intents.size === 1) {
      withinIntentDupes.push({ normalized, items });
    } else {
      crossIntentDupes.push({ normalized, items });
    }
  }

  console.log(`--- Exact duplicates within the same intent (${withinIntentDupes.length}) ---`);
  console.log('(Harmless but redundant — safe to delete the repeat.)\n');
  for (const { items } of withinIntentDupes) {
    console.log(`  [${items[0].intent}] "${items[0].original}" appears ${items.length}x`);
  }

  console.log(`\n--- Exact duplicates across DIFFERENT intents (${crossIntentDupes.length}) ---`);
  console.log('(Real ambiguity — the same phrase is claimed by more than one intent. Worth fixing.)\n');
  for (const { items } of crossIntentDupes) {
    const byIntent = [...new Set(items.map((i) => `${i.intent} ("${i.original}")`))].join('  vs.  ');
    console.log(`  ${byIntent}`);
  }

  // --- Near-duplicates across different intents (cheap edit-distance check) ---
  // Length-bucketed to avoid an O(n^2) blowup across ~2000 phrases: only compares phrases whose
  // normalized length differs by at most 3 characters, since anything further apart can't be
  // within a small edit distance anyway.
  const NEAR_DUP_MAX_DISTANCE = 2;
  const byLengthBucket = new Map();
  for (const item of all) {
    const bucket = Math.floor(item.normalized.length / 4);
    if (!byLengthBucket.has(bucket)) byLengthBucket.set(bucket, []);
    byLengthBucket.get(bucket).push(item);
  }

  const nearDupes = [];
  const seenPairs = new Set();
  for (const [bucket, items] of byLengthBucket) {
    const neighbors = [...(byLengthBucket.get(bucket) || []), ...(byLengthBucket.get(bucket + 1) || [])];
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < neighbors.length; j++) {
        const a = items[i], b = neighbors[j];
        if (a === b || a.intent === b.intent) continue;
        if (a.normalized === b.normalized) continue; // already caught above as an exact dupe
        const pairKey = a.normalized < b.normalized ? `${a.normalized}|${b.normalized}` : `${b.normalized}|${a.normalized}`;
        if (seenPairs.has(pairKey)) continue;
        if (Math.abs(a.normalized.length - b.normalized.length) > NEAR_DUP_MAX_DISTANCE) continue;
        const dist = levenshtein(a.normalized, b.normalized);
        if (dist > 0 && dist <= NEAR_DUP_MAX_DISTANCE) {
          seenPairs.add(pairKey);
          nearDupes.push({ a, b, dist });
        }
      }
    }
  }

  console.log(`\n--- Near-duplicates across different intents, edit distance <= ${NEAR_DUP_MAX_DISTANCE} (${nearDupes.length}) ---`);
  console.log('(Worth a look — small wording differences the embedding matcher may or may not separate reliably.)\n');
  for (const { a, b, dist } of nearDupes.slice(0, 100)) {
    console.log(`  [dist ${dist}] ${a.intent}: "${a.original}"  ~=  ${b.intent}: "${b.original}"`);
  }
  if (nearDupes.length > 100) console.log(`  ...and ${nearDupes.length - 100} more (truncated).`);

  console.log(`\nDone. ${withinIntentDupes.length} within-intent dupes, ${crossIntentDupes.length} cross-intent exact dupes, ${nearDupes.length} near-duplicates.`);
  console.log('For real embedding-similarity collisions (not just text overlap), also run "check collisions" in a live chat session.');
}

main();
