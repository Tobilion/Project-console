// Known run-command shapes for README/CLAUSE.md parsing — one regex per language/framework.
// Split out of readmeRunParser.js (Phase 2 modularization) so any future doc parser can reuse
// the same closed command-shape list. Deliberately literal (precision over recall — a false
// positive would present the wrong command as documented). The Python entries accept an
// optional interpreter path prefix because venv-style interpreters are the norm on Windows.

export const RUN_COMMAND_PATTERNS = [
  /\bnpm run [\w:-]+/i, /\byarn [\w:-]+/i, /\bpnpm run [\w:-]+/i, /\bnpm start\b/i,
  /\bcargo run(?:\s+--\S+)*\b/i,
  /\bgo run\s+\S+/i, /\bgo build\s+.*&&\s*\S+/i,
  /\bmvn spring-boot:run\b/i, /\bmvn (?:compile\s+)?exec:java\b/i, /\bmvn (?:clean\s+)?package\b/i,
  /\.\/gradlew\s+(?:bootRun|run)\b/i, /\bgradlew\.bat\s+(?:bootRun|run)\b/i,
  /\bdotnet run\b/i, /\bdotnet watch run\b/i,
  /\bbundle exec \S+(?:\s+\S+){0,3}/i, /\brails s(?:erver)?\b/i, /\brackup\b/i,
  /\bphp artisan serve\b/i, /\bphp -S\s+\S+/i,
  /\b[\w.:\\\/-]*python(?:3)?(?:\.exe)?\s+manage\.py\s+runserver\b/i, /\bflask run\b/i, /\buvicorn\s+\S+/i,
  /\bgunicorn\s+\S+/i, /\bstreamlit run\s+\S+/i,
  /\bdocker-compose up\b/i, /\bdocker compose up\b/i,
  /\bnode\s+\S+\.m?js\b/i,
  /\b[\w.:\\\/-]*python(?:3)?(?:\.exe)?\s+\S+\.py\b/i,
];
