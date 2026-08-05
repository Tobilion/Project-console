import crypto from 'crypto';
import { state, pendingConfirmations } from '../state.js';
import { appendMessage, getSession } from '../conversationStore.js';
import { executeCommand } from '../executor.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import { isCommandAllowed } from '../tools.js';
import { handleAIQuery } from './aiQuery.js';
import { guessCommand } from '../commandGuesser.js';
import { logNearMiss } from '../nearMissLogger.js';
import { handlePendingParamReply, handlePendingFollowUpReply, handlePendingDisambiguationReply, handlePendingMemorySuggestionReply } from './connectionInterceptors.js';
import { handleTelemetryCommand } from './connectionTelemetry.js';
import { handleDistillationCommand, handleMemoryReview, handleLearningCommand } from './connectionAdminCommands.js';
import { handleStopServer, handleDevUrl } from './connectionDevServer.js';
import { handleMatchingPipeline } from './connectionMatching.js';

/**
 * Trigger-mode message execution (routeMessage 'execute'). Orchestrator only — the blocks are
 * dispatched to sibling leaf modules in exactly the order they ran in the pre-split
 * handleExecute (head → param/followUp/disambiguation interceptors → typed-command bypass →
 * admin commands → dev-server checks → memory-suggestion reply → learning commands → AI
 * dispatch → direct command → matching pipeline). Each leaf returns true when it consumed
 * the message.
 */
export async function handleExecute(ws, parsed, sessionContext) {
  const { projectId, input, sessionId } = parsed.payload;
  sessionContext.activeProjectId = projectId;
  if (sessionId) sessionContext.currentSessionId = sessionId;

  const project = state.activeProjectsCache.find((p) => p.id === projectId);
  if (!project) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'Project not found. Scan directory again.\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }

  // Validate session is linked to this project (prevent cross-project context confusion)
  if (sessionId) {
    try {
      const session = await getSession(sessionId);
      if (session && session.projectId && session.projectId !== projectId) {
        ws.send(JSON.stringify({
          type: 'error_output',
          data: `Session is locked to "${session.projectName || session.projectId}" — switch to that project or create a new chat for this one.\n`,
          // Structured form of the same fact, so the web UI can offer a one-click "Switch to
          // that project" action instead of only showing the plain-text message above (which is
          // all a bare CLI client can render).
          switchProjectAction: { projectId: session.projectId, projectName: session.projectName || session.projectId },
        }));
        ws.send(JSON.stringify({ type: 'end' }));
        return;
      }
    } catch {}
  }

  if (sessionContext.currentSessionId) {
    appendMessage(sessionContext.currentSessionId, { role: 'user', content: input }).catch(() => {});
  }

  if (await handlePendingParamReply(ws, project, projectId, input, sessionContext)) return;
  if (await handlePendingFollowUpReply(ws, project, projectId, input, sessionContext)) return;
  if (await handlePendingDisambiguationReply(ws, project, projectId, input, sessionContext)) return;

  // Confirmed live 2026-08-03 (NetPulse transcript, reported directly): typing a literal,
  // already-correct command (e.g. "python main.py serve") did NOT run it — it went through the
  // normal intent-matching pipeline like any other chat message, and since it happened to name a
  // real file in the project, it lost to `project.context.file_relations` ("who uses main.py")
  // instead of executing. The ONLY way to actually run a suggested command was to click its
  // auto-generated suggestion chip, which takes a completely different path client-side
  // (`onDirectCommand` in Terminal.tsx, sent as an `execute_tool`/`executeCommand` WS message —
  // see `handleToolCall` below) that bypasses the matcher entirely. Typed input had no equivalent.
  // Fixed by giving typed input the same bypass: if the whole message is already a well-formed,
  // allowlisted command (`isCommandAllowed` — the same `ALLOWED_COMMANDS` check the chip path
  // uses) and isn't blocked by `isCommandBlocked`'s dangerous-pattern check, run it directly
  // instead of feeding it to the matcher at all. No new attack surface: this is the exact same
  // allowlist + blocklist gate `handleToolCall`'s `executeCommand` tool already enforces on every
  // chip click, just reachable from a typed message too. Deliberately does NOT try to be clever
  // about partial/fuzzy command text ("run python main.py serve please") — only an exact,
  // already-correct command line is auto-run; anything else still goes through the normal
  // pipeline so "run the site" etc. keep working as intents.
  const trimmedInput = input.trim();
  if (isCommandAllowed(trimmedInput) && !isCommandBlocked(trimmedInput)) {
    executeCommand(trimmedInput, project.path, ws, project.id);
    return;
  }

  const lowerInput = input.trim().toLowerCase();
  if (await handleTelemetryCommand(ws, project, lowerInput)) return;
  if (await handleDistillationCommand(ws, project, lowerInput)) return;
  if (await handleMemoryReview(ws, project, lowerInput)) return;
  if (await handleStopServer(ws, project, lowerInput)) return;
  if (await handleDevUrl(ws, project, lowerInput)) return;
  if (await handlePendingMemorySuggestionReply(ws, project, lowerInput)) return;
  if (await handleLearningCommand(ws, project, lowerInput)) return;

  // AI mode: the AI ON/OFF toggle is the only opt-in gesture needed — once on, every
  // message in this session goes straight to Ollama, no per-query re-confirmation.
  if (sessionContext.aiEnabled) {
    // Resolve workspace projects for AI context
    const workspaceProjects = sessionContext.workspaceProjectIds
      .map(id => state.activeProjectsCache.find(p => p.id === id))
      .filter(Boolean);
    await handleAIQuery(ws, project, input, sessionContext, workspaceProjects);
    return;
  }

  // Direct commands: if the input looks like a shell command, skip the matching pipeline
  // and go straight to the guesser. This prevents suggestion-chip commands like "npx serve ."
  // from being re-matched as run_project (because "serve" is semantically close to "server").
  const directCmdPattern = /^(npx\s+\S+(?:\s+\S+)*|python3?\s+\S+(?:\s+\S+)*|pip3?\s+\S+(?:\s+\S+)*|yarn\s+\S+(?:\s+\S+)*|pnpm\s+\S+(?:\s+\S+)*|npm\s+(run|start|install|build|serve|test|dev)(?:\s+\S+)*|node\s+\S+(?:\s+\S+)*|tsx\s+\S+)$/i;
  if (directCmdPattern.test(input)) {
    const guessed = guessCommand(input);
    if (guessed) {
      const nearMissId = logNearMiss(project.id, {
        input, resolvedCommand: guessed.command, description: guessed.description, source: 'guess',
      });
      const token = crypto.randomUUID();
      pendingConfirmations.set(token, {
        projectId: project.id, command: guessed.command, trigger: input,
        createdAt: Date.now(), nearMissId,
      });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${guessed.command}  (${guessed.description})`, trigger: 'direct_command' }));
      return;
    }
  }

  await handleMatchingPipeline(ws, project, projectId, input, sessionContext);
}
