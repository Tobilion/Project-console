import { buildSystemPrompt } from '../ollamaContext.js';
import { injectContext } from '../contextInjector.js';
import { getSession } from '../conversationStore.js';
import { createProjectTools } from '../tools.js';

/**
 * Builds the initial message array + tool sets for one AI-mode query (Phase 14 split of
 * aiQuery.js, 2026-08-05 — bodies moved verbatim). Returns everything the orchestrator's
 * loop needs that doesn't mutate: the messages (system prompt + last 10 session messages +
 * enriched user input), the cleaned input (reason-mode prefix stripped), the model name, and
 * per-project tool sets for the whole workspace.
 */
export async function buildAIQueryContext(project, input, sessionContext, workspaceProjects = []) {
  const systemPrompt = await buildSystemPrompt(project, sessionContext.aiMode || 'default', workspaceProjects);
  const messages = [{ role: 'system', content: systemPrompt }];

  if (sessionContext.currentSessionId) {
    try {
      const session = await getSession(sessionContext.currentSessionId);
      if (session?.messages) {
        const history = session.messages.slice(-10);
        for (const msg of history) {
          const role = msg.role === 'bot' ? 'assistant' : msg.role === 'user' ? 'user' : null;
          if (role) messages.push({ role, content: msg.content });
        }
      }
    } catch {}
  }

  // Handle reason mode: strip prefix and add reasoning instruction
  let reasoningMode = false;
  let cleanInput = input;
  if (input.startsWith('[REASON] ')) {
    reasoningMode = true;
    cleanInput = input.slice(9);
  }
  const ctxAi = injectContext(cleanInput, null, project?.codebaseIndex);
  let enrichedInput = ctxAi ? `${cleanInput}\n\nRelevant project context:\n${ctxAi}` : cleanInput;
  if (reasoningMode) {
    enrichedInput = `[Think step by step and provide a thorough, reasoned answer]\n${enrichedInput}`;
  }
  messages.push({ role: 'user', content: enrichedInput });

  const model = sessionContext.aiModel || 'qwen2.5-coder:7b';
  const tools = await createProjectTools(project);
  // Create tools for all workspace projects so the AI can operate on any of them
  const workspaceTools = {};
  workspaceTools[project.id] = tools;
  for (const wp of workspaceProjects) {
    if (wp.id !== project.id) {
      try { workspaceTools[wp.id] = await createProjectTools(wp); } catch {}
    }
  }

  return { messages, cleanInput, reasoningMode, model, tools, workspaceTools };
}
