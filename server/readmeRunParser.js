/**
 * Trigger-mode (no AI, no Ollama) README/CLAUDE.md parser: looks for a real, author-documented
 * "how do I run this" command instead of always falling back to a per-language guess. Requested
 * directly (2026-07-30) — the concern was specifically about how much *trigger mode* (not AI
 * mode, which already reads docs generically via its own tool loop — see ollamaContext.js) can
 * understand from a project's own README without any LLM involved. Pure regex/heuristics, same
 * spirit as codebaseIndexer.js and outputSummarizer.js: no parser dependency, no network call,
 * tuned for coverage over precision.
 */
import { extractFencedBlocks, splitIntoSections } from './markdownUtils.js';
import { RUN_COMMAND_PATTERNS } from './runCommandPatterns.js';

// Markdown headings (any level) that conventionally contain "how to run/use/install this" —
// wider than projectScanner.js's own parsedKnowledge bucketing (which only recognizes "## Commands"
// / "## Run" and dumps everything else into a generic "architecture" bucket). Real-world READMEs
// overwhelmingly use one of these instead.
const RUN_HEADER_RE = /^#{1,6}\s*(install(ation)?|getting started|quick ?start|usage|run(ning)?|development|setup|how to run|local development|starting the (?:app|server|project))\b/i;

// Cap on how many distinct documented run commands a single project can report. Beyond this the
// doc is likely a tutorial with dozens of one-off invocations, not a "how to run this" reference.
const MAX_DOCUMENTED_COMMANDS = 6;

/** Extracts one full command from a single line, or null if the line holds nothing recognizable. */
function matchCommandLine(rawLine) {
  const trimmed = rawLine.trim().replace(/^\$\s*/, '').replace(/^\d+[.)]\s*/, '');
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
  for (const pattern of RUN_COMMAND_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      const tail = trimmed.slice(m.index + m[0].length);
      const rest = tail.split(/(?:\s*#|\s*\/\/|\s*&&|\s*\|\|)\s*/)[0].trim();
      return (m[0] + (rest ? ` ${rest}` : '')).trim();
    }
  }
  return null;
}

/** All distinct recognized commands across the lines of a block of text, in first-seen order. */
function allMatchingCommandLines(text) {
  const found = [];
  for (const rawLine of text.split('\n')) {
    const command = matchCommandLine(rawLine);
    if (command && !found.includes(command)) found.push(command);
  }
  return found;
}

/**
 * Looks for real, documented "how do I run this" commands inside a project's own context docs
 * (CLAUDE.md/README.md/etc. — see projectScanner.js's CONTEXT_FILENAMES, already sorted with
 * CLAUDE.md first). Prefers commands found under clearly-labeled Install/Usage/Run/Getting
 * Started sections; falls back to scanning every fenced code block in the docs if no labeled
 * section is found (many READMEs skip headings entirely for short projects). Returns an array of
 * `{ command, doc, header }` (header is `null` when found via the unlabeled fallback pass),
 * deduplicated by command string, in a stable order (labeled-section wins over fallback, then doc
 * order, then first-seen), capped at MAX_DOCUMENTED_COMMANDS. Collecting ALL run commands — not
 * just the first — is what answers "what are all the ways to run this project, site + server +
 * services" instead of only "what's the first one"; see projectTypeSuggestions()/how_to_run in
 * builtinIntents.js.
 */
export function findDocumentedRunCommands(project) {
  const docs = project?.contextFiles || [];
  const results = [];
  const seen = new Set();
  const push = (command, doc, header) => {
    if (seen.has(command)) return;
    seen.add(command);
    results.push({ command, doc, header });
  };
  const collectSections = (doc, labeledOnly) => {
    const sections = splitIntoSections(doc.content || '');
    for (const section of sections) {
      if (labeledOnly && !RUN_HEADER_RE.test(section.header)) continue;
      const header = labeledOnly ? section.header.replace(/^#+\s*/, '').trim() : null;
      const body = section.body.join('\n');
      // Some READMEs use indented/plain text instead of fenced blocks under the section, so scan
      // both the section's fenced blocks and its raw body lines.
      for (const block of extractFencedBlocks(body)) {
        for (const cmd of allMatchingCommandLines(block)) push(cmd, doc.filename, header);
      }
      for (const cmd of allMatchingCommandLines(body)) push(cmd, doc.filename, header);
    }
  };

  // Pass 1: labeled Install/Usage/Run/etc. sections only. A command from a real "## Run" section
  // outranks anything found later in an unlabeled code block, so it gets collected first.
  for (const doc of docs) collectSections(doc, true);
  // Pass 2 (only when pass 1 found nothing): every fenced code block regardless of heading.
  if (results.length === 0) {
    for (const doc of docs) {
      for (const block of extractFencedBlocks(doc.content || '')) {
        for (const cmd of allMatchingCommandLines(block)) push(cmd, doc.filename, null);
      }
    }
  }
  return results.slice(0, MAX_DOCUMENTED_COMMANDS);
}

/**
 * First-match convenience wrapper — `{ command, doc, header }` or `null`. Kept for callers that
 * only need the single "primary" run command; identical ordering to findDocumentedRunCommands,
 * this is exactly its first element.
 */
export function findDocumentedRunCommand(project) {
  const list = findDocumentedRunCommands(project);
  return list[0] || null;
}
