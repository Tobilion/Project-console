// Phase 12 leaf: pure output transforms for executor.js (verbatim moves).

// Strips ANSI escape sequences so URL detection isn't fooled by color/bold codes
export const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

// Matches URLs like http://localhost:3000, http://127.0.0.1:5173/, etc.
export const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]):\d{2,5}\/?/gi;

// Git prints one of these per file, the first time each file is committed under whatever
// core.autocrlf setting is active — purely informational, not an error, and not something the
// user can or needs to act on. Confirmed live 2026-07-29: committing ~160 new files in one go
// (see git_add_A style bulk commits from trigger mode) produced 159 of these on stderr, each
// forwarded as a separate chat bubble (see the buffering fix below) — collapsed here into one
// summary line instead of spamming the chat with a warning per file.
const LF_CRLF_WARNING_RE = /^warning: in the working copy of '([^']+)', LF will be replaced by CRLF the next time Git touches it\.?$/;

/** Collapse repeated per-file LF/CRLF warnings in a stderr chunk into a single summary line,
 * leaving any other stderr content (real errors, other warnings) untouched. */
export function collapseLfCrlfWarnings(text) {
  const lines = text.split('\n');
  const affectedFiles = [];
  const kept = [];
  for (const line of lines) {
    const m = line.match(LF_CRLF_WARNING_RE);
    if (m) affectedFiles.push(m[1]);
    else kept.push(line);
  }
  if (affectedFiles.length === 0) return text;
  const summary = affectedFiles.length <= 3
    ? `warning: line endings will be normalized (LF -> CRLF) for: ${affectedFiles.join(', ')} (cosmetic, no action needed)`
    : `warning: line endings will be normalized (LF -> CRLF) for ${affectedFiles.length} files (cosmetic, no action needed)`;
  const rest = kept.join('\n').trim();
  return rest ? `${rest}\n${summary}` : summary;
}

// How long to coalesce rapid bursts of stdout/stderr `data` events before forwarding them to the
// client as one message. Without this, a command that writes many small chunks in quick
// succession (git printing one warning line per file is the confirmed-live case) turns into one
// chat bubble per chunk — this batches them into far fewer, larger messages instead. Kept short
// enough that normal command output still feels live.
const OUTPUT_FLUSH_MS = 150;

/**
 * Wraps a `sendEvent(type, text)` call with a small buffering window so rapid bursts of output
 * become one flushed message instead of one message per OS-level `data` event. `transform` (if
 * given) runs once on the buffered text right before it's sent — used here to collapse repeated
 * LF/CRLF warnings — so it only has to look at a handful of flushed batches, not every raw chunk.
 */
export function createBufferedSender(sendEvent, type, transform) {
  let buffer = '';
  let timer = null;
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer) return;
    const out = transform ? transform(buffer) : buffer;
    if (out) {
      // A transform may reroute the batch to a different channel entirely (e.g. the LF/CRLF
      // collapse summary → `warning` instead of `error_output`) by returning { type, text }.
      if (typeof out === 'object' && out.type && out.text) sendEvent(out.type, out.text);
      else sendEvent(type, out);
    }
    buffer = '';
  }
  return {
    push(chunk) {
      buffer += chunk;
      if (!timer) timer = setTimeout(flush, OUTPUT_FLUSH_MS);
    },
    flush,
  };
}
