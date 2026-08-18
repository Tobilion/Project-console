// Phase 20 leaf: git-push "no upstream branch" recovery for executor.js (2026-08-13).
// `git push` on a branch that has never been pushed exits 128 with the "The current branch X
// has no upstream branch" fatal and does nothing else — a plain first push of a new branch
// (the ui-redesign workflow, live-reported) used to dead-end there with only the raw error.
// This mirrors executorPorts.js's offerPortRetry: detect the failure in the executor's close
// handler and offer a one-click, confirm-gated retry of the exact command git itself
// suggests (`git push --set-upstream origin <branch>`) — never executed without approval.

import crypto from 'crypto';
import { pendingConfirmations } from './state.js';

export const NO_UPSTREAM_RE = /fatal: The current branch (\S+) has no upstream branch\./;

// Git refnames are limited to letters/digits plus `.`, `_`, `-` and `/` (namespaces) — a
// branch name outside that set is a fabricated parse, and the name is interpolated into a
// shell command, so anything else must refuse rather than risk injection.
const SAFE_REFNAME_RE = /^[A-Za-z0-9._/+-]+$/;

/** Best-effort branch extraction from git's "no upstream branch" fatal. */
export function extractBranchWithoutUpstream(text) {
  const m = text.match(NO_UPSTREAM_RE);
  if (!m) return null;
  const branch = m[1];
  return SAFE_REFNAME_RE.test(branch) ? branch : null;
}

/**
 * After a failed `git push` because the current branch has no upstream (never pushed before),
 * offer a retry of `git push --set-upstream origin <branch>` — the command git itself prints
 * in the fatal — through the normal confirm-before-run flow, same as any other command. The
 * original push already went through the confirm gate, so the retry pushes identical content;
 * `--set-upstream` only records the tracking ref. Returns true when a retry confirmation was
 * queued.
 */
export function offerUpstreamRetry({ ws, projectId, command, stdout, stderr, exitCode }) {
  if (exitCode === 0 || !projectId) return false;
  // Only git push-shaped commands qualify — a bare `git push` or a push inside a chained
  // commit-and-push. Anything else printing the same fatal (a wrapper script) is left alone.
  if (!/\bgit\s+push\b/i.test(command)) return false;
  const branch = extractBranchWithoutUpstream(`${stdout}\n${stderr}`);
  if (!branch) return false;
  const retryCommand = `git push --set-upstream origin ${branch}`;
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId,
    command: retryCommand,
    // The trigger feeds createCheckpoint's `git commit -m "console-checkpoint: before
    // <trigger>"` (connectionConfirm.js:277), which breaks on embedded double quotes — cmd.exe
    // does not honor `\"`. The ORIGINAL deploy command carries the user's quoted commit message
    // ("push my site with the comment \"...\""), so using it here made the retry's auto-checkpoint
    // fail with a confusing "[GIT SAFETY] Failed to create git checkpoint" warning (live-probed
    // 2026-08-18). The retry command itself is quote-free, so it doubles as a safe trigger.
    trigger: retryCommand,
    createdAt: Date.now(),
  });
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'confirm_prompt',
      token,
      command: `${retryCommand}  (branch ${branch} has no upstream yet — set it and retry the push)`,
      trigger: 'git_no_upstream_retry',
    }));
  }
  return true;
}
