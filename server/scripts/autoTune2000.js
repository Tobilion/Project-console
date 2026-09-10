#!/usr/bin/env node
// autoTune2000.js — collect 2000 bad responses and fix them by adding to intent examples
// Runs harness in batches, collects unique fails, and appends to intent files
// No cap, continuous until 2000 fails fixed

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

const { matchInput } = await import('../matcher.js');
const { INTENTS } = await import('../intentsData.js');

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

const FILLERS = ['', 'please ', 'can you ', 'could you ', 'hey ', 'hey, ', 'so ', 'um ', 'yo ', 'hi, '];
const SUFFIXES = ['', ' please', ' thanks', ' for me', ' now', ' quickly', ' asap'];
const PUNCTS = ['', '!', '!!', '...', ' :)', ' :p', ' 🙏', ''];
const SYNONYMS = {
  open: ['open', 'show', 'launch', 'start', 'display', 'view'],
  run: ['run', 'start', 'launch', 'execute', 'fire up'],
  close: ['close', 'hide', 'dismiss', 'exit'],
  create: ['create', 'make', 'add', 'new'],
  delete: ['delete', 'remove', 'clear', 'drop'],
  show: ['show', 'list', 'display', 'tell me', 'what are'],
  reminder: ['reminder', 'remind me', 'alarm', 'alert'],
  note: ['note', 'memo', 'jot down'],
  file: ['file', 'doc', 'document'],
};
function typoOnce(s) {
  if (!s || s.length < 4) return s;
  const i = Math.floor(Math.random() * s.length);
  const ops = ['swap','drop','dup','replace'];
  const op = pickRandom(ops);
  if (op === 'swap' && i < s.length-1) return s.slice(0,i) + s[i+1] + s[i] + s.slice(i+2);
  if (op === 'drop') return s.slice(0,i) + s.slice(i+1);
  if (op === 'dup') return s.slice(0,i) + s[i] + s.slice(i);
  if (op === 'replace') return s.slice(0,i) + String.fromCharCode(97+Math.floor(Math.random()*26)) + s.slice(i+1);
  return s;
}
function varyIntentPhrase(phrase, withTypos) {
  let s = phrase;
  if (Math.random() < 0.5) s = pickRandom(FILLERS) + s;
  if (Math.random() < 0.3) s = s + pickRandom(SUFFIXES);
  for (const [k, alts] of Object.entries(SYNONYMS)) {
    if (s.includes(k) && Math.random() < 0.25) { s = s.replace(k, pickRandom(alts)); break; }
  }
  const words = s.split(' ');
  if (words.length >= 3 && Math.random() < 0.15) s = shuffle(words).join(' '); // reduced shuffle from 0.2 to 0.15
  if (withTypos && Math.random() < 0.3) {
    const w = s.split(' ');
    const idx = Math.floor(Math.random()*w.length);
    w[idx] = typoOnce(w[idx]);
    s = w.join(' ');
  }
  if (Math.random() < 0.3) s += pickRandom(PUNCTS);
  if (Math.random() < 0.15) s = s.toUpperCase();
  else if (Math.random() < 0.15) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// Map intent -> file (robust: scan every file for every intent string)
const intentFileMap = {};
const intentDir = path.join(rootDir, 'server/intents');
for (const f of fs.readdirSync(intentDir)) {
  if (!f.endsWith('.js')) continue;
  const fp = path.join(intentDir, f);
  const txt = fs.readFileSync(fp, 'utf8');
  for (const intent of Object.keys(INTENTS)) {
    if (txt.includes(`'${intent}'`) || txt.includes(`"${intent}"`)) {
      intentFileMap[intent] = fp;
    }
  }
}

const collectedFails = new Map(); // input -> {expected, got}
const seenInputs = new Set();
let totalTests = 0;
let iterations = 0;
const TARGET_FAILS = 2000;
const BATCH = 800;

console.log(`Starting auto-tune to ${TARGET_FAILS} fails, batch ${BATCH}...`);

while (collectedFails.size < TARGET_FAILS) {
  iterations++;
  const intents = Object.keys(INTENTS);
  const batchInputs = [];
  for (let i=0;i<BATCH;i++) {
    const intent = pickRandom(intents);
    const examples = INTENTS[intent].examples || [];
    if (!examples.length) continue;
    const base = pickRandom(examples);
    const input = varyIntentPhrase(base, true);
    batchInputs.push({ input, expected: intent, base });
  }
  for (const {input, expected} of batchInputs) {
    if (seenInputs.has(input)) continue;
    seenInputs.add(input);
    totalTests++;
    const r = await matchInput(input);
    const got = r?.builtin || (r?.disambiguate ? `disambiguate:${r.disambiguate.join(',')}` : (r?.multi ? 'multi' : null));
    if (got !== expected) {
      // filter out heavily shuffled nonsense: if input word count differs a lot from base or contains <2 real words
      // For now, keep all, but skip if input is very short or is single word typo that maps to unrelated
      // Keep if input length >=3 and got is not null (fallback) or got is different intent
      // Only count as fixable if expected intent is not PURE_CHITCHAT hijack due to hey prefix? Keep all for count
      // To avoid adding pure garbage, skip if input is <3 chars or >50% words are shuffled nonsense measured by not containing any expected keyword
      // Simple filter: input must contain at least one word from expected intent's example base (case-insensitive)
      // If not, it's likely shuffled garbage - skip
      const baseWords = expected ? (INTENTS[expected].examples[0] || '').toLowerCase().split(/\s+/) : [];
      const hasOverlap = baseWords.some(w => w.length>2 && input.toLowerCase().includes(w));
      // For now, count all but mark shuffled as less priority
      if (!hasOverlap && Math.random() < 0.5) continue; // skip 50% of non-overlapping shuffled
      if (!collectedFails.has(input)) {
        collectedFails.set(input, { expected, got, conf: r?.semanticConfidence, source: r?.semanticSource });
        if (collectedFails.size % 100 === 0) console.log(`  collected ${collectedFails.size}/${TARGET_FAILS} fails (tests ${totalTests}, iter ${iterations})`);
        if (collectedFails.size >= TARGET_FAILS) break;
      }
    }
  }
  console.log(`Iter ${iterations}: ${collectedFails.size}/${TARGET_FAILS} fails collected, ${totalTests} tests`);
  if (iterations > 50) break; // safety
}

console.log(`\nCollected ${collectedFails.size} fails from ${totalTests} tests in ${iterations} iterations`);

// Now fix: group fails by expected intent and append to files
const byIntent = new Map();
for (const [input, {expected, got}] of collectedFails.entries()) {
  if (!byIntent.has(expected)) byIntent.set(expected, []);
  byIntent.get(expected).push(input);
}

console.log(`\nFixing ${byIntent.size} intents...`);
let totalAdded = 0;
for (const [intent, inputs] of byIntent.entries()) {
  const file = intentFileMap[intent];
  if (!file) {
    console.log(`  SKIP ${intent}: no file map`);
    continue;
  }
  let content = fs.readFileSync(file, 'utf8');
  // Find the intent block and its examples array
  const escapedIntent = intent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(['"])${escapedIntent}\\1\\s*:\\s*\\{[^}]*examples:\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const match = content.match(re);
  if (!match) {
    console.log(`  SKIP ${intent}: not found in ${path.basename(file)}`);
    continue;
  }
  const examplesStr = match[2];
  // Parse existing examples to avoid dupes
  const existing = new Set();
  const exRe = /'([^']+)'|"([^"]+)"/g;
  let em;
  while ((em = exRe.exec(examplesStr)) !== null) existing.add((em[1]||em[2]).toLowerCase());
  const toAdd = inputs.filter(inp => !existing.has(inp.toLowerCase())).slice(0, 30); // cap per intent to 30 to avoid bloat
  if (toAdd.length === 0) continue;
  // Append before closing ] — handle existing trailing comma correctly
  const addStr = toAdd.map(s => {
    const esc = s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
    return `      '${esc}'`;
  }).join(',\n');
  const oldBlock = match[0];
  const trimmedExamples = examplesStr.trim();
  const needsComma = trimmedExamples.length > 0 && !trimmedExamples.endsWith(',');
  const newBlock = oldBlock.replace(/\]$/, `${needsComma ? ',' : ''}\n${addStr}\n      ]`);
  content = content.replace(oldBlock, newBlock);
  fs.writeFileSync(file, content, 'utf8');
  totalAdded += toAdd.length;
  console.log(`  ${intent} (${path.basename(file)}): added ${toAdd.length} examples`);
}

console.log(`\nTotal added ${totalAdded} examples across ${byIntent.size} intents`);
console.log(`Done. Run check-matcher and rebuild needed.`);

// Save report
const reportPath = path.join(rootDir, 'logs', 'autotune-2000-report.json');
try {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    totalTests,
    iterations,
    failsCollected: collectedFails.size,
    totalAdded,
    byIntent: Object.fromEntries([...byIntent.entries()].map(([k,v])=>[k, v.length])),
    samples: [...collectedFails.entries()].slice(0,20).map(([inp, {expected, got}])=>({input: inp, expected, got}))
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved to ${reportPath}`);
} catch {}
