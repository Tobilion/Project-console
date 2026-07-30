import fs from 'fs/promises';
import path from 'path';
import { indexProject } from './codebaseIndexer.js';
import { deriveScriptEntries } from './scriptEntries.js';

const INDENT = '  ';

function pickEntryPoint(idx) {
  const candidates = ['main.py', 'app.py', 'manage.py', 'main.go', 'main.rs', 'main.ts', 'index.js', 'server.js'];
  for (const c of candidates) {
    if (idx.entryPoints.includes(c)) return c;
  }
  return idx.entryPoints[0] || null;
}

function buildEntries(idx, pkg) {
  const entries = [];

  // npm package.json scripts
  if (pkg && pkg.scripts) {
    const scriptEntries = deriveScriptEntries(pkg.scripts);
    for (const se of scriptEntries) {
      entries.push({
        triggers: se.triggers,
        type: 'command',
        action: se.action,
        risky: se.risky || false,
      });
    }
  }

  // Non-npm project detection (only if no scripts were found)
  if (!entries.length) {
    const hasFlask = idx.frameworks && idx.frameworks.includes('Flask');
    const hasDjango = idx.frameworks && idx.frameworks.includes('Django');
    const hasCargo = idx.keyFiles && idx.keyFiles['Cargo.toml'];
    const hasGoMod = idx.keyFiles && idx.keyFiles['go.mod'];

    if (hasDjango && idx.entryPoints.some(e => e.includes('manage.py'))) {
      entries.push({ triggers: ['run dev server', 'start dev'], type: 'command', action: 'python manage.py runserver', risky: false });
    } else if (hasFlask) {
      entries.push({ triggers: ['run dev server', 'start dev'], type: 'command', action: 'flask run', risky: false });
    } else if (idx.entryPoints.some(e => /\.py$/.test(e))) {
      const ep = pickEntryPoint(idx);
      if (ep) entries.push({ triggers: ['run app', 'start app'], type: 'command', action: `python ${ep}`, risky: false });
    }
    if (idx.hasTests && (idx.keyFiles['requirements.txt'] || idx.keyFiles['pyproject.toml'])) {
      entries.push({ triggers: ['run tests'], type: 'command', action: 'pytest', risky: false });
    }
    if (hasCargo) {
      entries.push({ triggers: ['run app', 'build and run'], type: 'command', action: 'cargo run', risky: false });
      entries.push({ triggers: ['run tests'], type: 'command', action: 'cargo test', risky: false });
    }
    if (hasGoMod) {
      entries.push({ triggers: ['run app', 'start app'], type: 'command', action: 'go run .', risky: false });
      entries.push({ triggers: ['run tests'], type: 'command', action: 'go test ./...', risky: false });
    }
  }

  // Overview answer entry (always first)
  const stackParts = [];
  if (idx.frameworks && idx.frameworks.length) stackParts.push(`Stack: ${idx.frameworks.join(', ')}`);
  if (idx.languages && idx.languages.length) stackParts.push(`Languages: ${idx.languages.slice(0, 3).join(', ')}`);
  if (stackParts.length) {
    entries.unshift({
      triggers: ['overview', 'what is this project', 'tell me about this project', 'project info'],
      type: 'answer',
      response: stackParts.join('. ') + '. Configured by `npx local-project-console init`.',
    });
  }

  return entries;
}

export async function initConfig(targetDir) {
  const resolved = path.resolve(targetDir);

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      console.error(`\nError: "${resolved}" is not a directory.`);
      process.exit(1);
    }
  } catch {
    console.error(`\nError: directory "${resolved}" does not exist.`);
    process.exit(1);
  }

  const idx = await indexProject(resolved);
  if (!idx || idx.totalFiles === 0) {
    console.error(`\nError: Could not read "${resolved}" or the directory appears empty.`);
    process.exit(1);
  }

  let pkg = null;
  if (idx.keyFiles && idx.keyFiles['package.json']) {
    try {
      pkg = JSON.parse(idx.keyFiles['package.json'].replace(/\n\.\.\. \(truncated\)$/, ''));
    } catch {}
  }

  const name = path.basename(resolved);
  const entries = buildEntries(idx, pkg);

  const config = {
    projectName: name,
    entries,
  };

  const configPath = path.join(resolved, 'console.config.json');
  const json = JSON.stringify(config, null, INDENT) + '\n';
  await fs.writeFile(configPath, json, 'utf-8');

  const total = entries.length;
  const label = total === 1 ? 'entry' : 'entries';

  console.log(`\n\x1b[32m✓\x1b[0m Created console.config.json for "${name}"`);
  console.log(`  Location: ${configPath}`);
  console.log(`  ${total} ${label} generated (${entries.filter(e => e.type === 'command').length} commands, ${entries.filter(e => e.type === 'answer').length} answers)`);
  console.log(`\n\x1b[1mNext steps:\x1b[0m`);
  console.log(`  1. Review and edit console.config.json if needed`);
  console.log(`  2. Commit it to your repository so your team can use Project Console:`);
  console.log(`     git add console.config.json`);
  console.log(`     git commit -m "Add Project Console config for ${name}"`);
  console.log(`  3. Run the console:`);
  console.log(`     npx local-project-console\n`);
}
