import { injectContext } from '../contextInjector.js';

/**
 * Cached-index read handlers (Phase 14 split of builtinProjectContext.js, 2026-08-05 — bodies
 * moved verbatim). All read project.codebaseIndex only — no fresh scans, no side effects.
 */
export const contextIndexHandlers = {
  'project.context.structure'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No indexed structure available for **[${project.name}]**. Run a re-index first.` }));
    } else {
      let msg = `### Directory Structure [${project.name}]\n\n**${idx.totalDirs} directories, ${idx.totalFiles} files**\n`;
      if (idx.directoryTree.length) {
        msg += '\n```\n' + idx.directoryTree.join('\n') + '\n```';
      }
      if (idx.fileSample.length) {
        msg += `\n\n**Sample files (${idx.fileSample.length} shown):**\n` + idx.fileSample.map((f) => `- ${f}`).join('\n');
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  },

  'project.context.languages'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx?.languages?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No language data indexed for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Languages in [${project.name}]\n\n${idx.languages.map((l) => `- ${l}`).join('\n')}` }));
    }
  },

  'project.context.file_count'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx) {
      ws.send(JSON.stringify({ type: 'answer', data: `No index data for **[${project.name}]**.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Project Size [${project.name}]\n\n- **Total files:** ${idx.totalFiles}\n- **Total directories:** ${idx.totalDirs}\n- **Languages:** ${(idx.languages || []).slice(0, 5).join(', ') || 'N/A'}` }));
    }
  },

  'project.context.entry_point'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx?.entryPoints?.length) {
      ws.send(JSON.stringify({ type: 'answer', data: `No entry point detected for **[${project.name}]**. Try "show me the project structure" to explore.` }));
    } else {
      ws.send(JSON.stringify({ type: 'answer', data: `### Entry Points [${project.name}]\n\n${idx.entryPoints.map((e) => `- \`${e}\``).join('\n')}` }));
    }
  },

  'project.context.tech_preview'(ws, action, input, project) {
    const idx = project.codebaseIndex;
    let msg = `### Tech Preview [${project.name}]\n\n`;
    if (idx) {
      msg += `**${idx.totalFiles} files** across **${idx.totalDirs} directories**.\n\n`;
      if (idx.languages?.length) msg += `**Languages:** ${idx.languages.slice(0, 4).join(', ')}\n`;
      if (idx.entryPoints?.length) msg += `**Entry points:** ${idx.entryPoints.join(', ')}\n`;
      if (idx.hasTests) msg += '**Has tests**\n';
      if (idx.hasCli) msg += '**Has CLI**\n';
      if (idx.hasConfig) msg += '**Has config**\n';
      if (idx.directoryTree?.length) {
        msg += `\n**Top-level dirs:** ${idx.directoryTree.filter((d) => !d.includes('\\')).join(', ')}\n`;
      }
    } else {
      msg += 'No codebase index available. Use a tool to scan the project first.';
    }
    const ctxTp = injectContext(input, action, project.codebaseIndex);
    if (ctxTp) msg += `\n\n${ctxTp}`;
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
  },

  'project.context.tests'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx || !idx.hasTests) {
      ws.send(JSON.stringify({ type: 'answer', data: `No tests detected for **[${project.name}]**.` }));
    } else {
      let msg = `### Tests [${project.name}]\n\n✅ Test files detected.\n`;
      if (idx.fileSample) {
        const testFiles = idx.fileSample.filter((f) =>
          f.includes('test') || f.includes('spec') || f.includes('.test.')
        );
        if (testFiles.length > 0) {
          msg += `\n**Test files found:**\n${testFiles.map((f) => `- \`${f}\``).join('\n')}`;
        }
      }
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  },

  'project.context.dependencies'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx?.keyFiles) {
      ws.send(JSON.stringify({ type: 'answer', data: `No dependency information for **[${project.name}]**.` }));
    } else {
      const depFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'Gemfile', 'go.mod'];
      let found = false;
      let msg = `### Dependencies [${project.name}]\n\n`;
      for (const name of depFiles) {
        if (idx.keyFiles[name]) {
          msg += `**${name}**\n\`\`\`\n${idx.keyFiles[name]}\n\`\`\`\n`;
          found = true;
        }
      }
      if (!found) msg += 'No standard dependency files detected.';
      ws.send(JSON.stringify({ type: 'answer', data: msg }));
    }
  },

  'project.context.config'(ws, _action, _input, project) {
    const idx = project.codebaseIndex;
    if (!idx?.keyFiles) {
      ws.send(JSON.stringify({ type: 'answer', data: `No config information for **[${project.name}]**.` }));
    } else {
      const configFiles = Object.keys(idx.keyFiles).filter(
        (name) => name.includes('.env') || name.includes('config') || name.endsWith('.json')
      );
      if (configFiles.length === 0) {
        ws.send(JSON.stringify({ type: 'answer', data: `No config files detected for **[${project.name}]**.` }));
      } else {
        let msg = `### Configuration [${project.name}]\n\n`;
        for (const name of configFiles.slice(0, 3)) {
          msg += `**${name}**\n\`\`\`\n${idx.keyFiles[name]}\n\`\`\`\n`;
        }
        ws.send(JSON.stringify({ type: 'answer', data: msg }));
      }
    }
  },
};
