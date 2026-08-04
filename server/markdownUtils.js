// Markdown text-structure helpers shared across the doc parsers (readmeRunParser.js today;
// projectScanner.js's context-doc bucketing is a candidate Phase-11 consumer). Pure string
// manipulation, no dependencies.

/** Extracts the raw content of every fenced ``` code block, in document order. */
export function extractFencedBlocks(markdown) {
  const blocks = [];
  const re = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown))) blocks.push(m[1]);
  return blocks;
}

/** Splits a markdown doc into { header, body } sections at each heading line. */
export function splitIntoSections(markdown) {
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
