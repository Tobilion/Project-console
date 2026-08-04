import { QUESTION_THRESHOLD, COMMAND_THRESHOLD, FILE_EDIT_THRESHOLD, adaptiveThreshold } from './memoryThresholds.js';
import { loadMemory, saveMemory } from './memoryStore.js';

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