// Phase 3 (2026-08-17): server-side command-risk classifier for the executeCommand gate.
//
// The confirm gate used to depend entirely on the caller-supplied `risky` flag — the model (AI
// tool loop) or the frontend (chips send `risky: false` unconditionally) decided whether a
// command was destructive, and a caller that omitted the flag got ungated shell execution of
// e.g. `git push` with no confirm and no checkpoint. This module computes the effective risk
// server-side so the flag can only ever ADD risk, never waive it.
//
// Scope discipline: this decides whether a command is *confirm-worthy*, not whether it may run
// at all — the hard blocklist (dangerousPatterns.js) stays the absolute prohibition layer on
// top. Keep the patterns narrow (the codebase's pre-semantic-override rule: confirmed traps
// only); a false positive is a confirm prompt the user can dismiss, a false negative is an
// ungated destructive command.

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // Git — any push can publish unreviewed state, and history rewrites / local-work discards
  // are irreversible without intervention. `git pull` is deliberately NOT here: it never
  // loses work on its own, and gating it would put a confirm in front of an everyday flow.
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+checkout\s+(?:\.|--)(?:\s|$)/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+commit\s+--amend\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+tag\s+-d\b/i,
  /\bgit\s+push\s+--delete\b/i,
  // Package registry publication / global removal.
  /\b(?:npm|yarn|pnpm|bun|cargo)\s+(?:publish|unpublish)\b/i,
  /\b(?:npm|yarn|pnpm|bun)\s+(?:remove|rm|uninstall)\s+-g\b/i,
  // Recursive deletes (rm -rf, del /s /q, rd /s /q, rmdir /s /q, Remove-Item -Recurse/-Force).
  // The rm flag class accepts both -rf and -fr orders (the blocklist's
  // `-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*` mirrors both) and keeps plain `-r`
  // confirm-worthy — a recursive delete is gated regardless of the force flag.
  /\brm\s+(?:--recursive|-[a-z]*[rR][a-z]*(?:[fF][a-z]*)?)\b/i,
  /\bdel\s+(?:\/s\b|\/q\b)/i,
  /\brd\s+(?:\/s\b|\/q\b)/i,
  /\brmdir\s+(?:\/s\b|\/q\b)/i,
  /\bRemove-Item\b/i,
  // Disk-level utilities. `format` alone would false-positive on "git format-patch", so it
  // requires a drive letter ("format C:").
  /\b(?:mkfs|diskpart|fdisk|shred|wipefs)\b/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bdd\s+if=/i,
  // Shell redirect onto a raw block device (`> /dev/sda` — mirror of dangerousPatterns.js,
  // kept so the hard blocklist is always a strict subset of the confirm gate's view).
  />\s*\/dev\/sd[a-z]/i,
  // System power-state changes and the PowerShell shutdown wrappers (dangerousPatterns
  // mirror — the blocklist covers these shapes, so the classifier must too).
  /\bshutdown\s+(?:\/s|\/r|-h|-r)\b/i,
  /\bReflect-(?:Computer|System)\b/i,
  // Fork-bomb shape (`:(){ :|:& };:`) — impossible to recover from on a local machine.
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;/i,
];

/** Effective-risk computation for a shell command string. Returns true when the command
 *  matches a destructive pattern and must go through the confirm gate regardless of what the
 *  caller's `risky` flag says. */
export function isDestructiveCommand(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}