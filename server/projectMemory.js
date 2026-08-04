import fs from 'fs';
import path from 'path';
import { QUESTION_THRESHOLD, COMMAND_THRESHOLD, FILE_EDIT_THRESHOLD, adaptiveThreshold } from './memoryThresholds.js';

const MEMORY_FILENAME = 'project-memory.json';

function memoryPath(projectPath) {
  return path.join(projectPath, '.console', MEMORY_FILENAME);
}

function loadMemory(projectPath) {
  const fp = memoryPath(projectPath);
  try {
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
  } catch {}
  return createDefaultMemory();
}

function createDefaultMemory() {
  return {
    commands: {},
    editedFiles: {},
    repeatedQuestions: {},
    candidateAdditions: [],
    lastUpdated: Date.now(),
  };
}

function saveMemory(projectPath, memory) {
  const dir = path.join(projectPath, '.console');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  memory.lastUpdated = Date.now();
  fs.writeFileSync(memoryPath(projectPath), JSON.stringify(memory, null, 2));
}

// Batched async write queue — coalesces rapid trackCommand/trackFileEdit/trackQuestion
// calls (which often happen in quick succession during AI tool-call loops) into a single
// disk write, then flushes after a 200ms quiet period.
const memoryWriteQueue = new Map();
let memoryFlushTimer = null;

function queueMemoryWrite(projectPath, mutator) {
  if (!memoryWriteQueue.has(projectPath)) {
    memoryWriteQueue.set(projectPath, loadMemory(projectPath));
  }
  const mem = memoryWriteQueue.get(projectPath);
  mutator(mem);
  mem.lastUpdated = Date.now();
  if (!memoryFlushTimer) {
    memoryFlushTimer = setTimeout(() => {
      memoryFlushTimer = null;
      for (const [p, m] of memoryWriteQueue) {
        memoryWriteQueue.delete(p);
        saveMemory(p, m);
      }
    }, 200);
  }
}

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

export function checkThresholds(projectPath, memory) {
  const mem = memory || loadMemory(projectPath);

  const totalQuestions = Object.values(mem.repeatedQuestions).reduce((s, q) => s + q.count, 0);
  const questionFloor = adaptiveThreshold(QUESTION_THRESHOLD, totalQuestions);
  for (const [topic, q] of Object.entries(mem.repeatedQuestions)) {
    if (q.count >= questionFloor && !q.suggested) {
      q.suggested = true;
      saveMemory(projectPath, mem);
      return {
        type: 'question_repeat',
        topic,
        message: `I notice you've asked about "${topic}" ${q.count} times now. Would you like me to add a section about it to your CLAUDE.md so I remember it?`,
        count: q.count,
      };
    }
  }

  const sortedCmds = Object.entries(mem.commands).sort((a, b) => b[1] - a[1]);
  const totalCommands = sortedCmds.reduce((s, [, c]) => s + c, 0);
  const commandFloor = adaptiveThreshold(COMMAND_THRESHOLD, totalCommands);
  const cmdsAboveThreshold = sortedCmds.filter(([, c]) => c >= commandFloor);
  if (cmdsAboveThreshold.length > 0) {
    const top = cmdsAboveThreshold[0];
    if (!mem._suggestedCommands) mem._suggestedCommands = {};
    if (!mem._suggestedCommands[top[0]]) {
      mem._suggestedCommands[top[0]] = true;
      saveMemory(projectPath, mem);
      return {
        type: 'command_frequency',
        topic: `Command: ${top[0]}`,
        message: `You've run \`${top[0]}\` ${top[1]} times. Would you like me to make it a quick trigger?`,
        command: top[0],
        count: top[1],
      };
    }
  }

  const sortedFiles = Object.entries(mem.editedFiles).sort((a, b) => b[1] - a[1]);
  const totalEdits = sortedFiles.reduce((s, [, c]) => s + c, 0);
  const fileFloor = adaptiveThreshold(FILE_EDIT_THRESHOLD, totalEdits);
  const filesAboveThreshold = sortedFiles.filter(([, c]) => c >= fileFloor);
  if (filesAboveThreshold.length > 0) {
    const top = filesAboveThreshold[0];
    if (!mem._suggestedFiles) mem._suggestedFiles = {};
    if (!mem._suggestedFiles[top[0]]) {
      mem._suggestedFiles[top[0]] = true;
      saveMemory(projectPath, mem);
      return {
        type: 'file_edit_frequency',
        topic: `File: ${top[0]}`,
        message: `You've edited \`${top[0]}\` ${top[1]} times. Would you like me to add a note about it to your CLAUDE.md?`,
        filePath: top[0],
        count: top[1],
      };
    }
  }

  const pendingAdditions = mem.candidateAdditions.filter(a => !a.added && !a._offered);
  if (pendingAdditions.length > 0) {
    const best = pendingAdditions.sort((a, b) => {
      const rank = { high: 3, medium: 2, low: 1 };
      return (rank[b.confidence] || 0) - (rank[a.confidence] || 0);
    })[0];
    best._offered = true;
    saveMemory(projectPath, mem);
    return {
      type: 'candidate_addition',
      topic: best.topic,
      message: `I've learned a good explanation about "${best.topic}". Shall I add it to your CLAUDE.md?`,
      content: best.content,
    };
  }

  return null;
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
