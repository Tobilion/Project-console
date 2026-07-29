import fs from 'fs/promises';
import path from 'path';

// Well-known npm script names get friendlier trigger phrases than the generic fallback.
const KNOWN_SCRIPTS = {
  dev: { triggers: ['run dev server', 'start dev', 'start dev server'], risky: false },
  start: { triggers: ['start app', 'run app', 'run the app'], risky: false },
  build: { triggers: ['build project', 'run build', 'build the app'], risky: false },
  preview: { triggers: ['preview build', 'preview production build'], risky: false },
  lint: { triggers: ['run lint', 'lint code', 'type check', 'typecheck'], risky: false },
  test: { triggers: ['run tests', 'test suite', 'run test suite'], risky: false },
  'test:unit': { triggers: ['run unit tests'], risky: false },
  'test:e2e': { triggers: ['run e2e tests', 'run end to end tests'], risky: false },
  format: { triggers: ['format code', 'run formatter'], risky: false },
  deploy: { triggers: ['deploy', 'deploy to production', 'push live'], risky: true },
  publish: { triggers: ['publish package', 'publish to npm'], risky: true },
  release: { triggers: ['cut a release', 'release'], risky: true },
};

const RISKY_PATTERN = /deploy|publish|release|--prod|force/i;

/** Turns a package.json `scripts` object into console.config.json-shaped entries. */
export function deriveScriptEntries(scripts) {
  if (!scripts || typeof scripts !== 'object') return [];

  const entries = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!command || typeof command !== 'string') continue;
    const known = KNOWN_SCRIPTS[name];
    const triggers = known ? [...known.triggers, `npm run ${name}`] : [`run ${name}`, `npm run ${name}`];
    const risky = known ? known.risky : RISKY_PATTERN.test(name) || RISKY_PATTERN.test(command);

    entries.push({
      triggers,
      type: 'command',
      action: `npm run ${name}`,
      risky,
      // Every `npm run <script>` needs the local devDependencies/bins in node_modules to exist
      // first — without this, a missing-install project just throws a raw "command not found" /
      // npm error at the user instead of the obvious fix. Generic and automatic: applies to every
      // npm-based project this deriving from package.json ever runs against, current or future,
      // with no per-project config needed (see matchedEntry.js's runCommandEntry, which already
      // supports requires/requiresMessage on any command entry, hand-authored or auto-derived).
      requires: ['node_modules'],
      requiresMessage: `Dependencies haven't been installed yet — say "npm install" (or run it yourself), then ask me to run this again.`,
      // Marks this entry as machine-derived from package.json rather than hand-authored in
      // console.config.json, so it's visually distinguishable (and safe to regenerate/drop
      // if the script disappears) without touching what Tobi wrote himself.
      auto: true,
    });
  }
  return entries;
}

/** Reads a project's package.json and derives entries, or [] if there is none / it's malformed. */
export async function deriveScriptEntriesForProject(projectPath) {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    return deriveScriptEntries(pkg.scripts);
  } catch {
    return [];
  }
}

/**
 * Merges auto-derived entries into an existing config, skipping any whose action already
 * exactly matches an existing entry (hand-authored entries always win; this only fills gaps).
 * Mutates and returns `config`.
 */
export function mergeAutoEntries(config, autoEntries) {
  if (!autoEntries.length) return config;
  const existingActions = new Set(
    (config.entries || [])
      .filter(e => e.type === 'command' && e.action)
      .map(e => e.action.trim())
  );
  const toAdd = autoEntries.filter(e => !existingActions.has(e.action.trim()));
  if (toAdd.length) {
    config.entries = [...(config.entries || []), ...toAdd];
  }
  return config;
}
