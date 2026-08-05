import { useCallback } from 'react';
import type { Project, TerminalMessage, ChatSession } from '../types';

/** The pieces of useSessions' return the export callbacks read. */
interface ExportSessions {
  sessions: ChatSession[];
  activeSessionId: string | null;
  messages: TerminalMessage[];
}

/**
 * Markdown/JSON session exports, extracted verbatim from useConsole.ts. Pure download side
 * effects over (activeProject, sessions) — no state of their own, so this is the thinnest
 * of the Phase 13 leaves.
 */
export function useConsoleExports(
  activeProject: Project | null,
  sessions: ExportSessions,
) {
  const exportAsMarkdown = useCallback(() => {
    const projectName = activeProject?.name || 'unknown-project';
    const sessionTitle = sessions.sessions.find(s => s.id === sessions.activeSessionId)?.title || 'session';
    const lines = [`# ${projectName} — ${sessionTitle}`, `Exported: ${new Date().toISOString()}`, ''];
    sessions.messages.forEach(m => {
      const role = m.type === 'user' ? '**User**' : m.type === 'error' ? '**Error**' : m.type === 'warning' ? '**Notice**' : '**Assistant**';
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
  }, [activeProject, sessions.sessions, sessions.activeSessionId, sessions.messages]);

  const exportAsJson = useCallback(() => {
    const projectName = activeProject?.name || 'unknown-project';
    const sessionTitle = sessions.sessions.find(s => s.id === sessions.activeSessionId)?.title || 'session';
    const data = {
      project: projectName,
      sessionId: sessions.activeSessionId,
      title: sessionTitle,
      exportedAt: new Date().toISOString(),
      messages: sessions.messages.map(m => ({
        id: m.id,
        role: m.type === 'user' ? 'user' : m.type === 'error' ? 'error' : m.type === 'warning' ? 'warning' : 'assistant',
        content: m.content,
        suggestions: m.suggestions,
        isMarkdown: m.isMarkdown,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${projectName}-${sessionTitle}.json`.replace(/[^a-zA-Z0-9._-]/g, '_'); a.click();
    URL.revokeObjectURL(url);
  }, [activeProject, sessions.sessions, sessions.activeSessionId, sessions.messages]);

  return { exportAsMarkdown, exportAsJson };
}
