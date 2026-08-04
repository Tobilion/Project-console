/**
 * Keyword fallback rules for semanticMatcher.js's match() stage 3 — pure data, in
 * rule-list order (first match wins, mirroring the original if-chain exactly).
 * Extracted from semanticMatcher.js (Phase 5, 2026-08-04); the per-rule confidence
 * values and the telemetry shape pushed on a hit are unchanged.
 *
 * Rule shape:
 *   intent       — intent key to return
 *   confidence   — fixed confidence reported on a hit
 *   re           — a single regex that must match
 *   and          — array of regexes, ALL must match
 *   or           — array of regexes, ANY must match (used with orLength as the
 *                  original `re && (orRe || length < N)` compound)
 *   orLength     — length bound usable as an alternative to `or`
 *   notRe        — must NOT match
 *   maxLength    — input must be shorter than this
 */
export const KEYWORD_RULES = [
  { intent: 'run_project', confidence: 0.45, and: [/\b(run|start|launch|open|execute)\b/, /\b(project|site|app|code|server|application)\b/] },
  { intent: 'system.chit_chat.gratitude', confidence: 0.5, re: /\b(thanks|thank|thx|appreciate|cheers)\b/ },
  { intent: 'system.chit_chat.greeting', confidence: 0.4, re: /\b(hi|hello|hey|howdy|sup|yo)\b/, maxLength: 30 },
  { intent: 'system.chit_chat.clear', confidence: 0.5, re: /\b(clear|cls|clean|wipe)\b/, or: [/\b(console|screen|chat)\b/], orLength: 10 },
  { intent: 'system.chit_chat.git_status', confidence: 0.4, and: [/\b(git|change|commit)\b/, /\b(status|changed|log|diff|commit)\b/] },
  { intent: 'git_push', confidence: 0.4, re: /\b(push|deploy.*git|upload.*github|send.*remote)\b/i },
  { intent: 'git_init', confidence: 0.45, re: /\binitialize git|init.*repo|start git/i },
  { intent: 'git_ignore_add', confidence: 0.4, re: /\bgiti?gnore\b/i },
  { intent: 'git_rm_cached', confidence: 0.45, re: /\b(remove|untrack|stop tracking).*git/i },
  { intent: 'run_project', confidence: 0.5, re: /\brun\s+(dev|start|serve|the\s+(site|project|app))\b/i },
  { intent: 'npm_run', confidence: 0.5, re: /\bnpm\s+(serve|start|dev|build|test|run)\b/i },
  { intent: 'run_project', confidence: 0.5, re: /\bnpx\s+serve\b/i },
  { intent: 'run_project', confidence: 0.45, re: /^(python|node)\s+\S+/i },
  { intent: 'npm_install', confidence: 0.4, re: /\b(install|npm i)\b/i, notRe: /\bremove|delete|uninstall\b/i },
  { intent: 'git_commit', confidence: 0.4, re: /\bcommit\b.*\b(changes?|work|code|files?|message|save)\b/i },
  { intent: 'git_commit_push', confidence: 0.5, re: /\bcommit\b.*\bpush\b|\bpush\b.*\bcommit\b/i },
  { intent: 'git_pull', confidence: 0.45, re: /\bpull\b.*\b(remote|origin|latest|changes|update)\b|\bgit pull\b/i },
  { intent: 'npm_build', confidence: 0.45, re: /\bbuild\b.*\b(project|app|site|code|bundle)\b|\bnpm run build\b/i },
  { intent: 'project_scan', confidence: 0.5, re: /\b(rescan|reindex|rescann|refresh index)\b/i },
  { intent: 'git_log', confidence: 0.45, re: /\bcommit history|git log|recent commits\b/i },
  { intent: 'git_branch', confidence: 0.4, re: /\b(git )?branch\b.*\b(list|show|current|what)\b|\bwhat branch\b/i },
  { intent: 'git_checkout', confidence: 0.45, re: /\b(switch branch|checkout|change branch)\b/i },
  { intent: 'file_create', confidence: 0.4, re: /\b(create|make|generate|write)\b.*\bfile\b/i },
  { intent: 'file_delete', confidence: 0.4, re: /\b(delete|remove|erase|trash)\b.*\bfile\b/i },
  { intent: 'system.chit_chat.undo', confidence: 0.5, re: /\b(undo|revert|rollback|go back)\b/i },
  { intent: 'system.chit_chat.help', confidence: 0.45, re: /\b(help|commands?|what can you|how.*use|tutorial)\b/i },
  { intent: 'project.context.tests', confidence: 0.4, re: /\b(test|testing|spec)\b.*\b(run|how|show|what|suite|coverage)\b/i },
];

function testRule(rule, s) {
  if (rule.and && !rule.and.every(r => r.test(s))) return false;
  if (rule.re && !rule.re.test(s)) return false;
  if (rule.or && !(rule.or.some(r => r.test(s)) || (rule.orLength !== undefined && s.length < rule.orLength))) return false;
  if (rule.notRe && rule.notRe.test(s)) return false;
  if (rule.maxLength !== undefined && s.length >= rule.maxLength) return false;
  return true;
}

/** First matching keyword rule for the input, or null. First-match-wins, in list order. */
export function matchKeywordRule(inputStr) {
  for (const rule of KEYWORD_RULES) {
    if (testRule(rule, inputStr)) return rule;
  }
  return null;
}
