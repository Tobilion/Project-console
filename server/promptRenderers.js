import { formatRepoMap, formatApiRoutes } from './codebaseIndexer.js';

// Full AI mode can afford a larger repo-map slice than the router tier's single bounded call
// (see localRouter.js) since it's a real multi-turn conversation the user opted into, not a
// fast-path classification — but still capped, since this whole system prompt already includes
// CLAUDE.md content (up to MAX_DOC_CHARS below) and needs to leave room for actual conversation.
const MAX_SYSTEM_PROMPT_REPO_MAP_CHARS = 6000;

// CLAUDE.md (or the highest-priority context doc — see projectScanner.js CONTEXT_FILENAMES) is
// the project's own source of truth: architecture notes, gotchas, conventions, safety rules.
// Feeding it into the system prompt means the model doesn't have to guess or call readFile
// before it knows anything, and it's what makes "explain more" / "why does X work this way"
// answers accurate instead of generic.
const MAX_DOC_CHARS = 6000;

/**
 * Renders a codebaseIndex into a compact project-summary string for the AI system prompt.
 * When `targetSlice` is given (a file the user explicitly asked about — see codebaseGraph.js),
 * it replaces the whole-project signature map with the focused per-file slice, so the context
 * answers the question instead of dumping every export in the project.
 */
export function formatIndex(idx, targetSlice) {
  if (!idx) return 'No index data available.';
  let lines = [`- ${idx.totalFiles} files, ${idx.totalDirs} directories`];
  if (idx.languages?.length) lines.push(`- Languages: ${idx.languages.slice(0, 5).join(', ')}`);
  if (idx.frameworks?.length) lines.push(`- Detected stack: ${idx.frameworks.join(', ')}`);
  if (idx.entryPoints?.length) lines.push(`- Entry points: ${idx.entryPoints.join(', ')}`);
  if (idx.hasTests) lines.push('- Has test files');
  if (idx.hasCli) lines.push('- Has CLI entry point');
  if (idx.hasGit) lines.push('- Git repository: yes');
  if (idx.isMonorepo) {
    lines.push(`- **Monorepo**: ${idx.subPackages.length} sub-packages detected — ${idx.subPackages.map(p => `${p.path} (${p.manifests.join(', ')})`).join('; ')}. Treat each as its own independently-runnable package rather than assuming one root command runs everything.`);
  }
  if (idx.fileSample?.length) lines.push(`- Sample files: ${idx.fileSample.slice(0, 8).join(', ')}`);
  if (idx.entrySnippets && Object.keys(idx.entrySnippets).length) {
    for (const [file, snippet] of Object.entries(idx.entrySnippets)) {
      lines.push(`\n--- ${file} (excerpt) ---\n${snippet}`);
    }
  }
  // Repo map: whole-project export/function/class names, not just the 1-2 entry-point files
  // above — lets the model resolve "the config file" / "that component" with real project
  // awareness instead of guessing or always reaching for readFile first. See codebaseIndexer.js.
  const repoMapText = targetSlice ?? formatRepoMap(idx.repoMap, MAX_SYSTEM_PROMPT_REPO_MAP_CHARS);
  if (repoMapText) {
    const header = targetSlice
      ? '--- Project signature map (focused on the file you asked about; the full map is available via getProjectInfo) ---'
      : '--- Project signature map (exports/functions/classes by file, plus which files import/are imported by each other) ---';
    lines.push(`\n${header}\n${repoMapText}`);
  }
  // API surface (Express/Flask/FastAPI/Django route declarations) — a different, often more
  // directly useful kind of structural understanding than the export list above: "what does this
  // app expose over HTTP" rather than "what does each file export".
  const routesText = formatApiRoutes(idx.apiRoutes, 2000);
  if (routesText) {
    lines.push(`\n--- Detected API routes ---\n${routesText}`);
  }
  return lines.join('\n');
}

/** Renders a project's primary context doc (CLAUDE.md/README.md) for system-prompt injection. */
export function formatProjectDoc(project) {
  const docs = project.contextFiles;
  if (!docs || docs.length === 0) return null;

  const primary = docs[0];
  let text = primary.content.length > MAX_DOC_CHARS
    ? `${primary.content.slice(0, MAX_DOC_CHARS)}\n... (truncated — use readFile("${primary.filename}") for the rest)`
    : primary.content;

  let out = `--- ${primary.filename} ---\n${text}`;

  const others = docs.slice(1).map(d => d.filename);
  if (others.length) {
    out += `\n\n(Other project docs available via readFile if needed: ${others.join(', ')})`;
  }
  return out;
}

/** Minimal one-line project summary used for workspace context. */
export function formatMinimalProject(p) {
  const idx = p.codebaseIndex;
  const langs = idx?.languages?.slice(0, 3).join(', ') || 'unknown';
  const files = idx?.totalFiles || '?';
  return `- **${p.name}** (\`${p.path}\`) — ${files} files, ${langs}`;
}
