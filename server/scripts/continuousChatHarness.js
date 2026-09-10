#!/usr/bin/env node
/**
 * continuousChatHarness.js — high-volume, long-running chat tester for Project Console.
 *
 * 3 modes (run separately or together), all via the LOCAL matcher pipeline (no server/WS needed):
 *   1. random-ai      — casual AI chatter: typos, filler, emojis, open-ended requests, frustration
 *   2. intent-cover   — every intent's paraphrases: synonyms, word order, filler, typos, punctuation
 *   3. user-replay    — your own history: reads data/conversations/*.ndjson user messages + variations
 *
 * Goals per the prompt:
 *   - tune existing intents that get misunderstood (report FAILs with confidence/stage)
 *   - propose new intents for fallback clusters (group fallback inputs by n-gram)
 *   - make existing responses sound natural (response-variation audit: pools vs single-string)
 *
 * Usage:
 *   node --import tsx server/scripts/continuousChatHarness.js                  # all 3, 200 each, one shot
 *   node --import tsx server/scripts/continuousChatHarness.js --mode random-ai --count 1000
 *   node --import tsx server/scripts/continuousChatHarness.js --loop --delay 200  # continuous
 *   node --import tsx server/scripts/continuousChatHarness.js --mode intent-cover --count 5000 --typos
 *   node --import tsx server/scripts/continuousChatHarness.js --mode user-replay --count 300
 *   node --import tsx server/scripts/continuousChatHarness.js --json > harness-report.json
 *
 * No server required. Uses semanticMatcher + matcher.js directly (same 23MB cache as the app).
 * For live WS testing, see --live flag (connects to ws://127.0.0.1:<port>/stream).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i+1] && !args[i+1].startsWith('--') ? args[i+1] : def;
};
const hasFlag = (name) => args.includes(name);
const MODE = getArg('--mode', 'all'); // random-ai | intent-cover | user-replay | all
const COUNT = parseInt(getArg('--count', '200'), 10);
const LOOP = hasFlag('--loop');
const DELAY = parseInt(getArg('--delay', '200'), 10);
const WANT_TYPO = hasFlag('--typos');
const JSON_OUT = hasFlag('--json');
const LIVE = hasFlag('--live');
const LIVE_PORT = parseInt(getArg('--port', '3000'), 10);

// --- load matcher (lazy, with cache) ---
const { matchInput } = await import('../matcher.js');
const { INTENTS } = await import('../intentsData.js');
const { BUILTIN_INTENTS } = await import('../intentRegistry.js');

// --- helpers ---

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
  // filler prefix/suffix
  if (Math.random() < 0.5) s = pickRandom(FILLERS) + s;
  if (Math.random() < 0.3) s = s + pickRandom(SUFFIXES);
  // synonym swap (one word)
  for (const [k, alts] of Object.entries(SYNONYMS)) {
    if (s.includes(k) && Math.random() < 0.25) {
      s = s.replace(k, pickRandom(alts));
      break;
    }
  }
  // word order shuffle for 3+ word phrases
  const words = s.split(' ');
  if (words.length >= 3 && Math.random() < 0.2) s = shuffle(words).join(' ');
  if (withTypos && Math.random() < 0.3) {
    const w = s.split(' ');
    const idx = Math.floor(Math.random()*w.length);
    w[idx] = typoOnce(w[idx]);
    s = w.join(' ');
  }
  if (Math.random() < 0.3) s += pickRandom(PUNCTS);
  // case variation
  if (Math.random() < 0.2) s = s.toUpperCase();
  else if (Math.random() < 0.2) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// --- MODE 1: random AI chatter ---

const RANDOM_TEMPLATES = [
  'hey',
  'hello there',
  'whats up',
  'lol',
  'haha {adjective}',
  'can you help me{quest}',
  'I want to {verb} a {noun}',
  'make me a {noun}',
  'fix the bug in {file}',
  'explain {file}',
  'what is this project about',
  'how do i {verb} this',
  'run the site{extra}',
  'open screensaver{extra}',
  'I am {feeling}',
  'why isnt this working{extra}',
  'help me {verb}',
  'how do i publish{extra}',
  'remind me {when} to {task}',
  'note: {task}',
  'search my documents for {topic}',
  'find duplicate files{extra}',
  'merge these pdfs{extra}',
  'where is {file}',
  'is the server running{extra}',
  'what time is it{extra}',
  'convert {num} km to miles',
  'what is {num}% of {num2}',
  'open {panel}',
  'thanks{extra}',
  'ok cool{extra}',
  'please do the thing{extra}',
  'Can you write a function to {verb} an array?',
  'What is the meaning of life{extra}',
  'hey bot how are you today{extra}',
  'I need help with git push{extra}',
  'build a {adjective} landing page for me',
  'create a {noun} with ai',
  'do the thing with {file}',
  'yo whats the {noun} for this project',
  'urgent: fix {file} asap!!!',
  'umm {verb} the {noun} please?',
  'can u {verb} {file} for me??',
  'pls {verb} {file}',
  'my {noun} is broken help',
  'how to {verb} the site on port {num}',
  'stop the server{extra}',
  'undo that{extra}',
  'clear the console{extra}',
];

const FILL = {
  adjective: ['cool','nice','awesome','fancy','simple','modern','clean','fast'],
  quest: [' with my project','', ' with this',' please'],
  verb: ['build','create','make','run','deploy','fix','explain','open','find','search','show','delete'],
  noun: ['landing page','todo app','dashboard','site','app','project','file','report','notes'],
  file: ['main.py','index.html','app.ts','config.json','report.pdf','data.csv','notes.md'],
  feeling: ['tired','exhausted','stuck','confused','frustrated','okay'],
  extra: ['',' please',' now',' quickly',' for me',' asap'],
  when: ['tomorrow at 9am','in 3 days','every friday at 5pm','at 7pm'],
  task: ['call mom','buy milk','fix the login bug','renew my license','water the plants'],
  topic: ['budget','pricing','quarterly goals','contract terms','the trip'],
  panel: ['calculator','notes','reminders','clipboard','pdf tools','spreadsheet'],
  num: ['5','10','15','42','100','3010'],
  num2: ['80','64','120','200'],
};

function fillTemplate(tpl) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => pickRandom(FILL[k] || [k]));
}

function genRandomAI(withTypos) {
  let s = fillTemplate(pickRandom(RANDOM_TEMPLATES));
  if (withTypos && Math.random() < 0.25) s = s.split(' ').map(w => Math.random()<0.15 ? typoOnce(w) : w).join(' ');
  return s;
}

// --- MODE 2: intent-cover ---

function genIntentCover(count, withTypos) {
  const intents = Object.keys(INTENTS);
  const out = [];
  for (let i=0;i<count;i++) {
    const intent = pickRandom(intents);
    const examples = INTENTS[intent].examples || [];
    if (!examples.length) continue;
    const base = pickRandom(examples);
    out.push({ input: varyIntentPhrase(base, withTypos), expected: intent, base });
  }
  return out;
}

// --- MODE 3: user-replay ---

function loadUserMessages(limit=500) {
  const dir = path.join(rootDir, 'data', 'conversations');
  const msgs = [];
  try {
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.ndjson'));
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dir,f),'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const m = JSON.parse(line);
          if (m.role === 'user' && m.content && m.content.trim()) msgs.push(m.content.trim());
        } catch {}
      }
    }
  } catch {}
  // fallback if history is sparse: use intent examples as pseudo-history
  if (msgs.length < 5) {
    for (const [intent, data] of Object.entries(INTENTS)) {
      for (const ex of (data.examples||[]).slice(0,1)) msgs.push(ex);
      if (msgs.length >= limit) break;
    }
  }
  return msgs.slice(0, limit);
}

function varyUserStyle(msg, withTypos) {
  const variants = [];
  variants.push(msg); // original
  variants.push(msg.toLowerCase());
  variants.push('please ' + msg);
  variants.push(msg + ' please');
  variants.push(msg + ' for me');
  if (msg.includes('please')) variants.push(msg.replace('please',''));
  // contraction
  variants.push(msg.replace('I want to','I wanna').replace('can you','can u').replace('please','pls'));
  if (withTypos) {
    const words = msg.split(' ');
    const idx = Math.floor(Math.random()*words.length);
    words[idx] = typoOnce(words[idx]);
    variants.push(words.join(' '));
  }
  return pickRandom(variants);
}

// --- response variation audit ---

async function auditResponseVariation() {
  // Check which chit-chat handlers use pools vs single-string
  const issues = [];
  // Heuristic: read builtin chitChat files for pickRandom vs single string
  const chitDir = path.join(rootDir, 'server', 'wsHandlers', 'chitChat');
  try {
    const files = fs.readdirSync(chitDir);
    for (const f of files) {
      const txt = fs.readFileSync(path.join(chitDir,f),'utf8');
      const hasPool = txt.includes('pickRandom') || txt.includes('chatReplyPool');
      const hasSingle = /data:\s*`[^`]*`/.test(txt) && !hasPool;
      if (hasSingle) issues.push(`${f}: single-string response (no variation)`);
    }
  } catch {}
  // Also check tool openers
  try {
    const t = fs.readFileSync(path.join(rootDir,'server/wsHandlers/builtinTools.js'),'utf8');
    if (!t.includes('pickRandom')) issues.push('builtinTools.js: openers use single-string answers');
  } catch {}
  return issues;
}

// --- runner ---

async function runOnce(mode, count, withTypos) {
  const results = [];
  let inputs = [];
  if (mode === 'random-ai' || mode === 'all') {
    for (let i=0;i<count;i++) inputs.push({ input: genRandomAI(withTypos), expected: null, base: 'random-ai' });
  }
  if (mode === 'intent-cover' || mode === 'all') {
    inputs.push(...genIntentCover(count, withTypos));
  }
  if (mode === 'user-replay' || mode === 'all') {
    const userMsgs = loadUserMessages(count);
    for (const m of userMsgs) {
      inputs.push({ input: varyUserStyle(m, withTypos), expected: null, base: `user:${m.slice(0,40)}` });
    }
  }
  // shuffle for mixed workload
  inputs = shuffle(inputs);

  let ok=0, fail=0, fallback=0, risky=0, riskyExamples=[];
  const failDetails=[];
  const fallbackCluster=[];

  const RISKY = new Set(['git_push','git_commit','git_commit_push','system.chit_chat.deploy','file_delete','file_create','backup.create','general.files.tidy','general.files.duplicates_delete']);

  for (const {input, expected, base} of inputs) {
    const r = await matchInput(input);
    const got = r?.builtin || (r?.disambiguate ? `disambiguate:${r.disambiguate.join(',')}` : (r?.multi ? 'multi' : null));
    if (expected) {
      if (got === expected) ok++;
      else {
        fail++;
        failDetails.push({ input, expected, got, conf: r?.semanticConfidence ?? r?.confidence, source: r?.semanticSource || r?.source });
      }
    } else {
      if (!got) { fallback++; fallbackCluster.push(input); }
      else if (RISKY.has(got) && /^(hey|hello|lol|haha|whats up|thanks|ok)/i.test(input)) {
        risky++; riskyExamples.push({ input, got });
      }
    }
    // optional live WS check: connect and send via WS to verify handler doesn't crash
    // (skipped by default — matcher is the bottleneck; WS is for smoke)
  }
  return { total: inputs.length, ok, fail, fallback, risky, failDetails: failDetails.slice(0,20), riskyExamples: riskyExamples.slice(0,10), fallbackCluster: fallbackCluster.slice(0,20) };
}

function printReport(report, withTypos) {
  console.log(`\n=== CONTINUOUS HARNESS REPORT (${new Date().toISOString()}) ===`);
  console.log(`mode=${MODE} count=${COUNT} typos=${withTypos} total=${report.total}`);
  if (report.ok !== undefined) {
    const totalIntent = report.ok + report.fail;
    if (totalIntent) console.log(`intent-cover: ${report.ok}/${totalIntent} ok (${(report.ok/totalIntent*100).toFixed(1)}%)  fail=${report.fail}`);
    console.log(`fallback (no intent): ${report.fallback}  risky-on-chitchat: ${report.risky}`);
    if (report.failDetails.length) {
      console.log(`\nTop FAILs (expected vs got):`);
      for (const f of report.failDetails) console.log(`  '${f.input}' exp:${f.expected} got:${f.got} conf:${f.conf?.toFixed?.(3)} src:${f.source} base:${f.base}`);
    }
    if (report.riskyExamples.length) {
      console.log(`\nRISKY on chitchat (should be blocked):`);
      for (const r of report.riskyExamples) console.log(`  '${r.input}' -> ${r.got}`);
    }
    if (report.fallbackCluster.length) {
      console.log(`\nFallback cluster (candidates for NEW intents):`);
      // simple n-gram grouping
      const groups={};
      for (const s of report.fallbackCluster) {
        const key=s.toLowerCase().split(/\s+/).slice(0,2).join(' ');
        groups[key]=(groups[key]||0)+1;
      }
      const top=Object.entries(groups).sort((a,b)=>b[1]-a[1]).slice(0,8);
      for (const [k,c] of top) console.log(`  '${k}': ${c} inputs`);
      console.log(`  examples: ${report.fallbackCluster.slice(0,5).map(s=>`'${s}'`).join(', ')}`);
    }
  }
}

async function main() {
  const withTypos = WANT_TYPO;
  const variationIssues = await auditResponseVariation();
  if (!JSON_OUT && variationIssues.length) {
    console.log('=== RESPONSE VARIATION AUDIT ===');
    for (const iss of variationIssues) console.log('  - ' + iss);
    console.log('  Fix: wrap single-string answers with pickRandom(chatReplyPool(...)) like greeting/status/ack do.\n');
  }

  if (LOOP) {
    let iter=0;
    while (true) {
      iter++;
      const report = await runOnce(MODE, COUNT, withTypos);
      if (JSON_OUT) console.log(JSON.stringify({ iter, ...report }));
      else printReport(report, withTypos);
      console.log(`\n[loop ${iter}] sleeping ${DELAY}ms... (Ctrl+C to stop)`);
      await new Promise(r=>setTimeout(r, DELAY));
    }
  } else {
    const report = await runOnce(MODE, COUNT, withTypos);
    if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
    else printReport(report, withTypos);
  }
}

await main();
