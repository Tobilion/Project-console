// reviewCandidate.js — second telemetry signal alongside the near-miss log (pre-Step-5).
//
// The near-miss log is structurally blind to misfires: all four log sites fire only when the
// pipeline FAILS to dispatch (fallback / guess / router-rescue). A confident wrong-intent
// dispatch (e.g. "commit with message X" -> git_status before its 2026-09-11 pin) never logs.
// This module records the two dispatch-time populations that CAN catch them:
//
//   low-conf            — a builtin dispatched by the semantic stage below REVIEW_CONFIDENCE
//                         (0.75: under the confident-whole bar, above the 0.6 semantic floor).
//                         May be right or wrong; needs human review, never auto-promoted.
//   trap-watch          — input matches a historically-confirmed trap shape AND dispatched to
//                         the pinned intent. Pin-health confirmation + live trap frequency.
//   trap-watch-misfire  — trap shape dispatched ANYWHERE ELSE. An automatically-counted
//                         known-trap misfire (e.g. a future pin reorder/regression).
//
// Storage (data/review-candidates/<project>.jsonl) is deliberately SEPARATE from
// data/near-misses/: learningEngine groups near-misses by resolvedCommand for promotion, and
// review candidates must never enter that flow unreviewed. Capped at 1000 lines per project
// (oldest trimmed) — trap-watch lines accrue on every matching dispatch by design.
// Imports node builtins + dataPath only (same discipline as evalGuard/doctor): safe to call
// from the hot dispatch path with zero cycle risk. Never throws.

import fs from 'fs';
import path from 'path';
import { resolveData } from './dataPath.js';

/** Semantic-stage wins below this are worth a human look (confident-whole bar is 0.75). */
export const REVIEW_CONFIDENCE = 0.75;
const MAX_LINES = 1000;
const TRIM_TO = 800;

// Mirrors of confirmed-trap pins — the CANONICAL patterns live in preSemanticOverridePins.js;
// these intentionally duplicate the shapes (not the import) so this module stays
// dependency-free and the whole watch list is reviewable in one place. If a pin changes,
// update its mirror here in the same commit.
const TRAP_WATCH = [
  { name: 'commit-with-message', pattern: /^com?mit\s+with\s+(?:the\s+)?(?:message|comment)\b/i, expect: ['git_commit'] },
  { name: 'bare-commit', pattern: /^com?mit\s*(?:it|now|everything|all|this|my changes|the changes|the code|my work)?$/i, expect: ['git_commit'] },
  // Push-with-comment legitimately routes git_push OR deploy (their example clusters overlap
  // heavily — see builtinGitWorkflow.js) — only anything ELSE is a misfire.
  { name: 'push-with-comment', pattern: /\bpush\b.*\bwith\b.*\bcomment\b/i, expect: ['git_push', 'system.chit_chat.deploy'] },
];

function safeProjectId(projectId) {
  return String(projectId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

function filePath(projectId) {
  return path.join(resolveData('review-candidates'), `${safeProjectId(projectId)}.jsonl`);
}

/**
 * Evaluate one successful builtin dispatch; append a review line when it qualifies.
 * Returns the reason ('low-conf' | 'trap-watch' | 'trap-watch-misfire') or null.
 */
export function maybeLogReviewCandidate(projectId, { input, intent, confidence = null, stage = null } = {}) {
  try {
    if (!projectId || !input || !intent) return null;
    let reason = null;
    let trap = null;
    for (const t of TRAP_WATCH) {
      if (t.pattern.test(String(input))) {
        trap = t.name;
        reason = t.expect.includes(intent) ? 'trap-watch' : 'trap-watch-misfire';
        break;
      }
    }
    // Low-conf applies to semantic-stage wins only — NLP/router/fuzzy scores live on
    // different scales with no calibrated weak band, so they stay out (documented limit).
    if (!reason && typeof confidence === 'number' && confidence < REVIEW_CONFIDENCE) {
      reason = 'low-conf';
    }
    if (!reason) return null;
    const dir = path.dirname(filePath(projectId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fp = filePath(projectId);
    let lines = [];
    try {
      if (fs.existsSync(fp)) lines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
    } catch { lines = []; }
    if (lines.length >= MAX_LINES) lines = lines.slice(lines.length - TRIM_TO);
    lines.push(JSON.stringify({
      ts: Date.now(),
      input: String(input).slice(0, 300),
      intent,
      confidence,
      stage,
      reason,
      trap: trap || undefined,
    }));
    fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
    return reason;
  } catch {
    return null;
  }
}

/** Read all review lines for a project (audit script surface). */
export function readReviewCandidates(projectId) {
  try {
    const fp = filePath(projectId);
    if (!fs.existsSync(fp)) return [];
    return fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** Every project id with a review-candidate file (audit sweep). */
export function listReviewCandidateProjectIds() {
  try {
    const dir = path.join(resolveData('review-candidates'));
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}
