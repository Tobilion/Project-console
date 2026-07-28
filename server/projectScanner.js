import fs from 'fs/promises';
import path from 'path';
import { indexProject } from './codebaseIndexer.js';
import { deriveScriptEntriesForProject, mergeAutoEntries } from './scriptEntries.js';

// Files treated as project-context documentation, in priority order (index 0 wins ties for
// which doc is treated as "the" doc in builtinIntents.js's overview/deep-dive responses).
// Tobi's own convention (see insightflow on GitHub) is CLAUDE.md as source of truth, with
// README.md, ABOUT-TOBI.md, and UNIVERSAL_CONTEXT.md as supporting context — widened from the
// original CLAUDE.md/README.md-only list so those get ingested too instead of silently ignored.
const CONTEXT_FILENAMES = ['claude.md', 'readme.md', 'about-tobi.md', 'universal_context.md'];

function contextPriority(filename) {
  const idx = CONTEXT_FILENAMES.indexOf(filename.toLowerCase());
  return idx === -1 ? CONTEXT_FILENAMES.length : idx;
}

/**
 * Scans baseDir for subdirectories containing console.config.json or CLAUDE.md/README.md
 */
export async function discoverProjects(baseDir) {
  if (!baseDir || typeof baseDir !== 'string') return [];
  
  try {
    const stats = await fs.stat(baseDir);
    if (!stats.isDirectory()) return [];

    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projectPath = path.join(baseDir, entry.name);
        
        let config = null;
        try {
          const configPath = path.join(projectPath, 'console.config.json');
          const configStats = await fs.stat(configPath);
          if (configStats.isFile()) {
            const configData = await fs.readFile(configPath, 'utf-8');
            config = JSON.parse(configData);
          }
        } catch (err) {}

        let contextFiles = [];
        let parsedKnowledge = { stack: '', commands: '', gotchas: '', architecture: '' };
        
        try {
          const filesInDir = await fs.readdir(projectPath);
          for (const file of filesInDir) {
            if (CONTEXT_FILENAMES.includes(file.toLowerCase())) {
              const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
              contextFiles.push({ filename: file, content });
              
              // Simple markdown parsing based on headers
              const lines = content.split('\n');
              let currentSection = 'architecture'; // default
              for (const line of lines) {
                const lower = line.toLowerCase();
                if (lower.startsWith('## stack') || lower.startsWith('### stack')) {
                  currentSection = 'stack';
                } else if (lower.startsWith('## commands') || lower.startsWith('### commands') || lower.startsWith('## run')) {
                  currentSection = 'commands';
                } else if (lower.startsWith('## gotchas') || lower.startsWith('### gotchas') || lower.startsWith('## known issues')) {
                  currentSection = 'gotchas';
                } else if (lower.startsWith('## architecture') || lower.startsWith('### architecture')) {
                  currentSection = 'architecture';
                } else if (lower.startsWith('## ')) {
                   currentSection = 'architecture';
                } else {
                  if (parsedKnowledge[currentSection] !== undefined) {
                    parsedKnowledge[currentSection] += line + '\n';
                  }
                }
              }
            }
          }
        } catch (err) {}

        // CLAUDE.md wins as the "main doc" (see builtinIntents.js project.knowledge.overview /
        // explain_followup) regardless of alphabetical readdir order.
        contextFiles.sort((a, b) => contextPriority(a.filename) - contextPriority(b.filename));

        // Combine inferred config
        if (!config && contextFiles.length > 0) {
           config = { projectName: entry.name, entries: [] };
           
           // Automatically extract commands from 'commands' section
           const commandLines = parsedKnowledge.commands.match(/```[a-z]*\n([\s\S]*?)```/g) || [];
           commandLines.forEach(block => {
             const lines = block.replace(/```[a-z]*\n/, '').replace(/```/, '').split('\n').filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
             lines.forEach(cmd => {
                config.entries.push({
                   triggers: ["run " + cmd.split(' ')[0], "execute " + cmd.split(' ')[0]],
                   type: "command",
                   action: cmd.trim()
                });
             });
           });
        }

        // Fill in any standard npm scripts (dev/build/lint/test/...) the config doesn't
        // already cover, so the dispatcher's commands can't drift from what package.json
        // actually runs. Hand-authored console.config.json entries always take priority —
        // this only adds entries whose exact action isn't already present. A project with
        // only a package.json and no docs/config still gets discovered because of this.
        const autoEntries = await deriveScriptEntriesForProject(projectPath);
        if (autoEntries.length) {
          if (!config) config = { projectName: entry.name, entries: [] };
          mergeAutoEntries(config, autoEntries);
        }

        if (config || contextFiles.length > 0) {
          const codebaseIndex = await indexProject(projectPath);
          projects.push({
            id: entry.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            folderName: entry.name,
            name: config?.projectName || entry.name,
            path: projectPath,
            config: config || { projectName: entry.name, entries: [] },
            contextFiles: contextFiles,
            parsedKnowledge,
            codebaseIndex
          });
        }
      }
    }

    return projects;
  } catch (err) {
    console.error(`Failed to scan directory at "${baseDir}":`, err.message);
    return [];
  }
}

/**
 * Scans a single project folder for its config and context files.
 * Returns a project object or null if no valid config/docs found.
 */
export async function scanSingleProject(folderName, projectPath) {
  let config = null;
  try {
    const configPath = path.join(projectPath, 'console.config.json');
    const configStats = await fs.stat(configPath);
    if (configStats.isFile()) {
      const configData = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(configData);
    }
  } catch (err) {}

  let contextFiles = [];
  let parsedKnowledge = { stack: '', commands: '', gotchas: '', architecture: '' };

  try {
    const filesInDir = await fs.readdir(projectPath);
    for (const file of filesInDir) {
      if (CONTEXT_FILENAMES.includes(file.toLowerCase())) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        contextFiles.push({ filename: file, content });

        const lines = content.split('\n');
        let currentSection = 'architecture';
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (lower.startsWith('## stack') || lower.startsWith('### stack')) {
            currentSection = 'stack';
          } else if (lower.startsWith('## commands') || lower.startsWith('### commands') || lower.startsWith('## run')) {
            currentSection = 'commands';
          } else if (lower.startsWith('## gotchas') || lower.startsWith('### gotchas') || lower.startsWith('## known issues')) {
            currentSection = 'gotchas';
          } else if (lower.startsWith('## architecture') || lower.startsWith('### architecture')) {
            currentSection = 'architecture';
          } else if (lower.startsWith('## ')) {
            currentSection = 'architecture';
          } else {
            if (parsedKnowledge[currentSection] !== undefined) {
              parsedKnowledge[currentSection] += line + '\n';
            }
          }
        }
      }
    }
  } catch (err) {}

  contextFiles.sort((a, b) => contextPriority(a.filename) - contextPriority(b.filename));

  if (!config && contextFiles.length > 0) {
    config = { projectName: folderName, entries: [] };
    const commandLines = parsedKnowledge.commands.match(/```[a-z]*\n([\s\S]*?)```/g) || [];
    commandLines.forEach(block => {
      const lines = block.replace(/```[a-z]*\n/, '').replace(/```/, '').split('\n').filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
      lines.forEach(cmd => {
        config.entries.push({
          triggers: ["run " + cmd.split(' ')[0], "execute " + cmd.split(' ')[0]],
          type: "command",
          action: cmd.trim()
        });
      });
    });
  }

  const autoEntries = await deriveScriptEntriesForProject(projectPath);
  if (autoEntries.length) {
    if (!config) config = { projectName: folderName, entries: [] };
    mergeAutoEntries(config, autoEntries);
  }

  if (config || contextFiles.length > 0) {
    const codebaseIndex = await indexProject(projectPath);
    return {
      id: folderName.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      folderName,
      name: config?.projectName || folderName,
      path: projectPath,
      config: config || { projectName: folderName, entries: [] },
      contextFiles,
      parsedKnowledge,
      codebaseIndex
    };
  }
  return null;
}
