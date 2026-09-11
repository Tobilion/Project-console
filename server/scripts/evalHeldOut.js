#!/usr/bin/env node
/**
 * evalHeldOut.js — deterministic held-out eval over the frozen real-user set.
 *
 * Reads server/scripts/eval/heldOutEval.json VERBATIM (no filler/typo/case variations —
 * variations would leak training-style noise into the eval) and routes each message through
 * the real matchInput pipeline. Reports routed vs fallback, risky-on-chitchat, and mean
 * confidence. This is an unsupervised eval (real messages carry no intent labels): the
 * score to watch across runs is the routed rate + risky count, alongside check-matcher.
 *
 * Run: npm run check-eval  (node --import tsx server/scripts/evalHeldOut.js)
 *      node --import tsx server/scripts/evalHeldOut.js --json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_OUT = process.argv.includes('--json');

const evalFile = path.join(__dirname, 'eval', 'heldOutEval.json');
const { matchInput } = await import('../matcher.js');
const { heldOutInfo } = await import('../evalGuard.js');

const raw = JSON.parse(fs.readFileSync(evalFile, 'utf8'));
const messages = Array.isArray(raw) ? raw : raw.messages || [];

const RISKY = new Set(['git_push', 'git_commit', 'git_commit_push', 'system.chit_chat.deploy', 'file_delete', 'file_create', 'backup.create', 'general.files.tidy', 'general.files.duplicates_delete']);

let routed = 0, fallback = 0, risky = 0, confSum = 0, confN = 0;
const fallbackExamples = [];
const riskyExamples = [];
const rows = [];

for (const input of messages) {
  const text = typeof input === 'string' ? input : input.input;
  const r = await matchInput(text);
  const got = r?.builtin || (r?.disambiguate ? `disambiguate:${r.disambiguate.join(',')}` : (r?.multi ? 'multi' : null));
  const conf = r?.semanticConfidence ?? r?.confidence;
  if (typeof conf === 'number') { confSum += conf; confN++; }
  if (!got) { fallback++; if (fallbackExamples.length < 10) fallbackExamples.push(text); }
  else {
    routed++;
    if (RISKY.has(got) && /^(hey|hello|lol|haha|whats up|thanks|ok)\b/i.test(text)) {
      risky++;
      if (riskyExamples.length < 10) riskyExamples.push({ input: text, got });
    }
  }
  rows.push({ input: text, got: got || null, conf: typeof conf === 'number' ? Number(conf.toFixed(4)) : null });
}

const info = heldOutInfo();
const report = {
  evalSet: info.path,
  evalSize: messages.length,
  routed,
  fallback,
  risky,
  routedRate: messages.length ? Number((routed / messages.length).toFixed(4)) : 0,
  meanConfidence: confN ? Number((confSum / confN).toFixed(4)) : null,
  fallbackExamples,
  riskyExamples,
};

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\n=== HELD-OUT EVAL (${info.size} frozen messages, verbatim, no variations) ===`);
  console.log(`routed: ${routed}/${messages.length} (${(report.routedRate * 100).toFixed(1)}%)  fallback: ${fallback}  risky-on-chitchat: ${risky}  meanConf: ${report.meanConfidence ?? 'n/a'}`);
  if (fallbackExamples.length) console.log(`fallback examples: ${fallbackExamples.map(s => `'${s.slice(0, 60)}'`).join(', ')}`);
  if (riskyExamples.length) console.log(`risky examples: ${riskyExamples.map(r => `'${r.input}' -> ${r.got}`).join(', ')}`);
}
