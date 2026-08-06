// Heuristic, fully local (no LLM/Ollama needed) summarizer for command output. This is not a
// replacement for the raw log — that's still streamed live exactly as before — it's an
// additional short "what actually happened" callout appended once a command finishes, so the
// user isn't stuck reading a long dump to find the one or two lines that actually mattered.
// Regex-based rather than an LLM call because git/npm output has a small, stable set of
// "important line" shapes, and — same hard constraint as the rest of trigger mode — this needs
// to keep working even with Ollama off or unavailable.

// Below this, the raw output already fits on screen without scrolling — summarizing it would
// just be a second, shorter copy of something already easy to read.
const MIN_LINES_TO_SUMMARIZE = 8;
const MIN_CHARS_TO_SUMMARIZE = 400;

// Same pattern as executor.js's live-stream collapsing — recognized separately here so the
// closing summary can report a count without repeating the streamed detail.
import { ANSI_RE } from './executorOutput.js';

const LF_CRLF_RE = /^warning: in the working copy of '([^']+)', LF will be replaced by CRLF the next time Git touches it\.?$/;
// NOTE: "ERR!" ends in a non-word character, so a trailing `\b` after it never matches (`\b`
// needs a word/non-word transition, and "!" followed by a space/end-of-line is non-word on both
// sides) — verified this actually breaks matching before shipping it. Handled as its own
// alternative without a trailing boundary instead.
const ERROR_LINE_RE = /\b(error|fatal|traceback|exception)\b|ERR!/i;

const NPM_SUMMARY_RE = /^(added|removed|changed) \d+ packages?.*$/im;
const NPM_VULN_RE = /^\d+ vulnerabilit(?:y|ies)\s*\(.*\)$/im;
const GIT_COMMIT_RE = /^\[[\w/.-]+ [0-9a-f]+\] .+$/m;
const GIT_STAT_RE = /^\s*\d+ files? changed.*$/m;
const GIT_PUSH_OK_RE = /^\s*[0-9a-f]{7,}\.\.[0-9a-f]{7,}\s+\S+\s*->\s*\S+/m;
const GIT_UP_TO_DATE_RE = /Everything up-to-date|Already up to date\.?/i;
const GIT_PUSH_REJECTED_RE = /! \[rejected\]|failed to push|non-fast-forward/i;
const GIT_CONFLICT_RE = /^CONFLICT\b.*$/m;

/**
 * Produce a short highlights block for a finished command's combined stdout/stderr, or null if
 * the output is short enough that a summary wouldn't add anything, or nothing worth flagging was
 * found. Deliberately additive to (never a replacement for) the full live-streamed log.
 */
export function summarizeCommandOutput({ command, stdout = '', stderr = '', exitCode }) {
  // Strip ANSI escapes before scanning — the raw accumulators keep them (they're stripped only
  // for URL detection at stream time), so colored error lines used to land verbatim in the
  // summary bubble as escape junk (the frontend has no ANSI handling; audit 2026-08-06).
  const combined = `${stdout}\n${stderr}`.replace(ANSI_RE, '');
  const lineCount = combined.split('\n').filter((l) => l.trim()).length;
  if (lineCount < MIN_LINES_TO_SUMMARIZE && combined.length < MIN_CHARS_TO_SUMMARIZE) {
    return null;
  }

  const errorLines = [];
  let lfCrlfCount = 0;
  for (const line of combined.split('\n')) {
    if (LF_CRLF_RE.test(line)) {
      lfCrlfCount++;
      continue;
    }
    if (line.trim() && ERROR_LINE_RE.test(line)) {
      // Cap each shown line — a minified error or giant stack trace used to be embedded whole,
      // making the summary as large as the output it was meant to condense.
      const t = line.trim();
      errorLines.push(t.length > 200 ? `${t.slice(0, 200)}…` : t);
    }
  }

  const highlights = [];

  if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
    highlights.push(`✖ Exited with code ${exitCode}`);
  }

  if (GIT_CONFLICT_RE.test(combined)) {
    highlights.push(`⚠ Merge conflict detected — resolve before continuing.`);
  }
  if (GIT_PUSH_REJECTED_RE.test(combined)) {
    highlights.push(`✖ Push was rejected (remote has changes you don't have locally — pull first).`);
  }

  if (errorLines.length) {
    const shown = errorLines.slice(0, 5);
    const more = errorLines.length > shown.length ? `\n  - ...and ${errorLines.length - shown.length} more` : '';
    highlights.push(`**Errors/warnings noticed:**\n${shown.map((l) => `  - ${l}`).join('\n')}${more}`);
  }

  if (lfCrlfCount > 0) {
    highlights.push(`Line endings normalized (LF → CRLF) for ${lfCrlfCount} file(s) — cosmetic, no action needed.`);
  }

  const npmSummary = combined.match(NPM_SUMMARY_RE);
  if (npmSummary) highlights.push(`${npmSummary[0].trim()}`);
  const npmVuln = combined.match(NPM_VULN_RE);
  if (npmVuln) highlights.push(`⚠ ${npmVuln[0].trim()}`);

  const gitCommit = combined.match(GIT_COMMIT_RE);
  if (gitCommit) highlights.push(`✓ ${gitCommit[0].trim()}`);
  const gitStat = combined.match(GIT_STAT_RE);
  if (gitStat) highlights.push(gitStat[0].trim());
  const gitPush = combined.match(GIT_PUSH_OK_RE);
  if (gitPush) highlights.push(`✓ Pushed: ${gitPush[0].trim()}`);
  if (GIT_UP_TO_DATE_RE.test(combined)) highlights.push('Nothing to update — already up to date.');

  if (highlights.length === 0) {
    // Nothing structured recognized, but the output was long enough to be worth a summary —
    // still say *something* so the user knows a big dump didn't hide anything alarming, without
    // making them re-read it themselves.
    if (exitCode === 0 || exitCode === null || exitCode === undefined) {
      highlights.push(`✓ Completed with no errors detected (${lineCount} lines of output above).`);
    } else {
      return null; // non-zero exit with nothing else recognized — let the raw output speak for itself
    }
  }

  return `**Summary of \`${command}\`:**\n${highlights.join('\n')}`;
}
