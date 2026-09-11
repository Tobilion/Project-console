/**
 * replayChatHistory.js — batch testing pipeline using real chat history (read-only).
 *
 * 1. Finds every session transcript on disk (project .console/sessions/*.ndjson,
 *    data/general-workspace/.console/sessions/*.ndjson, legacy data/conversations/*.ndjson,
 *    plus any exported markdown/json in Downloads for manual exports).
 * 2. Extracts user messages in order, normalized, per transcript.
 * 3. Replays each through the current CLI/matcher pipeline (pre-checks + matchInput + guess)
 *    capturing intent/entities/fallback as live against current code.
 * 4. Applies detection: retry clusters, fallback hits, identical-input drift, topic mismatches.
 * 5. Clusters FALLBACK hits by topic — candidate new intents vs phrasing gaps.
 * 6. Outputs ranked report: confirmed bugs, coverage gaps, candidate new intents.
 *
 * Read-only: never touches learningEngine, distillation, or intent examples.
 * Run: npm run replay-history  (or node --import tsx server/scripts/replayChatHistory.js)
 * Scheduled: via server/replayScheduler.js (nightly + N-new trigger, digest only if found).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveData as resolveDataEnv } from '../dataPath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

function resolveData(p) {
  return resolveDataEnv(p);
}

// --- Discovery ---
function findNdjsonSessions() {
  const sessions = [];
  // 1) Each project's .console/sessions/*.ndjson (scan Projects root)
  const projectsRoot = path.join(ROOT, '..');
  // Also includes Project console itself's .console
  const rootsToScan = [
    path.join(ROOT, '.console', 'sessions'),
    path.join(ROOT, 'data', 'general-workspace', '.console', 'sessions'),
    path.join(ROOT, 'data', 'conversations'),
  ];
  // Add each sibling project's .console/sessions
  try {
    const siblings = fs.readdirSync(projectsRoot, { withFileTypes: true });
    for (const ent of siblings) {
      if (!ent.isDirectory()) continue;
      const p = path.join(projectsRoot, ent.name, '.console', 'sessions');
      if (fs.existsSync(p)) rootsToScan.push(p);
    }
  } catch {}
  // Also check Downloads for exported chats (user-uploaded format)
  const downloads = path.join(os.homedir(), 'Downloads');
  if (fs.existsSync(downloads)) rootsToScan.push(downloads);

  const seen = new Set();
  for (const dir of rootsToScan) {
    if (!fs.existsSync(dir)) continue;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      const stat = (() => { try { return fs.statSync(full); } catch { return null; } })();
      if (!stat) continue;
      if (stat.isDirectory()) continue;
      // Handle .ndjson, .json (session export), .md (markdown export)
      if (f.endsWith('.ndjson') || (f.endsWith('.json') && !f.startsWith('index'))) {
        // For json files in Downloads, they may be exported chat JSON (different schema)
        // vs session meta json (.console/sessions/*.json without ndjson). Session meta json
        // has no messages, only metadata — skip those (they have no role field).
        // We distinguish by trying to read first 2KB and checking for '"role":'
        if (f.endsWith('.json')) {
          try {
            const head = fs.readFileSync(full, 'utf-8').slice(0, 4000);
            if (!head.includes('"role"') && !head.includes('"messages"')) {
              // Likely session meta json, skip — we want ndjson
              continue;
            }
            // If it's an exported chat JSON (has messages array), treat as session
            if (head.includes('"messages"') && head.includes('"content"')) {
              seen.add(full);
            } else if (head.includes('"role"')) {
              seen.add(full);
            }
          } catch { continue; }
        } else {
          seen.add(full);
        }
      } else if (f.endsWith('.md') && dir === downloads) {
        // Exported markdown chat (e.g., Matchday_Exchange-Matchday_Exchange_Chat.md)
        // Only include if it looks like a chat export (contains ## User / ## Assistant)
        try {
          const head = fs.readFileSync(full, 'utf-8').slice(0, 4000);
          if (head.includes('## User') || head.includes('Exported:') || head.includes('# Matchday')) {
            seen.add(full);
          }
        } catch {}
      }
    }
  }
  return [...seen];
}

function parseMdExport(filePath) {
  // Markdown export format from the initial fix: # Title, ## User, ```content```, ## Assistant etc.
  // Extract user messages by finding ## User blocks and the ``` ... ``` content.
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const users = [];
    const re = /## User[\s\S]*?```\n([\s\S]*?)\n```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const c = m[1].trim();
      if (c) users.push(c);
    }
    // Fallback: also check for simple ## User\ncontent without code fence?
    if (users.length === 0) {
      const re2 = /## User[^\n]*\n+([^\n#][^\n]*)/g;
      while ((m = re2.exec(text)) !== null) {
        const c = m[1].trim();
        if (c && c.length > 2) users.push(c);
      }
    }
    return users;
  } catch { return []; }
}

function parseSessionFile(filePath) {
  if (filePath.endsWith('.md')) {
    const users = parseMdExport(filePath);
    return users.map((content, idx) => ({ content, id: `md-${idx}`, timestamp: 0 }));
  }
  // ndjson or json
  const text = fs.readFileSync(filePath, 'utf-8');
  // If it's a JSON object with messages array (exported chat json)
  if (filePath.endsWith('.json') && text.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (Array.isArray(obj.messages)) {
        return obj.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim()).map(m => ({ content: m.content.trim(), id: m.id, timestamp: m.timestamp || 0 }));
      }
      if (Array.isArray(obj)) {
        return obj.filter(m => m.role === 'user' && m.content).map(m => ({ content: m.content.trim(), id: m.id, timestamp: m.timestamp || 0 }));
      }
    } catch {}
  }
  // ndjson: each line is a message json
  const lines = text.split('\n').filter(l => l.trim());
  const users = [];
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
        users.push({ content: msg.content.trim(), id: msg.id, timestamp: msg.timestamp || 0 });
      }
    } catch {}
  }
  return users;
}

function normalizeInput(s) {
  return s.trim().toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simple topic keywords for fallback clustering
const TOPIC_KEYWORDS = {
  'stop-server': ['stop', 'close', 'kill', 'shutdown', 'halt', 'server', 'site', 'app', 'website'],
  'open-site': ['open', 'launch', 'site', 'browser', 'url', 'link', 'visit'],
  'run-project': ['run', 'start', 'launch', 'boot', 'serve', 'project', 'app', 'dev'],
  'git': ['git', 'push', 'commit', 'pull', 'branch', 'merge', 'deploy', 'push live'],
  'file-ops': ['file', 'folder', 'directory', 'create', 'delete', 'find', 'search', 'duplicate', 'tidy'],
  'knowledge': ['what is', 'how does', 'overview', 'stack', 'architecture', 'explain'],
  'notes-reminders': ['note', 'reminder', 'alarm', 'remind'],
  'settings': ['settings', 'theme', 'accent', 'profile', 'preference'],
};

function roughTopic(input) {
  const n = normalizeInput(input);
  let best = 'other';
  let bestScore = 0;
  for (const [topic, kws] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const kw of kws) if (n.includes(kw)) score++;
    if (score > bestScore) { bestScore = score; best = topic; }
  }
  return best;
}

async function main() {
  const isDigest = process.argv.includes('--digest');
  const jsonOut = process.argv.includes('--json');
  console.log('[replay] discovering transcripts...');
  const sessionFiles = findNdjsonSessions();
  console.log(`[replay] found ${sessionFiles.length} session/export files`);
  if (sessionFiles.length === 0) {
    console.log('[replay] no transcripts found — nothing to replay');
    return;
  }

  // Lazy import heavy matcher after discovery (model load)
  const { semanticMatcher } = await import('../semanticMatcher.js');
  const { matchInput } = await import('../matcher.js');
  const { isStopServerPhrase } = await import('../wsHandlers/connectionDevServer.js');
  const { DEV_URL_WHERE_RE, DEV_URL_WHAT_RE, DEV_URL_BARE_RE } = await import('../wsHandlers/connectionDevServer.js');
  const { guessCommand } = await import('../commandGuesser.js');
  const { INTENTS } = await import('../intentsData.js');

  console.log('[replay] loading embedding model...');
  await semanticMatcher.initialize();
  console.log('[replay] model ready — 157 intents');

  // Minimal project fixture for matching (like matcherBatteries project)
  const project = {
    id: 'replay-proj',
    name: 'Replay',
    path: path.join(os.tmpdir(), 'replay-proj'),
    config: { entries: [] },
    codebaseIndex: { languages: ['TypeScript (10 files)'], entryPoints: ['src/main.ts'], keyFiles: { 'package.json': JSON.stringify({ scripts: { dev: 'vite --port=3001' } }) }, fileSample: ['src/main.ts'] },
    contextFiles: [],
    parsedKnowledge: {},
  };

  const allRuns = []; // { file, idx, input, normalized, resolved: { builtin, match, fallback, didYouMean, confidence, stage } }
  const perFile = new Map();

  for (const file of sessionFiles) {
    let users = [];
    try { users = parseSessionFile(file); } catch (e) { console.warn(`[replay] skip ${file}: ${e.message}`); continue; }
    if (users.length === 0) continue;
    perFile.set(file, users);
    for (let i = 0; i < users.length; i++) {
      const rawContent = users[i].content;
      // Strip [REASON] prefix used by reason mode — not part of user intent (keep raw for report)
      const content = rawContent.replace(/^\s*\[REASON\]\s*/i, '').trim();
      const normalized = normalizeInput(content);
      // Resolve via current pipeline (mirrors handleExecute pre-checks + matchInput + guess)
      let resolved = null;
      const lower = content.trim().toLowerCase();
      if (isStopServerPhrase(lower)) {
        resolved = { builtin: 'system.server.stop', stage: 'precheck-stop', confidence: 1.0 };
      } else if (DEV_URL_WHERE_RE.test(lower) || DEV_URL_WHAT_RE.test(lower) || DEV_URL_BARE_RE.test(lower.trim())) {
        // Simplified: treat as dev_server_status if not git context
        const isGit = /\b(git|github|gitlab|remote|repo)\b/i.test(lower);
        if (!isGit) resolved = { builtin: 'project.context.dev_server_status', stage: 'precheck-devurl', confidence: 1.0 };
      }
        if (!resolved) {
        const r = await matchInput(content, project, 0);
        if (r && r.multi) {
          resolved = { multi: r.multi, stage: 'multi', intents: r.multi.map(m=>m.builtin||m.match?.action||'unknown'), confidence: null };
        } else if (r && r.builtin) {
          resolved = { builtin: r.builtin, confidence: r.semanticConfidence ?? r.confidence ?? null, stage: r.semanticSource || r.source || 'semantic', didYouMean: r.didYouMean, closeSecond: r.closeSecond };
        } else if (r && r.match) {
          resolved = { match: r.match, confidence: r.semanticConfidence, stage: r.semanticSource || 'config-entry' };
        } else if (r && r.disambiguate) {
          resolved = { disambiguate: r.disambiguate, stage: 'disambiguate' };
        } else {
          // Try guessCommand fallback
          const guessed = guessCommand(content);
          if (guessed) {
            resolved = { guessed: guessed.command, stage: 'guess' };
          } else {
            resolved = { fallback: true, stage: 'fallback', didYouMean: r?.didYouMean || null, suggestions: r?.suggestions || [] };
          }
        }
      }
      allRuns.push({ file, idx: i, input: rawContent, normalized, resolved, timestamp: users[i].timestamp });
    }
  }

  console.log(`[replay] replayed ${allRuns.length} user messages across ${perFile.size} transcripts`);

  // --- Detection: retry clusters ---
  const retryClusters = [];
  for (const [file, users] of perFile.entries()) {
    // Map normalized -> indices
    const normMap = new Map();
    users.forEach((u, idx) => {
      const n = normalizeInput(u.content);
      if (!normMap.has(n)) normMap.set(n, []);
      normMap.get(n).push(idx);
    });
    for (const [norm, idxs] of normMap.entries()) {
      if (idxs.length >= 2) {
        // Potential retry cluster: same input repeated
        const runs = idxs.map(i => allRuns.find(r => r.file === file && r.idx === i));
        const intents = runs.map(r => r.resolved.builtin || (r.resolved.fallback ? 'FALLBACK' : r.resolved.match ? 'ENTRY' : 'other'));
        const allSame = intents.every(v => v === intents[0]);
        // If repeated and at least one was fallback or mismatch, flag
        const hasFallback = runs.some(r => r.resolved.fallback);
        if (idxs.length >= 2) {
          retryClusters.push({ file: path.basename(file), norm, count: idxs.length, intents, hasFallback, inputs: runs.map(r => r.input) });
        }
      }
    }
    // Also detect near-retry: same normative after typo normalization (lev distance) — simple: inputs within 2 edits that appear consecutively
    for (let i = 1; i < users.length; i++) {
      const a = normalizeInput(users[i-1].content);
      const b = normalizeInput(users[i].content);
      if (a !== b && levenshtein(a,b) <= 2) {
        const ra = allRuns.find(r => r.file === file && r.idx === i-1);
        const rb = allRuns.find(r => r.file === file && r.idx === i);
        // If they are consecutive and second is a retry of first with typo correction, and first was fallback/mismatch
        if (ra && rb && (ra.resolved.fallback || ra.resolved.builtin !== rb.resolved.builtin)) {
          retryClusters.push({ file: path.basename(file), norm: `${a} -> ${b}`, count: 2, intents: [ra.resolved.builtin||'FALLBACK', rb.resolved.builtin||'FALLBACK'], hasFallback: !!(ra.resolved.fallback || rb.resolved.fallback), inputs: [ra.input, rb.input], typoRetry: true });
        }
      }
    }
  }

  // --- Detection: identical-input drift (same normalized input across different transcripts but different intent) ---
  const driftMap = new Map(); // norm -> Set of intents
  const driftExamples = new Map(); // norm -> [{file, input, intent}]
  for (const r of allRuns) {
    const key = r.normalized;
    if (!driftMap.has(key)) driftMap.set(key, new Set());
    const intent = r.resolved.builtin || (r.resolved.fallback ? 'FALLBACK' : 'OTHER');
    driftMap.get(key).add(intent);
    if (!driftExamples.has(key)) driftExamples.set(key, []);
    driftExamples.get(key).push({ file: path.basename(r.file), input: r.input, intent });
  }
  const drifts = [];
  for (const [norm, set] of driftMap.entries()) {
    if (set.size > 1) {
      drifts.push({ norm, intents: [...set], examples: driftExamples.get(norm).slice(0,3) });
    }
  }

  // --- Detection: fallback hits ---
  const fallbackHits = allRuns.filter(r => r.resolved.fallback);
  // Cluster fallback by rough topic
  const fallbackByTopic = new Map();
  for (const r of fallbackHits) {
    const topic = roughTopic(r.input);
    if (!fallbackByTopic.has(topic)) fallbackByTopic.set(topic, []);
    fallbackByTopic.get(topic).push(r);
  }

  // --- Candidate new intent vs coverage gap distinction ---
  // For each fallback, check embedding similarity to existing intent examples.
  // If close to an existing intent (>=0.6), it's a coverage gap (missed phrasing).
  // If not close to any, it's a candidate new intent.
  const coverageGaps = [];
  const candidateNewIntents = [];
  // Pre-compute: we can use semanticMatcher.nearestIntent to find nearest intent for each fallback
  for (const r of fallbackHits) {
    // Use semanticMatcher's nearestIntent (embedding) to find closest existing intent
    try {
      const nearest = await semanticMatcher.nearestIntent(r.normalized);
      const sim = nearest?.confidence ?? 0;
      const intent = nearest?.intent || null;
      if (sim >= 0.6 && intent) {
        coverageGaps.push({ input: r.input, normalized: r.normalized, nearestIntent: intent, confidence: sim, file: path.basename(r.file) });
      } else {
        candidateNewIntents.push({ input: r.input, normalized: r.normalized, nearestIntent: intent, confidence: sim, file: path.basename(r.file) });
      }
    } catch {
      candidateNewIntents.push({ input: r.input, normalized: r.normalized, file: path.basename(r.file) });
    }
  }

  // Cluster candidate new intents by topic as well
  const candidateByTopic = new Map();
  for (const c of candidateNewIntents) {
    const t = roughTopic(c.input);
    if (!candidateByTopic.has(t)) candidateByTopic.set(t, []);
    candidateByTopic.get(t).push(c);
  }

  // --- Confirmed bugs: retry clusters + mismatches ---
  // Mismatches: input contains stop keywords but resolved != stop (exclude notification + question phrases)
  const mismatches = [];
  for (const r of allRuns) {
    let n = r.normalized;
    // Strip reason prefix for detection
    n = n.replace(/^\[reason\]\s*/i, '').trim();
    if (/\b(notifying|notify|notification)\b/.test(n)) continue;
    // Question forms are not imperative stops — they should be how_do_i
    if (/^(how\s+do\s+i|how\s+to|what\s+is\s+the\s+command)/i.test(r.input.trim())) continue;
    const hasStopVerb = /\b(stop|close|kill|shutdown|sop|stp)\b/.test(n);
    const hasServerNoun = /\b(server|site|app|website|service)\b/.test(n);
    if (hasStopVerb && hasServerNoun) {
      const intent = r.resolved.builtin;
      // Also exclude multi-intent where one part is stop
      if (r.resolved.multi && r.resolved.intents && r.resolved.intents.includes('system.server.stop')) continue;
      if (intent !== 'system.server.stop') {
        mismatches.push({ input: r.input, normalized: n, resolved: intent || (r.resolved.fallback?'FALLBACK': r.resolved.multi ? 'MULTI:'+r.resolved.intents.join('|') : 'OTHER'), file: path.basename(r.file), confidence: r.resolved.confidence });
      }
    }
    // Also open-site mismatch: input is "close site" but resolved to run_project/open_site
    // Already covered above, but also check close site that went to run_project
    if (n.includes('close site') && r.resolved.builtin === 'run_project') {
      if (!mismatches.find(m => m.input===r.input)) mismatches.push({ input: r.input, normalized: n, resolved: r.resolved.builtin, file: path.basename(r.file) });
    }
  }

  // Sort confirmed bugs by severity: retryClusters with fallback, then mismatches
  const confirmedBugs = [
    ...retryClusters.filter(c => c.hasFallback).map(c => ({ type: 'retry-cluster-fallback', ...c })),
    ...mismatches.map(m => ({ type: 'mismatch', ...m })),
  ];

  // --- Output report ---
  const report = {
    summary: {
      transcripts: perFile.size,
      totalUserMessages: allRuns.length,
      fallbackHits: fallbackHits.length,
      retryClusters: retryClusters.length,
      drifts: drifts.length,
      mismatches: mismatches.length,
      coverageGaps: coverageGaps.length,
      candidateNewIntents: candidateNewIntents.length,
    },
    confirmedBugs: confirmedBugs.slice(0, 20),
    retryClusters: retryClusters.slice(0, 10),
    drifts: drifts.slice(0, 10),
    coverageGaps: coverageGaps.slice(0, 20),
    candidateNewIntents: candidateNewIntents.slice(0, 20),
    fallbackByTopic: Object.fromEntries([...fallbackByTopic.entries()].map(([k,v])=>[k, v.length])),
    candidateByTopic: Object.fromEntries([...candidateByTopic.entries()].map(([k,v])=>[k, v.map(x=>x.input).slice(0,3)])),
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else if (isDigest) {
    // Short digest for scheduled runs: only if actionable findings exist
    const hasRetryFallback = retryClusters.some(c => c.hasFallback);
    const actionableCandidates = [...candidateByTopic.entries()].filter(([topic, arr]) => topic !== 'other' && arr.length >= 2).length;
    const hasFindings = report.confirmedBugs.length > 0 || report.summary.mismatches > 0 || hasRetryFallback || actionableCandidates > 0;
    if (!hasFindings) {
      console.log('[replay] digest: no actionable findings — no notify');
      return;
    }
    console.log('\n=== Replay Digest ===');
    console.log(`Transcripts: ${report.summary.transcripts}, Messages: ${report.summary.totalUserMessages}`);
    console.log(`Fallback: ${report.summary.fallbackHits}, Mismatches: ${report.summary.mismatches}, Retry clusters: ${report.summary.retryClusters}`);
    console.log(`Coverage gaps: ${report.summary.coverageGaps}, Candidate new intents: ${report.summary.candidateNewIntents}`);
    if (report.confirmedBugs.length) {
      console.log('\nTop confirmed bugs:');
      report.confirmedBugs.slice(0,5).forEach((b,i)=> console.log(` ${i+1}. [${b.type}] "${b.input||b.norm}" -> ${b.resolved||b.intents} (${b.file})`));
    }
    if (report.coverageGaps.length) {
      console.log('\nTop coverage gaps (existing intent, missed phrasing):');
      report.coverageGaps.slice(0,5).forEach((g,i)=> console.log(` ${i+1}. "${g.input}" ~ ${g.nearestIntent} (${g.confidence.toFixed(2)})`));
    }
    if (report.candidateNewIntents.length) {
      console.log('\nTop candidate new intents (no close existing intent):');
      // group by topic for digest
      for (const [topic, examples] of Object.entries(report.candidateByTopic).slice(0,3)) {
        console.log(` - ${topic}: ${examples.slice(0,2).join(' | ')}`);
      }
    }
  } else {
    console.log('\n' + '='.repeat(70));
    console.log('REPLAY REPORT — ranked');
    console.log('='.repeat(70));
    console.log(`Transcripts: ${report.summary.transcripts} | User messages: ${report.summary.totalUserMessages}`);
    console.log(`Fallback hits: ${report.summary.fallbackHits} | Retry clusters: ${report.summary.retryClusters} | Drifts: ${report.summary.drifts}`);
    console.log(`Mismatches: ${report.summary.mismatches} | Coverage gaps: ${report.summary.coverageGaps} | Candidate new intents: ${report.summary.candidateNewIntents}`);
    console.log(`\nFallback by topic: ${JSON.stringify(report.fallbackByTopic)}`);

    if (report.confirmedBugs.length) {
      console.log('\n--- CONFIRMED BUGS (retry clusters, mismatches — near-certain) ---');
      report.confirmedBugs.slice(0,10).forEach((b,i)=>{
        if (b.type==='retry-cluster-fallback') {
          console.log(`${i+1}. RETRY "${b.norm}" x${b.count} in ${b.file} -> ${b.intents.join(' | ')} | e.g. "${b.inputs[0]}"`);
        } else {
          console.log(`${i+1}. MISMATCH "${b.input}" (${b.normalized}) -> ${b.resolved} in ${b.file}`);
        }
      });
    } else {
      console.log('\n--- CONFIRMED BUGS: none found ---');
    }

    if (retryClusters.length) {
      console.log('\n--- RETRY CLUSTERS (all) ---');
      retryClusters.slice(0,10).forEach((c,i)=> console.log(`${i+1}. "${c.norm}" x${c.count} in ${c.file} -> ${c.intents.join(', ')}`));
    }

    if (drifts.length) {
      console.log('\n--- IDENTICAL-INPUT DRIFT (same input, different intent across transcripts) ---');
      drifts.slice(0,10).forEach((d,i)=> console.log(`${i+1}. "${d.norm}" -> ${d.intents.join(' | ')} | e.g. "${d.examples[0].input}" in ${d.examples[0].file}`));
    }

    if (coverageGaps.length) {
      console.log('\n--- COVERAGE GAPS (fallback but close to existing intent — missed phrasing) ---');
      coverageGaps.slice(0,15).forEach((g,i)=> console.log(`${i+1}. "${g.input}" -> nearest ${g.nearestIntent} (${g.confidence.toFixed(2)}) in ${g.file}`));
    } else {
      console.log('\n--- COVERAGE GAPS: none ---');
    }

    if (candidateNewIntents.length) {
      console.log('\n--- CANDIDATE NEW INTENTS (fallback, no close existing intent — needs review) ---');
      // Group by topic for readability
      for (const [topic, list] of candidateByTopic.entries()) {
        if (list.length < 2) continue; // only surface topics with >=2 different phrasings
      }
      // Show individually if not grouped
      candidateNewIntents.slice(0,15).forEach((c,i)=> console.log(`${i+1}. "${c.input}" (nearest ${c.nearestIntent||'none'} ${c.confidence?c.confidence.toFixed(2):''}) in ${c.file}`));
      console.log('\nCandidate by topic:');
      for (const [topic, examples] of Object.entries(report.candidateByTopic)) {
        console.log(`  ${topic}: ${examples.slice(0,3).join(' | ')}`);
      }
    } else {
      console.log('\n--- CANDIDATE NEW INTENTS: none ---');
    }

    console.log('\n' + '='.repeat(70));
    console.log('Full report available via: npm run replay-history -- --json');
    console.log('Digest (scheduled) via: npm run replay-history:digest');
  }

  // Write latest report to data/replay-report.json for on-demand + scheduler
  try {
    const outPath = resolveData('replay-report.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\n[replay] report written to ${outPath}`);
  } catch {}

  // Also update replay-state.json for scheduler N-trigger
  try {
    const statePath = resolveData('replay-state.json');
    const state = { lastRun: Date.now(), sessionCount: sessionFiles.length, lastReport: report.summary };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {}
}

function levenshtein(a, b) {
  if (a===b) return 0;
  const al=a.length, bl=b.length;
  if(al===0) return bl;
  if(bl===0) return al;
  const row=Array(bl+1).fill(0).map((_,i)=>i);
  for(let i=1;i<=al;i++){
    let prev=row[0];
    row[0]=i;
    for(let j=1;j<=bl;j++){
      const tmp=row[j];
      const cost=a[i-1]===b[j-1]?0:1;
      row[j]=Math.min(row[j]+1, row[j-1]+1, prev+cost);
      prev=tmp;
    }
  }
  return row[bl];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(e=>{ console.error('[replay] fatal', e); process.exit(1); });
}
export { main, findNdjsonSessions, normalizeInput };
