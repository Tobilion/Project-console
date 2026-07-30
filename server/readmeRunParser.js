/**
 * Trigger-mode (no AI, no Ollama) README/CLAUDE.md parser: looks for a real, author-documented
 * "how do I run this" command instead of always falling back to a per-language guess. Requested
 * directly (2026-07-30) — the concern was specifically about how much *trigger mode* (not AI
 * mode, which already reads docs generically via its own tool loop — see ollamaContext.js) can
 * understand from a project's own README without any LLM involved. Pure regex/heuristics, same
 * spirit as codebaseIndexer.js and outputSummarizer.js: no parser dependency, no network call,
 * tuned for coverage over precision.
 */

// Markdown headings (any level) that conventionally contain "how to run/use/install this" —
// wider than projectScanner.js's own parsedKnowledge bucketing (which only recognizes "## Commands"
// / "## Run" and dumps everything else into a generic "architecture" bucket). Real-world READMEs
// overwhelmingly use one of these instead.
const RUN_HEADER_RE = /^#{1,6}\s*(install(ation)?|getting started|quick ?start|usage|run(ning)?|development|setup|how to run|local development|starting the (?:app|server|project))\b/i;

// One pattern per well-known run-command shape, across languages/frameworks. Deliberately a
// closed, literal list (not a general "looks like a shell command" detector) — precision over
// recall, since a false positive here would present the wrong command as if it were documented.
const RUN_COMMAND_PATTERNS = [
  /\bnpm run [\w:-]+/i, /\byarn [\w:-]+/i, /\bpnpm run [\w:-]+/i, /\bnpm start\b/i,
  /\bcargo run(?:\s+--\S+)*\b/i,
  /\bgo run\s+\S+/i, /\bgo build\s+.*&&\s*\S+/i,
  /\bmvn spring-boot:run\b/i, /\bmvn (?:compile\s+)?exec:java\b/i, /\bmvn (?:clean\s+)?package\b/i,
  /\.\/gradlew\s+(?:bootRun|run)\b/i, /\bgradlew\.bat\s+(?:bootRun|run)\b/i,
  /\bdotnet run\b/i, /\bdotnet watch run\b/i,
  /\bbundle exec \S+(?:\s+\S+){0,3}/i, /\brails s(?:erver)?\b/i, /\brackup\b/i,
  /\bphp artisan serve\b/i, /\bphp -S\s+\S+/i,
  /\bpython3?\s+manage\.py\s+runserver\b/i, /\bflask run\b/i, /\buvicorn\s+\S+/i,
  /\bgunicorn\s+\S+/i, /\bstreamlit run\s+\S+/i,
  /\bdocker-compose up\b/i, /\bdocker compose up\b/i,
  /\bnode\s+\S+\.m?js\b/i,
  /\bpython3?\s+\S+\.py\b/i,
];

function extractFencedBlocks(markdown) {
  const blocks = [];
  const re = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown))) blocks.push(m[1]);
  return blocks;
}

/** Splits a markdown doc into { header, body } sections at each heading line. */
function splitIntoSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let current = { header: '', body: [] };
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (current.body.length || current.header) sections.push(current);
      current = { header: line, body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length || current.header) sections.push(current);
  return sections;
}

function firstMatchingCommandLine(text) {
  for (const rawLine of text.split('\n')) {
    // Strip a leading shell prompt ("$ npm start") or numbered-step prefix ("1. npm start").
    const trimmed = rawLine.trim().replace(/^\$\s*/, '').replace(/^\d+[.)]\s*/, '');
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    for (const pattern of RUN_COMMAND_PATTERNS) {
      const m = trimmed.match(pattern);
      if (m) return m[0].trim();
    }
  }
  return null;
}

/**
 * Looks for a real, documented "how do I run this" command inside a project's own context docs
 * (CLAUDE.md/README.md/etc. — see projectScanner.js's CONTEXT_FILENAMES, already sorted with
 * CLAUDE.md first). Prefers a command found under a clearly-labeled Install/Usage/Run/Getting
 * Started section; falls back to scanning every fenced code block in the doc if no such section
 * is found (many READMEs skip headings entirely for short projects). Returns
 * `{ command, doc, header }` (header is `null` when found via the unlabeled fallback pass) or
 * `null` if nothing recognizable was found anywhere.
 */
export function findDocumentedRunCommand(project) {
  const docs = project?.contextFiles || [];
  for (const doc of docs) {
    const sections = splitIntoSections(doc.content || '');
    for (const section of sections) {
      if (!RUN_HEADER_RE.test(section.header)) continue;
      const body = section.body.join('\n');
      for (const block of extractFencedBlocks(body)) {
        const found = firstMatchingCommandLine(block);
        if (found) return { command: found, doc: doc.filename, header: section.header.replace(/^#+\s*/, '').trim() };
      }
      // Some READMEs use indented/plain text instead of fenced blocks under the section.
      const found = firstMatchingCommandLine(body);
      if (found) return { command: found, doc: doc.filename, header: section.header.replace(/^#+\s*/, '').trim() };
    }
    for (const block of extractFencedBlocks(doc.content || '')) {
      const found = firstMatchingCommandLine(block);
      if (found) return { command: found, doc: doc.filename, header: null };
    }
  }
  return null;
}
