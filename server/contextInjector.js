import natural from 'natural';

const { WordTokenizer, PorterStemmer } = natural;
const tokenizer = new WordTokenizer();

const KEYWORD_FILE_MAP = {
  route: ['route', 'router', 'express', 'api', 'endpoint', 'controller'],
  api: ['route', 'router', 'express', 'api', 'endpoint', 'controller'],
  database: ['db', 'database', 'schema', 'model', 'migration', 'prisma', 'sequelize'],
  db: ['db', 'database', 'schema', 'model', 'migration', 'prisma', 'sequelize'],
  test: ['test', 'spec', 'jest', 'mocha', 'cypress', 'vitest', '.test.', '.spec.'],
  config: ['config', '.env', 'env', 'setting', 'json', '.json'],
  style: ['css', 'style', 'scss', 'tailwind', 'theme', '.css'],
  component: ['component', 'react', 'vue', 'svelte', '.tsx', '.jsx'],
  docker: ['docker', 'Dockerfile', 'docker-compose'],
  deploy: ['deploy', 'ci', 'cd', '.github', 'action'],
};

export function injectContext(input, intent, codebaseIndex) {
  if (!codebaseIndex) return null;

  const inputLower = input.toLowerCase();
  const snippets = [];

  // Intent-based context enrichment
  switch (intent) {
    case 'project.knowledge.overview':
    case 'project.context.tech_preview': {
      snippets.push(
        `${codebaseIndex.totalFiles} files across ${codebaseIndex.totalDirs} directories.` +
        (codebaseIndex.entryPoints?.length ? ` Entry: ${codebaseIndex.entryPoints.join(', ')}.` : '')
      );
      break;
    }
    case 'project.context.structure': {
      if (codebaseIndex.directoryTree?.length) {
        const lines = codebaseIndex.directoryTree.slice(0, 12);
        snippets.push(`Top directories:\n${lines.map(d => `  ▸ ${d}`).join('\n')}`);
        if (codebaseIndex.directoryTree.length > 12) {
          snippets.push(`  ... and ${codebaseIndex.directoryTree.length - 12} more`);
        }
      }
      break;
    }
    case 'project.context.languages': {
      if (codebaseIndex.languages?.length) {
        snippets.push(codebaseIndex.languages.join(' · '));
      }
      break;
    }
    case 'project.context.file_count': {
      snippets.push(`${codebaseIndex.totalFiles} files, ${codebaseIndex.totalDirs} directories`);
      break;
    }
    case 'project.context.entry_point': {
      if (codebaseIndex.entryPoints?.length) {
        snippets.push(`Entry: ${codebaseIndex.entryPoints.join(', ')}`);
      }
      break;
    }
    case 'project.context.tests': {
      if (codebaseIndex.hasTests) {
        snippets.push('Project has test files detected');
        if (codebaseIndex.fileSample) {
          const testFiles = codebaseIndex.fileSample.filter(f =>
            f.includes('test') || f.includes('spec') || f.includes('.test.')
          );
          if (testFiles.length > 0) {
            snippets.push(`Test files found: ${testFiles.slice(0, 5).join(', ')}`);
          }
        }
      }
      break;
    }
    case 'project.context.dependencies': {
      if (codebaseIndex.keyFiles) {
        const depFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'Gemfile', 'go.mod'];
        for (const name of depFiles) {
          if (codebaseIndex.keyFiles[name]) {
            snippets.push(`--- ${name} ---\n${codebaseIndex.keyFiles[name]}`);
            break;
          }
        }
      }
      break;
    }
    case 'project.context.config': {
      if (codebaseIndex.keyFiles) {
        const configFiles = Object.keys(codebaseIndex.keyFiles).filter(
          name => name.includes('.env') || name.includes('config') || name.endsWith('.json')
        );
        for (const name of configFiles.slice(0, 3)) {
          snippets.push(`--- ${name} ---\n${codebaseIndex.keyFiles[name]}`);
        }
      }
      break;
    }
    case 'project.explain':
    case 'project.explain_more':
    case 'project.knowledge.architecture': {
      // Inject key files that match user keywords
      const stemmedInput = (tokenizer.tokenize(inputLower) || []).map(t => PorterStemmer.stem(t));
      if (codebaseIndex.fileSample) {
        const matchedFiles = codebaseIndex.fileSample.filter(f => {
          const stemmedFile = PorterStemmer.stem(f);
          return stemmedInput.some(s => stemmedFile.includes(s));
        });
        if (matchedFiles.length > 0) {
          snippets.push(`Matching files: ${matchedFiles.slice(0, 8).join(', ')}`);
        }
        // Always show file sample if no keyword match
        if (matchedFiles.length === 0 && codebaseIndex.fileSample.length > 0) {
          snippets.push(`Key files: ${codebaseIndex.fileSample.slice(0, 10).join(', ')}`);
        }
      }
      break;
    }
    // Deliberately no 'run_project' case here: this app already learned (and documented in
    // CLAUDE.md) that a naive "start <entrypoint>" suggestion is actively wrong for compiled
    // languages (e.g. "start main.go" just opens the file in an editor) — run_project's own
    // handler in builtinIntents.js does real marker-based detection (go.mod/Cargo.toml/pom.xml/
    // etc.) instead. A prior version of this switch had a run_project case that reintroduced the
    // naive pattern; it was never actually wired up (nothing calls injectContext with
    // action === 'run_project') but was removed outright rather than left as a landmine for
    // whoever wires it up next without noticing the earlier fix.
  }

  // Keyword-triggered file injection (independent of intent)
  for (const [keyword, patterns] of Object.entries(KEYWORD_FILE_MAP)) {
    if (inputLower.includes(keyword) && codebaseIndex.fileSample) {
      for (const file of codebaseIndex.fileSample) {
        const fileLower = file.toLowerCase();
        if (patterns.some(p => fileLower.includes(p))) {
          const fileName = file.split('/').pop() || file;
          snippets.push(`▸ ${fileName}`);
          break;
        }
      }
    }
  }

  if (snippets.length === 0) return null;

  return snippets.join('\n');
}
