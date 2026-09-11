/**
 * replayScheduler.js — scheduled batch replay (nightly + N-new trigger).
 *
 * Wires the replayChatHistory pipeline to run automatically, not just on demand.
 * Steady-state: nightly at 03:00 local + hourly check for N new sessions since last run.
 * On scheduled runs, only notifies if something was found (digest), full report stays via npm script.
 *
 * Priority-0 gate: distillation auto-apply is queue-for-review (autoApplyDistillations)
 * — this scheduler never writes to console.config.json; it only reads.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveData } from './dataPath.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolveData('replay-state.json');
const N_TRIGGER = 5; // run once N new transcripts accumulate
const NIGHTLY_HOUR = 3; // 03:00 local

function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {}
  return null;
}

function countSessions() {
  // Count .ndjson session files across all known locations (same logic as replay discovery, but fast count)
  const roots = [
    path.join(ROOT(), '.console', 'sessions'),
    path.join(ROOT(), 'data', 'general-workspace', '.console', 'sessions'),
    path.join(ROOT(), 'data', 'conversations'),
  ];
  // Add sibling projects .console/sessions
  const projectsRoot = path.join(ROOT(), '..');
  try {
    const ents = fs.readdirSync(projectsRoot, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(projectsRoot, e.name, '.console', 'sessions');
      if (fs.existsSync(p)) roots.push(p);
    }
  } catch {}
  let count = 0;
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) if (f.endsWith('.ndjson')) count++;
    } catch {}
  }
  // Also count Downloads md/json exports if present
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Downloads');
    if (fs.existsSync(dl)) {
      const files = fs.readdirSync(dl);
      for (const f of files) if (f.endsWith('.md') && f.includes('Chat')) count++;
    }
  } catch {}
  return count;
}

function ROOT() {
  // server/.. is project root
  return path.join(__dirname, '..');
}

function msUntilNextNightly() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(NIGHTLY_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

async function runReplayDigest() {
  log.info('[replayScheduler] running scheduled replay (digest)...');
  const script = path.join(__dirname, 'scripts', 'replayChatHistory.js');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, '--digest'], {
      cwd: ROOT(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', async (code) => {
      const combined = out + err;
      // Detect if digest found findings (look for "no findings" vs counts)
      const hasFindings = /Fallback:\s*[1-9]|Mismatches:\s*[1-9]|Retry clusters:\s*[1-9]/.test(combined);
      if (hasFindings) {
        // Notify via desktop + history (reuse notify)
        try {
          const { notify } = await import('./notify.js');
          // Use projectId 'replay' pseudo-project
          await notify('replay', 'task-done', {
            title: 'Chat replay: findings',
            body: combined.slice(0, 800),
          });
        } catch (e) {
          log.warn('[replayScheduler] notify failed: ' + e.message);
        }
        log.info('[replayScheduler] digest had findings, notified:\n' + combined.slice(0, 1000));
      } else {
        log.info('[replayScheduler] digest: no findings — no notify');
      }
      resolve({ code, hasFindings, output: combined });
    });
    child.on('error', (e) => {
      log.error('[replayScheduler] spawn failed: ' + e.message);
      resolve({ code: 1, hasFindings: false, output: '' });
    });
  });
}

export function initReplayScheduler() {
  // Don't run scheduler when explicitly disabled (e.g., in harness)
  if (process.env.DISABLE_REPLAY_SCHEDULER) {
    log.info('[replayScheduler] disabled via DISABLE_REPLAY_SCHEDULER');
    return;
  }
  // Nightly run
  const scheduleNightly = () => {
    const ms = msUntilNextNightly();
    log.info(`[replayScheduler] next nightly run in ${Math.round(ms/60000)}m`);
    setTimeout(() => {
      runReplayDigest().catch(()=>{});
      // Reschedule
      scheduleNightly();
    }, ms);
    // Don't block exit
    if (typeof setTimeout === 'function' && setTimeout) {
      // unref the timer so it doesn't keep process alive alone
      const t = setTimeout(()=>{}, 0);
      clearTimeout(t);
    }
  };
  scheduleNightly();

  // Hourly N-new check
  const hourly = setInterval(() => {
    try {
      const state = readState();
      const current = countSessions();
      const lastCount = state?.sessionCount ?? 0;
      const delta = current - lastCount;
      const lastRun = state?.lastRun ? new Date(state.lastRun).getTime() : 0;
      const hoursSince = (Date.now() - lastRun) / (1000*60*60);
      if (delta >= N_TRIGGER || hoursSince >= 24) {
        if (delta >= N_TRIGGER) log.info(`[replayScheduler] N-trigger: ${delta} new sessions since last run`);
        runReplayDigest().catch(()=>{});
      }
    } catch (e) {
      log.warn('[replayScheduler] hourly check failed: ' + e.message);
    }
  }, 60*60*1000);
  // Allow process to exit even with interval
  if (hourly.unref) hourly.unref();

  log.info('[replayScheduler] initialized (nightly 03:00 + hourly N=5 check)');
}
