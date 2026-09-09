import fs from 'fs';
import path from 'path';
import { walkDir, isTextFile } from '../../toolScan.js';
import { answer } from '../../wsReply.js';
import { MAX_RESULTS, MAX_CONTENT_FILE_BYTES } from './constants.js';

/**
 * Extracts the search query from "find files matching X" / "search my files for X" /
 * "search for X in my files" / "find files with the word X" shapes. Returns
 * { type: 'content'|'name', query } or null — the handler asks instead of guessing when
 * nothing extracts (same conservative-parse policy as parseFileNameOnly).
 */
export function extractFindQuery(input) {
  const contentShapes = [
    /\b(?:containing|matching|mentioning|with the (?:word|text|content))\s+(.+?)(?:\s+in\s+(?:my|the|these|all)\s+(?:files|documents|folder|project)|$)/i,
    /\bfor\s+(.+?)\s+in\s+(?:my|the|these|all)\s+(?:files|documents|folder|project)\b/i,
    /\bsearch\s+(?:my|all|the)\s+(?:files|documents|folder)\s+for\s+(.+?)\s*$/i,
    /\b(?:about|on)\s+(.+?)\s*$/i,
  ];
  for (const re of contentShapes) {
    const m = input.match(re);
    if (m && m[1] && m[1].trim()) return { type: 'content', query: m[1].trim().replace(/[.?!]+$/, '') };
  }
  const nameShape = input.match(/\b(?:named\s+like|matching)\s+(.+?)\s*$/i);
  if (nameShape && nameShape[1].trim()) return { type: 'name', query: nameShape[1].trim() };
  return null;
}

/** Absolute paths of the project's files, reusing the tool layer's ignore-dirs walk. */
async function projectFiles(root) {
  return walkDir(root);
}

/** Case-insensitive plain-substring content scan; no regex, zero ReDoS surface. */
async function searchContents(root, files, needle) {
  const hits = [];
  for (const file of files) {
    if (hits.length >= MAX_RESULTS) break;
    if (!isTextFile(file)) continue;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (size > MAX_CONTENT_FILE_BYTES) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_RESULTS; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path: path.relative(root, file).replace(/\\/g, '/'), line: i + 1, text: lines[i].trim().substring(0, 120) });
      }
    }
  }
  return hits;
}

export async function handleFind(ws, action, input, project, sessionContext) {
  const parsed = extractFindQuery(input);
  if (!parsed) {
    answer(ws, `I can search by **file name** or **content** — try \`find files matching report\`, \`search my files for budget\`, or \`search for rent in my files\`.`);
    return true;
  }
  const files = await projectFiles(project.path);
  const needle = parsed.query.toLowerCase();

  if (parsed.type === 'name') {
    const matches = files
      .map((f) => path.relative(project.path, f).replace(/\\/g, '/'))
      .filter((rel) => rel.toLowerCase().includes(needle) || path.basename(rel).toLowerCase().includes(needle))
      .slice(0, MAX_RESULTS);
    answer(ws, matches.length
      ? `Found ${matches.length === MAX_RESULTS ? 'at least ' + MAX_RESULTS : matches.length} file${matches.length === 1 ? '' : 's'} matching **${parsed.query}**:\n\n${matches.map((m) => `- \`${m}\``).join('\n')}`
      : `No files matching **${parsed.query}** in **[${project.name}]**.`);
    return true;
  }

  const hits = await searchContents(project.path, files, needle);
  if (hits.length === 0) {
    answer(ws, `No file contents match **${parsed.query}** in **[${project.name}]**.`);
    return true;
  }
  const lines = hits.map((h) => `- \`${h.path}:${h.line}\` — ${h.text}`);
  const more = hits.length === MAX_RESULTS ? '\n\n*More results are capped at ' + MAX_RESULTS + ' — narrow the search to see the rest.*' : '';
  answer(ws, `${hits.length === 1 ? '1 file contains' : hits.length + ' files contain'} **${parsed.query}**:\n\n${lines.join('\n')}${more}`);
  return true;
}