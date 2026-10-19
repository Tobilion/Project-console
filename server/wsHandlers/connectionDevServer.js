import { runningProcesses, stopTrackedProcess, getTrackedProcesses, matchesStopTarget } from '../executor.js';
import { isSiteCommand } from '../executorDevServer.js';
import { state, withPortCollisionWarning } from '../state.js';
import { probeDevServerCandidate, candidateDevUrls } from '../livenessProbe.js';
import { recordDevUrl } from '../devUrlStore.js';

// "Where is the link / what is the url" pre-check patterns (hoisted + exported so the harness can
// assert the exact same truth the server uses — keep them in sync with any future edit here).
// Confirmed live 2026-08-03: "what is the dev url" used to slip past the old `(link|url|address)`
// immediacy (an in-between word like "dev" broke the match) and fell through to the NLP stage,
// which misrouted it to project.knowledge.stack. Both patterns now allow an optional determiner
// plus up to two in-between words ("what is the dev url", "what is the dev server link"), while
// the git-context guard below keeps git-remote questions ("what is the git remote url", "where is
// the github link") from ever being answered with a dev-server URL.
export const DEV_URL_WHERE_RE = /where\s+(is|can I find|do I go|did it go)\s+(?:(?:the|a|my|our|their|this)\s+)?(?:[\w.]+\s+){0,2}(link|url|site|server|page)/i;
export const DEV_URL_WHAT_RE = /\bwhat('s| is)\s+(?:(?:the|a|my|our|their|this)\s+)?(?:[\w.]+\s+){0,2}(link|url|address)\b/i;
export const DEV_URL_BARE_RE = /^(link|url)\??$/i;
const DEV_URL_GIT_CONTEXT_RE = /\b(git|github|gitlab|remote|repo|repository|branch|origin|merge|commit|push|pull|checkout|clone)\b/i;

// "stop server" / "kill server" — stop a running dev server. Also catches a bare "stop it" /
// "kill it" / "cancel it" (confirmed live 2026-07-30: "Stop it" typed right after a dev server
// was confirmed still running instead matched system.chit_chat.yes_no — 'stop' is a legitimate
// yes/no-reject example phrase there too — and returned a confusing "No pending confirmation"
// reply) but ONLY when a process is actually tracked for this project; a pronoun-only "stop it"
// with nothing running is ambiguous enough that falling through to the normal yes/no fallback
// is the safer default.
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const row = Array(bl + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= al; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[bl];
}

function isStopVerb(w) {
  const verbs = ['stop', 'kill', 'shutdown', 'end', 'close', 'halt', 'terminate', 'cancel'];
  if (verbs.includes(w)) return true;
  // typo tolerance for the primary verb (1-edit) — "Sop server" live misfire 2026-09-11
  if (levenshtein(w, 'stop') <= 1) return true;
  if (levenshtein(w, 'close') <= 1) return true;
  if (levenshtein(w, 'kill') <= 1) return true;
  return false;
}

function isServerNoun(w) {
  const nouns = ['server', 'site', 'app', 'website', 'process', 'dev', 'service', 'backend', 'api', 'project'];
  if (nouns.includes(w)) return true;
  for (const n of nouns) if (levenshtein(w, n) <= 1) return true;
  return false;
}

export function isStopServerPhrase(input) {
  const norm = input.trim().toLowerCase().replace(/[?.!]+$/, '').trim();
  const clean = norm.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  if (words.length < 2) return false;
  const verb = words[0];
  if (!isStopVerb(verb)) return false;
  let idx = 1;
  if (words[idx] === 'the' || words[idx] === 'my' || words[idx] === 'this' || words[idx] === 'that') idx++;
  if (idx >= words.length) return false;
  const noun = words[idx];
  return isServerNoun(noun);
}
export { isStopVerb, isServerNoun, levenshtein };

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Phrase -> which tracked process(es) the user means. Returns one of:
//   { devServer: true }    — the site/app/website (a dev-server-shaped command)
//   { notDevServer: true } — a named non-site service (wallet/backend/api/db)
//   { commandRe: RegExp }  — an explicitly named script ("npm run server", "tsx server/...")
//   null                   — generic ("stop the server"/"stop it"); the caller asks when >1 run
// 2026-10-18: "stop the server" used to stop EVERY tracked process, so a project with a site and
// a backend lost both. Naming the target (or asking) is what keeps a stop scoped to one process.
export function classifyStopTarget(lowerInput) {
  if (/\b(site|app|website|web\s*site|frontend|front\s*end|client)\b/.test(lowerInput)) return { devServer: true };
  const script = lowerInput.match(/\b(?:npm\s+run|yarn|pnpm|bun|tsx|node|python[3]?)\s+([a-z0-9:._/-]+)/);
  if (script) return { commandRe: new RegExp(escapeRegExp(script[1]), 'i') };
  if (/\b(wallet|backend|api|database|db|server:start)\b/.test(lowerInput)) return { notDevServer: true };
  return null;
}

// A dev URL that answers but is NOT tracked by the console (started outside it, or before a
// restart) — the case the "can't stop it from here" message used to dead-end on. Probes the
// recorded URL first, then the project's own candidate ports. Returns the live URL or null.
async function findUntrackedDevUrl(project) {
  const recorded = state.lastDevUrls.get(project.id);
  if (recorded) {
    const probe = await probeDevServerCandidate(recorded, 2000);
    if (probe.alive) return recorded;
  }
  for (const candidate of candidateDevUrls(project)) {
    const probe = await probeDevServerCandidate(candidate, 1200);
    if (probe.alive) {
      recordDevUrl(project.id, candidate);
      return candidate;
    }
  }
  return null;
}

export async function handleStopServer(ws, project, lowerInput, sessionContext) {
  const entries = getTrackedProcesses(project.id);
  const hasTrackedProcess = entries.length > 0;
  const isStopPhrase =
    isStopServerPhrase(lowerInput) ||
    (hasTrackedProcess && /^(stop|kill|cancel|close)\s+it\.?$/i.test(lowerInput.trim())) ||
    (hasTrackedProcess && (() => {
      const w = lowerInput.trim().toLowerCase().replace(/[^a-z]/g, ' ').trim().split(/\s+/)[0] || '';
      return isStopVerb(w) && lowerInput.trim().toLowerCase().includes(' it');
    })());
  if (!isStopPhrase) return false;

  // Nothing tracked: if a dev URL still answers, offer to stop it (started outside the console).
  if (!hasTrackedProcess) {
    const untracked = await findUntrackedDevUrl(project);
    if (untracked) {
      sessionContext.pendingUntrackedStop = { projectId: project.id, url: untracked };
      ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** is still responding at **${untracked}**, but it was started outside the console so I can't track it. Say "stop it anyway" and I'll find and stop the process for you.\n` }));
      ws.send(JSON.stringify({ type: 'end' }));
      return true;
    }
    ws.send(JSON.stringify({ type: 'answer', data: `No running server for **${project.name}**.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }

  // Scoped targeting: a phrase that names a specific process stops only that one. A phrase that
  // names nothing ("stop the server"/"stop it") keeps every process as a candidate — and when
  // more than one remains, asks which to stop instead of stopping both.
  const target = classifyStopTarget(lowerInput);
  let candidates = target ? entries.filter((p) => matchesStopTarget(p, p.child.pid, target)) : entries;
  if (target && candidates.length === 0) candidates = entries;

  if (candidates.length === 1) {
    const stopped = await stopTrackedProcess(project.id, { target: { pids: [candidates[0].child.pid] } });
    if (stopped.ok) {
      const headsup = stopped.warning ? `\n\nHeads-up: ${stopped.warning}.` : '';
      ws.send(JSON.stringify({ type: 'answer', data: `Stopped \`${stopped.command}\`.${headsup}\n` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `No running server for **${project.name}**.\n` }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }

  const list = candidates.map((p, i) => `${i + 1}. \`${p.command}\`${isSiteCommand(p.command) ? ' (the site)' : ''}`).join('\n');
  sessionContext.pendingStopTarget = {
    projectId: project.id,
    entries: candidates.map((p) => ({ pid: p.child.pid, command: p.command })),
  };
  ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** has ${candidates.length} processes running. Which should I stop?\n\n${list}\n\nReply with a number, "both", or "cancel".\n` }));
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}

// "Where is the link?" — answer from the last detected dev server URL. Wide enough to catch
// "what is the dev url" / "where is the dev server" (confirmed misroute, fixed 2026-08-03),
// but never a git-remote question (gated by DEV_URL_GIT_CONTEXT_RE below — "what is the git
// remote url" should go to git_remote_info instead of being answered as the dev server).
export async function handleDevUrl(ws, project, lowerInput) {
  if (!(DEV_URL_WHERE_RE.test(lowerInput) || DEV_URL_WHAT_RE.test(lowerInput) || DEV_URL_BARE_RE.test(lowerInput.trim()))
    || DEV_URL_GIT_CONTEXT_RE.test(lowerInput)) {
    return false;
  }
  const devUrl = state.lastDevUrls.get(project.id);
  if (devUrl) {
    // Liveness-check the last-known URL (2026-08-04): the URL may survive a console restart
    // via devUrlStore.js even when the process itself isn't tracked anymore — probe before
    // claiming it's up. On-demand only, 3s bound.
    const probe = await probeDevServerCandidate(devUrl, 3000);
    if (probe.alive) {
      const answer = withPortCollisionWarning(`The dev server is running at **${devUrl}** — open it in your browser.`, devUrl);
      ws.send(JSON.stringify({ type: 'answer', data: answer }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}**'s last-known address **${devUrl}** isn't responding right now. Say "run the site" to start it.` }));
    }
  } else {
    // Nothing recorded (2026-08-04, reported directly): a server started OUTSIDE the console
    // that it never observed was invisible. Best-effort discovery before giving guidance —
    // probe the ports the project's own package.json scripts reference (vite --port=N etc.,
    // console's own port excluded), 1.5s bound each, and answer honestly if one responds.
    const candidates = candidateDevUrls(project);
    let found = null;
    for (const candidate of candidates) {
      const probe = await probeDevServerCandidate(candidate, 1500);
      if (probe.alive) { found = candidate; break; }
    }
    if (found) {
      recordDevUrl(project.id, found);
      const answer = withPortCollisionWarning(`The dev server is running at **${found}** — open it in your browser. It was started outside the console, so I found it by probing the ports its own \`package.json\` scripts reference.`, found);
      ws.send(JSON.stringify({ type: 'answer', data: answer }));
      ws.send(JSON.stringify({ type: 'end' }));
      return true;
    }
    const pkgJson = project.codebaseIndex?.keyFiles?.['package.json'];
    let scripts = {};
    if (pkgJson) { try { scripts = JSON.parse(pkgJson).scripts || {}; } catch {} }
    const hasDev = scripts.dev || scripts.start || scripts.serve;
    if (hasDev) {
      ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** has a dev script configured but I haven't detected a running server yet. Try saying "run the site" to start it.` }));
    } else {
      const langs = project.codebaseIndex?.languages || [];
      // Same bug as builtinIntents.js's projectTypeSuggestions() — codebaseIndex.languages
      // entries are always "Python (N files)", never the bare name, so `.includes('Python')`
      // could never match. Fixed alongside it (2026-07-29).
      if (langs.some((l) => l.startsWith('Python'))) {
        ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** appears to be a Python project — it doesn't run a local web server in the traditional sense. Try "overview" to learn more.` }));
      } else if (project.codebaseIndex?.entryPoints?.some(e => e.endsWith('index.html'))) {
        ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** is a static HTML project. Open the HTML file directly in your browser, or say "run the site" for instructions.` }));
      } else {
        ws.send(JSON.stringify({ type: 'answer', data: `**${project.name}** doesn't have a dev server running. Try turning AI mode ON and asking "how do I run this project?"` }));
      }
    }
  }
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}
