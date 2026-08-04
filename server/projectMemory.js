import fs from 'fs';
import path from 'path';
import { queueMemoryWrite, loadMemory } from './memoryStore.js';
import { checkThresholds } from './memoryThresholdChecks.js';
import { QUESTION_THRESHOLD } from './memoryThresholds.js';

export function trackCommand(projectPath, command) {
  let suggestion = null;
  queueMemoryWrite(projectPath, (mem) => {
    if (!mem.commands[command]) mem.commands[command] = 0;
    mem.commands[command]++;
    suggestion = checkThresholds(projectPath, mem);
  });
  return suggestion;
}

export function trackFileEdit(projectPath, filePath) {
  const key = filePath.replace(/\\/g, '/');
  let suggestion = null;
  queueMemoryWrite(projectPath, (mem) => {
    if (!mem.editedFiles[key]) mem.editedFiles[key] = 0;
    mem.editedFiles[key]++;
    suggestion = checkThresholds(projectPath, mem);
  });
  return suggestion;
}

export function trackQuestion(projectPath, input, topic) {
  const key = topic || input.toLowerCase().trim().slice(0, 80);
  let suggestion = null;
  queueMemoryWrite(projectPath, (mem) => {
    if (!mem.repeatedQuestions[key]) {
      mem.repeatedQuestions[key] = { count: 0, suggested: false, lastInput: input };
    }
    mem.repeatedQuestions[key].count++;
    mem.repeatedQuestions[key].lastInput = input;
    suggestion = checkThresholds(projectPath, mem);
  });
  return suggestion;
}

export function addCandidateAddition(projectPath, topic, content, confidence) {
  queueMemoryWrite(projectPath, (mem) => {
    mem.candidateAdditions.push({
      topic,
      content: content.length > 2000 ? content.slice(0, 2000) : content,
      confidence,
      added: false,
      createdAt: Date.now(),
    });
  });
}

export function addToClaudeMd(projectPath, topic, content) {
  const claudePath = path.join(projectPath, 'CLAUDE.md');
  let existing = '';
  try {
    if (fs.existsSync(claudePath)) {
      existing = fs.readFileSync(claudePath, 'utf-8');
    }
  } catch {}

  const section = `\n\n## ${topic}\n\n${content.trim()}\n`;
  fs.writeFileSync(claudePath, existing + section);
  return true;
}

export function getTopCommands(projectPath, limit = 10) {
  const mem = loadMemory(projectPath);
  return Object.entries(mem.commands)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cmd, count]) => ({ command: cmd, count }));
}

export function getTopEditedFiles(projectPath, limit = 10) {
  const mem = loadMemory(projectPath);
  return Object.entries(mem.editedFiles)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([fp, count]) => ({ file: fp, count }));
}

export function getMemorySummary(projectPath) {
  const mem = loadMemory(projectPath);
  const topCmds = Object.entries(mem.commands).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topFiles = Object.entries(mem.editedFiles).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const questions = Object.entries(mem.repeatedQuestions)
    .filter(([, q]) => q.count >= QUESTION_THRESHOLD)
    .sort((a, b) => b[1].count - a[1].count);
  return {
    topCommands: topCmds.map(([c, n]) => ({ command: c, count: n })),
    topEditedFiles: topFiles.map(([f, n]) => ({ file: f, count: n })),
    repeatedQuestions: questions.map(([t, q]) => ({ topic: t, count: q.count, suggested: q.suggested })),
    candidateAdditions: mem.candidateAdditions.filter(a => !a.added).length,
    lastUpdated: mem.lastUpdated,
  };
}