import { useEffect, useRef, useCallback, useState } from 'react';
import { TerminalMessage, ToolCallEntry, Project } from '../types';
import { useProjects } from './useProjects';
import { useSessions } from './useSessions';
import { useWebSocket } from './useWebSocket';
import { useAI } from './useAI';
import { useTerminal } from './useTerminal';
import { useSearch } from './useSearch';

export function useConsole() {
  const projects = useProjects();
  const sessions = useSessions();
  // Wire up wsRef from useWebSocket first so terminal shares the real socket ref —
  // previously useTerminal got a brand-new, never-populated ref, so handleConfirm/
  // handleToolConfirm's `!wsRef.current` check was always true and every Approve/
  // Reject/Cancel/Execute click silently no-op'd.
  const wsHandler = useWebSocket((payload) => handleWebSocketMessage(payload));
  const terminal = useTerminal(
    wsHandler.wsRef,
    projects.activeProject,
    sessions.activeSessionId,
    sessions.setMessages,
  );

  const [toolHistory, setToolHistory] = useState<ToolCallEntry[]>([]);
  const [showToolHistory, setShowToolHistory] = useState(false);
  const [workspaceProjects, setWorkspaceProjects] = useState<Project[]>([]);
  // Trigger-mode's equivalent of `aiThinking` — requested directly after a live test where a
  // slow-starting dev server command ("run the site") gave no visual sign the console was still
  // working, so there was no way to tell "still running" from "silently done". `aiThinking` only
  // ever gets set true by AI mode's own 'ai_start' event, so trigger-mode round trips (which are
  // most of what runs with AI off) had no busy indicator at all. Deliberately a separate state
  // rather than reusing aiThinking — this needs different semantics (stays true across
  // intermediate 'start'/'output' chunks, since a still-booting dev server keeps streaming text
  // without being "done"; only clears on a real end-of-turn signal) and different display text.
  const [commandPending, setCommandPending] = useState(false);
  const [activeServers, setActiveServers] = useState<Array<{projectId: string; command: string; pid: number | null; url: string | null}>>([]);
  const [dashboardUpdateSignal, setDashboardUpdateSignal] = useState(0);

  const fetchActiveServers = useCallback(async () => {
    try {
      const res = await fetch('/api/active-servers');
      if (res.ok) setActiveServers(await res.json());
    } catch {}
  }, []);

  const addToolCall = useCallback((tool: string, args: Record<string, any>, result: any) => {
    const isGated = ['writeFile', 'editFile', 'insertAtLine'].includes(tool) ||
      (tool === 'executeCommand' && args?.risky);
    setToolHistory(prev => [{
      id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
      tool, args, result,
      timestamp: Date.now(),
      gated: isGated,
    }, ...prev].slice(0, 100));
  }, []);

  const rerunToolCall = useCallback((entry: ToolCallEntry) => {
    if (!wsHandler.wsRef.current || wsHandler.wsRef.current.readyState !== WebSocket.OPEN) return;
    if (entry.gated) {
      sessions.setMessages(prev => [...prev, {
        id: Date.now().toString(),
        type: 'system',
        content: `To re-run a gated tool (${entry.tool}), switch to AI mode and describe what you want. This tool (${entry.tool}) requires approval before running.`
      }]);
      return;
    }
    wsHandler.wsRef.current.send(JSON.stringify({
      type: 'execute_tool',
      payload: { tool: entry.tool, args: entry.args }
    }));
  }, [wsHandler.wsRef]);

  const addToWorkspace = useCallback((project: Project) => {
    setWorkspaceProjects(prev => {
      if (prev.some(p => p.id === project.id)) return prev;
      const updated = [...prev, project];
      wsHandler.wsRef.current?.send(JSON.stringify({
        type: 'workspace_set',
        payload: { projectIds: updated.map(p => p.id), activeProjectId: projects.activeProject?.id }
      }));
      return updated;
    });
  }, [wsHandler.wsRef, projects.activeProject]);

  const removeFromWorkspace = useCallback((projectId: string) => {
    setWorkspaceProjects(prev => {
      const updated = prev.filter(p => p.id !== projectId);
      wsHandler.wsRef.current?.send(JSON.stringify({
        type: 'workspace_set',
        payload: { projectIds: updated.map(p => p.id), activeProjectId: projects.activeProject?.id }
      }));
      return updated;
    });
  }, [wsHandler.wsRef, projects.activeProject]);

  const clearWorkspace = useCallback(() => {
    setWorkspaceProjects([]);
    wsHandler.wsRef.current?.send(JSON.stringify({
      type: 'workspace_set',
      payload: { projectIds: [], activeProjectId: projects.activeProject?.id }
    }));
  }, [wsHandler.wsRef, projects.activeProject]);

  const exportAsMarkdown = useCallback(() => {
    const projectName = projects.activeProject?.name || 'unknown-project';
    const sessionTitle = sessions.sessions.find(s => s.id === sessions.activeSessionId)?.title || 'session';
    const lines = [`# ${projectName} — ${sessionTitle}`, `Exported: ${new Date().toISOString()}`, ''];
    sessions.messages.forEach(m => {
      const role = m.type === 'user' ? '**User**' : m.type === 'error' ? '**Error**' : '**Assistant**';
      lines.push(`## ${role}`);
      if (m.type === 'bot') {
        lines.push(m.content);
      } else {
        lines.push('```\n' + m.content + '\n```');
      }
      if (m.suggestions?.length) {
        lines.push(`_Suggestions: ${m.suggestions.join(', ')}_`);
      }
      lines.push('');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${projectName}-${sessionTitle}.md`.replace(/[^a-zA-Z0-9._-]/g, '_'); a.click();
    URL.revokeObjectURL(url);
  }, [projects.activeProject, sessions.sessions, sessions.activeSessionId, sessions.messages]);

  const exportAsJson = useCallback(() => {
    const projectName = projects.activeProject?.name || 'unknown-project';
    const sessionTitle = sessions.sessions.find(s => s.id === sessions.activeSessionId)?.title || 'session';
    const data = {
      project: projectName,
      sessionId: sessions.activeSessionId,
      title: sessionTitle,
      exportedAt: new Date().toISOString(),
      messages: sessions.messages.map(m => ({
        id: m.id,
        role: m.type === 'user' ? 'user' : m.type === 'error' ? 'error' : 'assistant',
        content: m.content,
        suggestions: m.suggestions,
        isMarkdown: m.isMarkdown,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${projectName}-${sessionTitle}.json`.replace(/[^a-zA-Z0-9._-]/g, '_'); a.click();
    URL.revokeObjectURL(url);
  }, [projects.activeProject, sessions.sessions, sessions.activeSessionId, sessions.messages]);
  const ai = useAI(wsHandler.sendMessage, sessions.setMessages);
  const search = useSearch(sessions.setMessages);

  const tokenBuffer = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeProjectRef = useRef(projects.activeProject);
  activeProjectRef.current = projects.activeProject;

  // Requested directly (2026-07-29) after an AI query ran for 5+ minutes with no way to stop
  // it — CPU-only Ollama inference has no upper bound, and there was previously no cancel path
  // at all. Sends a 'cancel' WS message (server aborts the in-flight fetch or kills a running
  // trigger-mode command — see connection.js); the busy indicators clear themselves once the
  // server's own response to the cancel arrives, same as any other end-of-turn signal.
  const handleCancel = useCallback(() => {
    if (wsHandler.wsRef.current?.readyState === WebSocket.OPEN) {
      wsHandler.wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }
  }, [wsHandler]);

  // Override wsRef in terminal with the real one
  terminal.handleSendMessage.bind = Function.prototype.bind;
  const origHandleSendMessage = terminal.handleSendMessage;
  terminal.handleSendMessage = async (content: string) => {
    if (!projects.activeProject || !wsHandler.wsRef.current) return;
    if (wsHandler.wsRef.current.readyState !== WebSocket.OPEN) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (wsHandler.wsRef.current?.readyState === WebSocket.OPEN) break;
      }
    }
    if (wsHandler.wsRef.current?.readyState !== WebSocket.OPEN) return;
    sessions.setMessages(prev => [...prev, { id: Date.now().toString(), type: 'user', content }]);
    // Only trigger mode needs this — AI mode already gets its own busy indicator from the
    // server's 'ai_start' event (see ai.setAiThinking below), and showing both at once would be
    // redundant/confusing.
    if (!ai.aiEnabled) setCommandPending(true);
    wsHandler.wsRef.current.send(JSON.stringify({
      type: 'execute',
      payload: { projectId: projects.activeProject.id, input: content, sessionId: sessions.activeSessionId }
    }));
  };

  const handleWebSocketMessage = (payload: any) => {
    const id = Date.now().toString() + Math.random().toString();
    switch (payload.type) {
      case 'answer':
      case 'output':
      case 'start':
      case 'end':
        ai.setAiThinking(false);
        // 'end' is the one reliable "this turn is fully finished" signal across every
        // trigger-mode path (including ones with no visible text, e.g. a bare `{type:'end'}`
        // after a builtin intent) — deliberately NOT cleared on 'start'/'output' alone, since a
        // still-booting dev server keeps emitting those without actually being done yet.
        if (payload.type === 'end') setCommandPending(false);
        if (!payload.data?.trim()) break;
        sessions.setMessages(prev => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && (lastMsg.type === 'bot' || lastMsg.type === 'system') && !lastMsg.isMarkdown && payload.type !== 'answer') {
            const newMsgs = [...prev];
            newMsgs[newMsgs.length - 1] = {
              ...lastMsg,
              content: lastMsg.content + '\n' + payload.data
            };
            return newMsgs;
          }
          return [...prev, { id, type: 'bot', content: payload.data, isMarkdown: payload.type === 'answer' }];
        });
        break;
      case 'error_output':
        // Some paths (a top-level WS parse error) send only this with no 'end' to follow —
        // don't leave the busy indicator stuck on.
        setCommandPending(false);
        sessions.setMessages(prev => [...prev, {
          id, type: 'error', content: payload.data,
          switchProjectAction: payload.switchProjectAction,
        }]);
        break;
      case 'suggestions':
        sessions.setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last) {
            const newMsgs = [...prev];
            newMsgs[newMsgs.length - 1] = { ...last, suggestions: payload.data };
            return newMsgs;
          }
          return prev;
        });
        break;
      case 'clear_console':
        setCommandPending(false);
        sessions.setMessages([]);
        break;
      case 'confirm_prompt':
        // Some trigger-mode paths (a guessed direct command, an unrecognized-but-guessable
        // command) send this and nothing else — no 'end' follows, so this has to double as an
        // end-of-turn signal too or the busy indicator would stay stuck on until the user
        // approves/cancels.
        setCommandPending(false);
        terminal.setPendingConfirm({ token: payload.token, command: payload.command });
        break;
      case 'projects_updated':
        if (payload.data) projects.setProjects(payload.data);
        break;
      case 'project_updated':
        if (payload.data) {
          projects.setProjects(prev => prev.map(p => p.id === payload.data.id ? payload.data : p));
          projects.setIndexingProjectId(prev => prev === payload.data.id ? null : prev);
        }
        break;
      case 'ai_status':
        if (payload.data) {
          ai.setAiEnabled(payload.data.enabled);
          if (payload.data.model) ai.setAiModel(payload.data.model);
          if (payload.data.mode) ai.setAiMode(payload.data.mode);
        }
        break;
      case 'ai_start':
        ai.setAiThinking(true);
        ai.setAiThinkingText('');
        // Used to force the tool trace panel open on every single AI message ("so live activity
        // is visible without an extra click") — reported directly as an annoyance once AI mode
        // was actually being used for real (it popped the panel open on every message, including
        // ones with no tool calls at all, overriding the user's own choice to keep it closed).
        // The manual toggle button (now reliably visible after the earlier layout fix) is enough.
        break;
      case 'thinking':
        // A reasoning model's internal deliberation, separate from its actual answer (see
        // ollama.js/aiStream.js) — previously received and silently dropped. Appended directly
        // rather than run through the token buffer/flush-timer machinery below: thinking text is
        // typically much lower-volume than the final answer and this is a plain italic status
        // line, not markdown-rendered chat content, so the extra batching isn't worth the delay.
        if (payload.data) {
          ai.setAiThinkingText(prev => prev + payload.data);
        }
        break;
      case 'tool_start':
        // Previously sent by the server and silently dropped client-side — the user had no
        // live indication a command/tool was actually running until it finished (or, worse,
        // no visible progress at all for long-running steps). Surface it immediately as its
        // own lightweight line instead of waiting for the eventual tool_result.
        if (payload.data) {
          sessions.setMessages(prev => [...prev, { id, type: 'system', content: `⚙️ ${payload.data}` }]);
        }
        break;
      case 'stream_start': {
        ai.setAiThinking(false);
        ai.setAiThinkingText('');
        const streamId = id;
        if (wsHandler.wsRef.current) (wsHandler.wsRef.current as any)._streamId = streamId;
        sessions.setMessages(prev => [...prev, { id: streamId, type: 'bot', content: '', isMarkdown: true, streaming: true }]);
        break;
      }
      case 'token': {
        const streamId = wsHandler.wsRef.current ? (wsHandler.wsRef.current as any)._streamId : null;
        if (!streamId || !payload.data) break;
        tokenBuffer.current += payload.data;
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(() => {
            const content = tokenBuffer.current;
            tokenBuffer.current = '';
            flushTimer.current = null;
            // Check that the stream ID hasn't changed (guards against race where
            // stream_end cleared _streamId between when this timeout was scheduled
            // and when it fires).
            const currentStreamId = wsHandler.wsRef.current ? (wsHandler.wsRef.current as any)._streamId : null;
            if (currentStreamId !== streamId) return;
            sessions.setMessages(prev => prev.map(m => m.id === streamId ? { ...m, content: m.content + content } : m));
          }, 16);
        }
        break;
      }
      case 'stream_end': {
        // Flush any buffered tokens before clearing stream ID
        const streamId = wsHandler.wsRef.current ? (wsHandler.wsRef.current as any)._streamId : null;
        if (tokenBuffer.current && streamId) {
          const content = tokenBuffer.current;
          tokenBuffer.current = '';
          if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
          sessions.setMessages(prev => prev.map(m => m.id === streamId ? { ...m, content: m.content + content } : m));
        }
        if (wsHandler.wsRef.current) (wsHandler.wsRef.current as any)._streamId = null;
        break;
      }
      case 'tool_confirm_prompt':
        terminal.setPendingToolConfirm({ token: payload.token, tool: payload.tool, args: payload.args || {} });
        break;
      case 'task_granted':
        // Phase 5 (PASS 5.1): "Approve this task" acknowledged server-side.
        sessions.setMessages(prev => [...prev, { id, type: 'system', content: '✅ Approved this task — file edits for this conversation will run without further prompts (commands and tests still confirm).' }]);
        break;
      case 'memory_suggestion':
        // Proactive Layer-4 self-learning nudge (repeated question / frequent command / frequent
        // file edit / candidate CLAUDE.md addition) — previously silently dropped here, so the
        // whole adaptive-memory feature never reached the user despite firing server-side.
        terminal.setPendingMemorySuggestion(payload.data || payload);
        break;
      case 'tool_result': {
        const toolData = payload.data || {};
        addToolCall(toolData.tool || 'unknown', toolData.args || {}, toolData.result || toolData);
        if (toolData.tool && toolData.result && !toolData.error) {
          sessions.setMessages(prev => [...prev, {
            id, type: 'system',
            content: `🔧 Tool: ${toolData.tool}\n${typeof toolData.result === 'string' ? toolData.result : JSON.stringify(toolData.result, null, 2).slice(0, 500)}${JSON.stringify(toolData.result, null, 2).length > 500 ? '…' : ''}`
          }]);
        }
        break;
      }
      case 'workspace_updated': {
        if (payload.data) {
          const wsProjects = payload.data.projectIds
            .map((id: string) => projects.projects.find(p => p.id === id))
            .filter(Boolean);
          setWorkspaceProjects(wsProjects);
        }
        break;
      }
      case 'server_url':
        sessions.setMessages(prev => [...prev, { id, type: 'bot', content: `🔗 Dev server running at **${payload.data}**`, isMarkdown: true }]);
        break;
      case 'copy_to_clipboard':
        navigator.clipboard.writeText(payload.data).then(() => {
          sessions.setMessages(prev => [...prev, { id, type: 'system', content: `✅ Copied to clipboard: \`${payload.data}\`` }]);
        }).catch(() => {
          sessions.setMessages(prev => [...prev, { id, type: 'error', content: 'Failed to copy to clipboard' }]);
        });
        break;
      case 'dashboard_update':
        setDashboardUpdateSignal(n => n + 1);
        break;
      case 'learning_suggestion': {
        const { suggestions } = payload.data;
        if (suggestions.length === 0) {
          sessions.setMessages(prev => [...prev, { id, type: 'bot', content: 'No learning suggestions yet — keep using the console and check back later!' }]);
        } else {
          const formatted = suggestions.map((s: any) =>
            `**${s.intent}** (${s.confidence}) — ${s.count} occurrences, ${s.accepted} accepted, ${s.rejected} rejected\nPhrases: ${s.phrases.slice(0, 5).join(', ')}${s.phrases.length > 5 ? ` (+${s.phrases.length - 5} more)` : ''}`
          ).join('\n\n');
          sessions.setMessages(prev => [...prev, {
            id, type: 'bot', content: `### Learning Suggestions\n\n${formatted}\n\nType "approve suggestions" to add all, or "approve suggestions 1 3" to approve specific ones.`,
            isMarkdown: true,
            suggestions: suggestions.map((_: any, i: number) => `approve ${i + 1}`)
          }]);
        }
        break;
      }
    }
  };

  useEffect(() => {
    projects.fetchProjects();
    sessions.fetchSessions();
    wsHandler.connectWebSocket();
    fetch('/api/ollama/status').then(r => r.ok ? r.json() : null).then(s => { if (s) ai.fetchOllamaStatus(); }).catch(() => {});
    fetchActiveServers();
    const serverPollId = setInterval(fetchActiveServers, 5000);
    return () => {
      clearInterval(serverPollId);
      wsHandler.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A brand-new chat with zero messages sent isn't "committed" to anything yet — deleting it
  // when the user navigates away (new chat / picks a different project) avoids piling up empty
  // orphaned sessions every time someone opens "New Chat" and then changes their mind before
  // typing anything. Only ever touches the *current* session, and only when it's genuinely empty.
  const deleteCurrentSessionIfEmpty = useCallback(async () => {
    if (sessions.activeSessionId && sessions.messages.length === 0) {
      await sessions.deleteSession(sessions.activeSessionId);
    }
  }, [sessions]);

  const handleNewChat = async () => {
    try {
      terminal.setPendingConfirm(null);
      terminal.setPendingToolConfirm(null);
      await deleteCurrentSessionIfEmpty();
      sessions.setShowWelcome(false);
      sessions.createSession();
    } catch (err) {
      // Belt-and-suspenders: this is the one button whose whole job is to force the
      // Welcome-screen tree to unmount and the full dashboard tree to mount with no active
      // project yet — don't let any unexpected error here escape uncaught (the top-level
      // ErrorBoundary in main.tsx is the other half of this safety net).
      // eslint-disable-next-line no-console
      console.error('New Chat failed:', err);
      sessions.setMessages(prev => [...prev, {
        id: Date.now().toString(),
        type: 'error',
        content: 'Could not start a new chat — please try again.'
      }]);
    }
  };

  const QUICK_START_TEXT = [
    'Quick start:',
    '- Pick a project from the grid below, or scan a folder path up top, to get started.',
    '- Once a project is active, type things like "overview", "help", "git status", or "run dev" —',
    '  trigger mode answers from a fixed command list.',
    '- Toggle AI Assistant ON for open-ended requests: natural-language questions, file edits, and',
    '  running arbitrary commands (writes and risky commands always ask for approval first).',
    '- "New Chat" starts a fresh conversation; your chat history lives in the sidebar and always',
    '  reopens into the project it belongs to.',
  ].join('\n');

  const handleQuickStart = useCallback(() => {
    // The Quick Start Guide button is only ever shown on the Welcome screen, i.e. with no
    // active project — routing it through the normal send-message path silently no-ops there
    // (terminal.handleSendMessage bails out whenever !activeProject). Show the guide as a plain
    // local system message instead so it works with zero project/session/WS state required.
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    sessions.setShowWelcome(false);
    if (!sessions.activeSessionId) {
      sessions.createSession();
    }
    sessions.setMessages(prev => [...prev, {
      id: Date.now().toString(),
      type: 'system',
      content: QUICK_START_TEXT,
    }]);
  }, [sessions, terminal]);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await projects.scanNewPath(projects.scanPath);
    if (result.success) {
      sessions.setShowWelcome(false);
    } else {
      // Surface the failure instead of silently doing nothing (this was the actual cause of
      // "the folder picker doesn't let me pick anything" — the request was failing server-side
      // the whole time, just with no visible feedback).
      sessions.setShowWelcome(false);
      if (!sessions.activeSessionId) {
        sessions.createSession();
      }
      sessions.setMessages(prev => [...prev, {
        id: Date.now().toString(),
        type: 'error',
        content: result.error || 'Scan failed.',
      }]);
    }
  };

  const handleSelectProject = async (p: any) => {
    // Mirror handleSwitchSession: a pending confirmation/tool-confirm from whatever project was
    // active before is misleading (and stale) once the user has jumped to a different project.
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    await deleteCurrentSessionIfEmpty();
    projects.setActiveProject(p);
    sessions.setShowWelcome(false);
    // Clicking a project card always opens a chat scoped to *that* project — it never relinks
    // whatever chat you happened to have open (that used to silently reassign an existing
    // conversation's project, which is exactly how a chat titled like one project could end up
    // actually linked to another one — confusing and surprising either way). "New Chat" is the
    // only thing that starts a fresh, unlinked session; selecting a project is always a fresh
    // session tied to it from creation.
    await sessions.createSession(p.id, p.name);
    projects.handleSelectProject(p);
  };

  const handleDirectCommand = useCallback((command: string) => {
    if (!wsHandler.wsRef.current || wsHandler.wsRef.current.readyState !== WebSocket.OPEN) return;
    sessions.setMessages(prev => [...prev, { id: Date.now().toString(), type: 'user', content: command }]);
    wsHandler.wsRef.current.send(JSON.stringify({
      type: 'execute_tool',
      payload: { tool: 'executeCommand', args: { command, risky: false } }
    }));
  }, [wsHandler.wsRef, sessions.setMessages]);

  const handleSwitchSession = useCallback(async (sessionId: string) => {
    terminal.setPendingConfirm(null);
    terminal.setPendingToolConfirm(null);
    const s = await sessions.switchSession(sessionId);
    if (s?.projectId) {
      const project = projects.projects.find(p => p.id === s.projectId);
      if (project) {
        projects.setActiveProject(project);
        if (!project.codebaseIndex) {
          projects.handleSelectProject(project);
        }
      }
    }
  }, [sessions, projects, terminal]);

  // Recovery action for the "Session is locked to X" error: the currently-loaded chat and its
  // messages are already correct — the only thing out of sync is *which project is active*, so
  // fix just that (no new session, nothing about the open chat needs to change).
  const handleSwitchToProject = useCallback((projectId: string) => {
    const project = projects.projects.find(p => p.id === projectId);
    if (project) {
      projects.setActiveProject(project);
      if (!project.codebaseIndex) {
        projects.handleSelectProject(project);
      }
    } else {
      sessions.setMessages(prev => [...prev, {
        id: Date.now().toString(),
        type: 'error',
        content: `Couldn't find that project in the current list — try rescanning.`,
      }]);
    }
  }, [projects, sessions]);

  return {
    projects: projects.projects,
    activeProject: projects.activeProject,
    scanPath: projects.scanPath,
    setScanPath: projects.setScanPath,
    messages: sessions.messages,
    pendingConfirm: terminal.pendingConfirm,
    sessions: sessions.sessions,
    activeSessionId: sessions.activeSessionId,
    showSessions: sessions.showSessions,
    setShowSessions: sessions.setShowSessions,
    aiEnabled: ai.aiEnabled,
    ollamaStatus: ai.ollamaStatus,
    aiThinking: ai.aiThinking,
    aiThinkingText: ai.aiThinkingText,
    commandPending,
    activeServers,
    dashboardUpdateSignal,
    indexingProjectId: projects.indexingProjectId,
    aiModel: ai.aiModel,
    aiMode: ai.aiMode,
    showWelcome: sessions.showWelcome,
    setShowWelcome: sessions.setShowWelcome,
    pendingToolConfirm: terminal.pendingToolConfirm,
    pendingMemorySuggestion: terminal.pendingMemorySuggestion,
    handleSendMessage: terminal.handleSendMessage,
    handleCancel,
    handleConfirm: terminal.handleConfirm,
    handleToolConfirm: terminal.handleToolConfirm,
    handleApproveTask: terminal.handleApproveTask,
    handleMemorySuggestionRespond: terminal.handleMemorySuggestionRespond,
    toolHistory,
    showToolHistory,
    setShowToolHistory,
    rerunToolCall,
    exportAsMarkdown,
    exportAsJson,
    handleDirectCommand,
    workspaceProjects,
    addToWorkspace,
    removeFromWorkspace,
    clearWorkspace,
    handleAIToggle: ai.handleAIToggle,
    handleSetModel: ai.handleSetModel,
    handleSetMode: ai.handleSetMode,
    handlePullModel: ai.handlePullModel,
    fetchOllamaStatus: ai.fetchOllamaStatus,
    handleSelectProject,
    handleSearch: search.handleSearch,
    handleDeepResearch: search.handleDeepResearch,
    handleNewChat,
    handleQuickStart,
    handleScan,
    createSession: sessions.createSession,
    switchSession: handleSwitchSession,
    deleteSession: sessions.deleteSession,
    handleSwitchToProject,
  };
}
