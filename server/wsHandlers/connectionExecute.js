import crypto from 'crypto';
import { state, pendingConfirmations, resolveProject, getTabWorkspace } from '../state.js';
import { appendMessage, getSession } from '../conversationStore.js';
import { executeCommand } from '../executor.js';
import { isCommandBlocked } from '../dangerousPatterns.js';
import path from 'path';
import { extractCommandLine } from '../typedCommand.js';
import { getCommandDir } from '../commandDir.js';
import { handleAIQuery } from './aiQuery.js';
import { guessCommand } from '../commandGuesser.js';
import { logNearMiss } from '../nearMissLogger.js';
import { handlePendingParamReply, handlePendingFollowUpReply, handlePendingDisambiguationReply, handlePendingFileQuestionReply, handlePendingMemorySuggestionReply } from './connectionInterceptors.js';
import { handleTelemetryCommand } from './connectionTelemetry.js';
import { handleDistillationCommand, handleMemoryReview, handleLearningCommand } from './connectionAdminCommands.js';
import { handlePackCommand, handlePendingPackInstallReply } from './connectionPackAdmin.js';
import { handleWorkspaceCommand, handlePendingWorkspaceReply } from './connectionWorkspaceAdmin.js';
import { handleScheduleCommand } from './connectionScheduleAdmin.js';
import { handleNotifyCommand } from './connectionNotifyAdmin.js';
import { handleHealthCheck } from './connectionHealthCheck.js';
import { handleDoctorCommand } from './connectionDoctor.js';
import { handleMatchStatsCommand } from './connectionMatchStats.js';
import { handleAutoStartCommand } from './connectionAutoStartAdmin.js';
import { handleUpdateCommand } from './connectionUpdateAdmin.js';
import { handleHistoryCommand } from './connectionHistoryAdmin.js';
import { handleStopServer, handleDevUrl } from './connectionDevServer.js';
import { handleModeCommand } from './connectionModeAdmin.js';
import { handleOnboardingCommand } from './connectionOnboardingAdmin.js';
import { handleMatchingPipeline, explainInput } from './connectionMatching.js';
import { log as logger } from '../logger.js';

// Pure positive acknowledgments that never carry a request — short-circuited out of the AI
// path so a bare "ok" doesn't burn a local/cloud model call (see the aiEnabled branch below).
// Deliberately excludes "yes"/"no"/"sure"/"done" — those can be answers to a pending question.
const AI_ACK_RE = /^(ok|okay|k|kk|ok thanks|thanks|thank you|thx|ty|got it|gotcha|nice|cool|alright|sounds good|perfect|awesome)\b[.!]*$/i;

/**
 * Trigger-mode message execution (routeMessage 'execute'). Orchestrator only — the blocks are
 * dispatched to sibling leaf modules in exactly the order they ran in the pre-split
 * handleExecute (head → param/followUp/disambiguation interceptors → typed-command bypass →
 * admin commands → dev-server checks → memory-suggestion reply → learning commands → AI
 * dispatch → direct command → matching pipeline). Each leaf returns true when it consumed
 * the message.
 */
export async function handleExecute(ws, parsed, sessionContext) {
  // Two execute messages can't interleave while an AI turn is in flight: the second would
  // clobber the shared aiAbortController (so Cancel would target the wrong query) and
  // interleave a second token stream on the same socket, which the frontend's single-stream
  // bookkeeping cannot separate (audit 2026-08-06, Phase 2). Reject the new message instead
  // of serializing the whole socket — confirm_response/approve_task go through a separate WS
  // message type/handler entirely, so they stay concurrent and tool-confirm cards keep working
  // during a turn; this guard only ever re-enters via the 'execute' message type.
  //
  // `aiAbortController` alone isn't set synchronously with this check: handleAIQuery() (below,
  // via the AI-dispatch branch) only assigns it after awaiting checkOllama() and
  // buildAIQueryContext() — both real async work. Between this guard's check and that
  // assignment, handleExecuteBody also awaits several other things first (getSession, the
  // pending-reply interceptors, admin/dev-server command checks), each a genuine yield point.
  // A second 'execute' message sent before any of those resolve would see aiAbortController
  // still null, pass this guard, and start running the same interceptor chain concurrently —
  // both messages could reach handleAIQuery() before either sets aiAbortController, producing
  // exactly the interleaved-stream failure this guard exists to prevent (confirmed live audit
  // 2026-08-10). `executeInFlight` is set synchronously, before any await, so the second
  // message is rejected the instant it's evaluated instead of racing through the same window.
  if (sessionContext.aiAbortController || sessionContext.executeInFlight) {
    ws.send(JSON.stringify({ type: 'error_output', data: 'The AI is still working on your previous message — wait for it to finish (or press Cancel).\n' }));
    ws.send(JSON.stringify({ type: 'end' }));
    return;
  }
  sessionContext.executeInFlight = true;
  try {
    await handleExecuteBody(ws, parsed, sessionContext);
  } finally {
    sessionContext.executeInFlight = false;
  }
}

async function handleExecuteBody(ws, parsed, sessionContext) {
  const { projectId, input, sessionId, tabId } = parsed.payload || {};

  sessionContext.activeProjectId = projectId;
  // Phase T (2026-08-14): scope this connection's project resolution to the tab's workspace
  // cache (kept per-connection — a reconnect re-derives it from the first execute payload).
  if (tabId) sessionContext.tabId = tabId;
  if (sessionId) sessionContext.currentSessionId = sessionId;

  const project = resolveProject(projectId, sessionContext.tabId);
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
      // Phase T (2026-08-14): two tabs scanning different roots can contain same-named folders
      // (folder-name slug ids collide), so the slug check alone passes for the WRONG folder.
      // The session records its project's path at creation — compare paths too, so a chat
      // opened against root A's "matchday" can never run commands against root B's folder.
      if (session && session.projectPath && project.path && session.projectPath !== project.path) {
        ws.send(JSON.stringify({
          type: 'error_output',
          data: `This chat is tied to "${session.projectName || session.projectId}" at \`${session.projectPath}\`, but your current tab has "${project.name}" at \`${project.path}\` — same folder name, different location. Switch to that project or create a new chat for this one.\n`,
          switchProjectAction: { projectId: session.projectId, projectName: session.projectName || session.projectId },
        }));
        ws.send(JSON.stringify({ type: 'end' }));
        return;
      }
    } catch (err) {
      // The session is only an optimization here (lock/path guard) — a failed read must not
      // block the message, but it also must not vanish silently (audit 2026-08-17).
      logger.error(`getSession(${sessionId}) failed in handleExecute:`, err);
    }
  }

  if (sessionContext.currentSessionId) {
    // 2026-08-24: the append's message id rides the session context so the matching pipeline
    // can patch the matching transcript onto this exact record (see recordMatchInfo).
    // AWAITED, not fire-and-forget: with a warm embedding model matchInput can resolve in
    // under 50ms while the serialized append (index read + NDJSON append + atomic meta +
    // chat-log entry) takes longer — a fire-and-forget .then lost the race and the transcript
    // never patched (observed live).
    const appended = await appendMessage(sessionContext.currentSessionId, { role: 'user', content: input });
    sessionContext.lastUserMessageId = appended?.messages?.[0]?.id || null;
  }

  // Dry-run / explain (2026-08-24, differentiation item): additive `dryRun: true` on the
  // execute payload resolves what WOULD happen without executing anything — used by the CLI's
  // --dry-run / --explain flags. Never confirms, never runs, never persists the turn.
  if (parsed.payload?.dryRun) {
    await explainInput(ws, project, projectId, input, sessionContext);
    return;
  }

  if (await handlePendingParamReply(ws, project, projectId, input, sessionContext)) return;
  if (await handlePendingFollowUpReply(ws, project, projectId, input, sessionContext)) return;
  if (await handlePendingDisambiguationReply(ws, project, projectId, input, sessionContext)) return;
  if (await handlePendingFileQuestionReply(ws, project, projectId, input, sessionContext)) return;
  if (await handlePendingPackInstallReply(ws, project, input.trim().toLowerCase(), sessionContext)) return;
  if (await handlePendingWorkspaceReply(ws, project, input.trim().toLowerCase(), sessionContext)) return;

  // Confirmed live 2026-08-03 (NetPulse transcript, reported directly): typing a literal,
  // already-correct command (e.g. "python main.py serve") did NOT run it — it went through the
  // normal intent-matching pipeline like any other chat message, and since it happened to name a
  // real file in the project, it lost to `project.context.file_relations` ("who uses main.py")
  // instead of executing. The ONLY way to actually run a suggested command was to click its
  // auto-generated suggestion chip, which takes a completely different path client-side
  // (`onDirectCommand` in Terminal.tsx, sent as an `execute_tool`/`executeCommand` WS message —
  // see `handleToolCall` below) that bypasses the matcher entirely. Typed input had no equivalent.
  // Typed commands run directly instead of feeding the matcher (2026-08-03 fix: typing
  // "python main.py serve" went through the intent pipeline and lost to file_relations; the
  // chip path bypassed it entirely, so typed input got the same bypass). The gate here is
  // extractCommandLine (typedCommand.js): an exact well-formed command line runs immediately —
  // first token allowlisted OR PATH-resolved, so any real executable works, including ones the
  // matcher has no intent for ("ng serve" in a wrapper project). Natural prefixes ("run ng
  // serve", "command - git status") are accepted; single tokens still require the allowlist so
  // plain chat words never execute stray system binaries. Dangerous patterns are still blocked;
  // anything else goes through the normal pipeline so "run the site" keeps working as an intent.
  // Resolve the effective command directory (wrapper sub-package, e.g. SAM SYSTEM's
  // `sam_system/`, or project.path itself) BEFORE extracting the command line — a locally
  // installed CLI (node_modules/.bin/ng) lives inside that sub-package, not the wrapper root,
  // so resolveExecutableOnPath needs the right directory to find it (2026-08-11 follow-up fix).
  const sub = await getCommandDir(project);
  const effectiveRoot = sub ? path.join(project.path, sub) : project.path;
  const cmdLine = extractCommandLine(input, effectiveRoot);
  if (cmdLine && !isCommandBlocked(cmdLine)) {
    executeCommand(cmdLine, effectiveRoot, ws, project.id);
    return;
  }

  const lowerInput = input.trim().toLowerCase();
  if (await handleTelemetryCommand(ws, project, lowerInput)) return;
  if (await handleDistillationCommand(ws, project, lowerInput)) return;
  if (await handleMemoryReview(ws, project, lowerInput)) return;
  if (await handlePackCommand(ws, project, lowerInput, input, sessionContext)) return;
  if (await handleScheduleCommand(ws, project, lowerInput, input)) return;
  if (await handleNotifyCommand(ws, project, lowerInput, input)) return;
  if (await handleHealthCheck(ws, lowerInput)) return;
  if (await handleDoctorCommand(ws, lowerInput)) return;
  if (await handleMatchStatsCommand(ws, lowerInput)) return;
  if (await handleAutoStartCommand(ws, project, lowerInput)) return;
  if (await handleUpdateCommand(ws, project, lowerInput)) return;
  if (await handleWorkspaceCommand(ws, project, lowerInput, input, sessionContext)) return;
  if (await handleHistoryCommand(ws, project, lowerInput, input)) return;
  if (await handleStopServer(ws, project, lowerInput)) return;
  if (await handleDevUrl(ws, project, lowerInput)) return;
  if (await handleModeCommand(ws, project, lowerInput)) return;
  if (await handleOnboardingCommand(ws, lowerInput)) return;
  if (await handlePendingMemorySuggestionReply(ws, project, lowerInput)) return;
  if (await handleLearningCommand(ws, project, lowerInput)) return;

  // AI mode: the AI ON/OFF toggle is the only opt-in gesture needed — once on, every
  // message in this session goes straight to Ollama, no per-query re-confirmation.
  if (sessionContext.aiEnabled) {
    // Pure acknowledgments ("ok", "thanks", "got it") don't need a model round-trip — a real
    // NetPulse chat burned ~14 model streams on a bare "ok". Narrow allowlist + length cap so
    // nothing that could be an answer to a question ("yes", "no", "sure") ever short-circuits.
    const trimmed = input.trim();
    if (trimmed.length <= 20 && AI_ACK_RE.test(trimmed)) {
      ws.send(JSON.stringify({ type: 'answer', data: 'Got it — anything else?' }));
      if (sessionContext.currentSessionId) {
        appendMessage(sessionContext.currentSessionId, { role: 'bot', content: 'Got it — anything else?', isMarkdown: true }).catch(() => {});
      }
      return;
    }
    // Resolve workspace projects for AI context — Phase T: scoped to this tab's own cache
    // (a tab's workspace ids refer to ITS scan set; the global cache may hold another tab's).
    const tabCache = sessionContext.tabId ? getTabWorkspace(sessionContext.tabId)?.projectsCache : null;
    const workspaceProjects = sessionContext.workspaceProjectIds
      .map(id => (tabCache || state.activeProjectsCache).find(p => p.id === id))
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
        owner: ws, projectId: project.id, command: guessed.command, trigger: input,
        createdAt: Date.now(), nearMissId,
      });
      ws.send(JSON.stringify({ type: 'confirm_prompt', token, command: `${guessed.command}  (${guessed.description})`, trigger: 'direct_command' }));
      return;
    }
  }

  await handleMatchingPipeline(ws, project, projectId, input, sessionContext);
}
