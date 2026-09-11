#!/usr/bin/env node
/**
 * auditNearMiss.js — classify every near-miss log entry by failure type.
 *
 * Log sites (all in the trigger-mode pipeline):
 *   fallback — connectionMatching.js §5: nothing matched AND the guesser failed. Pure miss.
 *   guess    — connectionMatching.js §4 / connectionExecute.js direct-command: nothing matched
 *              but guessCommand inferred a shell command, shown as a confirm card. `accepted`
 *              carries the user's verdict (true/false/null = pending). A rejected guess is the
 *              closest thing these logs have to a recorded misfire.
 *   router   — connectionMatching.js: the fast pipeline missed it, the last-resort local model
 *              caught it (intentSuggestion set). A pipeline miss, not a user-visible failure.
 *
 * What these logs CANNOT show: confident wrong-intent dispatches (e.g. "commit with message
 * X" -> git_status). Those never log — the matcher believed them. Misfire evidence comes from
 * check-matcher trap rows and live-chat crosschecks, never from this file. Read the two
 * together; neither is complete alone.
 *
 * Also computes the SetFit revisit-trigger metric from CLAUDE.md: entries whose
 * resolvedCommand maps to a real intent via mapNearMissToIntent (the hard-negative
 * ingredient). Re-run anytime — the split below moves as real usage accumulates.
 *
 * Run: npm run audit-nearmiss
 */

import fs from 'fs';
import { resolveData } from '../dataPath.js';
import { mapNearMissToIntent } from '../nearMissIntentMap.js';

const dir = resolveData('near-misses');
const bySource = {};
const byAccepted = { true: 0, false: 0, null: 0 };
let total = 0;
let mappable = 0;
const mappableSamples = [];
const rejectedGuesses = [];

try {
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      total++;
      const src = e.source || '(none)';
      bySource[src] = (bySource[src] || 0) + 1;
      const acc = e.accepted === true ? 'true' : e.accepted === false ? 'false' : 'null';
      byAccepted[acc]++;
      if (e.resolvedCommand && mapNearMissToIntent(e.resolvedCommand, e.description)) {
        mappable++;
        if (mappableSamples.length < 5) mappableSamples.push({ input: e.input, command: e.resolvedCommand });
      }
      if (e.source === 'guess' && e.accepted === false && rejectedGuesses.length < 10) {
        rejectedGuesses.push({ input: e.input, command: e.resolvedCommand });
      }
    }
  }
} catch {
  console.log('no near-miss logs found.');
  process.exit(0);
}

console.log(`\n=== NEAR-MISS AUDIT (${total} entries) ===`);
console.log('by source (log site):');
for (const [s, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
  const pct = ((n / total) * 100).toFixed(1);
  const gloss = s === 'fallback' ? 'pure miss — nothing matched, guesser failed'
    : s === 'guess' ? 'guessed shell command, user verdict in accepted'
    : s === 'router' ? 'fast pipeline missed, local-model fallback caught it'
    : 'unknown site';
  console.log(`  ${s}: ${n} (${pct}%) — ${gloss}`);
}
console.log(`guess verdicts: accepted=${byAccepted.true} rejected=${byAccepted.false} pending=${byAccepted.null}`);
console.log(`SetFit-trigger metric: ${mappable} entries map to a real intent (trigger at >= 50)`);
if (mappableSamples.length) {
  console.log('  samples:');
  for (const s of mappableSamples) console.log(`    '${String(s.input).slice(0, 70)}' -> ${s.command}`);
}
if (rejectedGuesses.length) {
  console.log('rejected guesses (recorded misfires — user said no):');
  for (const r of rejectedGuesses) console.log(`    '${String(r.input).slice(0, 70)}' -> ${r.command}`);
}
console.log('NOTE: confident wrong-intent dispatches never log — see check-matcher traps + live crosschecks for those.');
