import { useCallback } from 'react';
import type { Project, TerminalMessage, ChatSession } from '../types';
import { makeMessage } from '../utils/makeMessage';
import { addToast } from '../components/ui/toastStore';

/** The pieces of useSessions' return the export callbacks read. */
interface ExportSessions {
  sessions: ChatSession[];
  activeSessionId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<TerminalMessage[]>>;
}

/**
 * Markdown/JSON/PDF session exports (Phase 0 rewrite, 2026-08-10). Every export downloads from
 * the server's persisted NDJSON record (GET /api/sessions/:id/export) instead of formatting
 * whatever happens to be in React state: the old version had no timestamps and collapsed every
 * non-user/error role onto a generic "Assistant" bucket, and could only see messages the
 * current tab had actually rendered. The server-side formatter (sessionExport.js) is the single
 * implementation — nothing forks here. PDF is generated client-side with jspdf from the same
 * server JSON.
 */
export function useConsoleExports(
  activeProject: Project | null,
  sessions: ExportSessions,
  tabId: string | null = null,
) {
  const pushError = useCallback((message: string) => {
    sessions.setMessages(prev => [...prev, makeMessage('error', message)]);
  }, [sessions]);

  const sessionTitle = sessions.sessions.find(s => s.id === sessions.activeSessionId)?.title || 'session';
  const fileBase = `${activeProject?.name || 'unknown-project'}-${sessionTitle}`.replace(/[^a-zA-Z0-9._-]/g, '_');

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const fetchSessionExport = useCallback(async (format: 'md' | 'json'): Promise<string | null> => {
    if (!sessions.activeSessionId) return null;
    try {
      const res = await fetch(`/api/sessions/${sessions.activeSessionId}/export?format=${format}`);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }, [sessions.activeSessionId]);

  const exportAsMarkdown = useCallback(() => {
    void (async () => {
      const text = await fetchSessionExport('md');
      if (text === null) {
        pushError('Could not export the session — try again in a moment.');
        return;
      }
      downloadBlob(new Blob([text], { type: 'text/markdown' }), `${fileBase}.md`);
      addToast({ title: `Exported session as Markdown`, description: fileBase });
    })();
  }, [fetchSessionExport, downloadBlob, fileBase, pushError]);

  const exportAsJson = useCallback(() => {
    void (async () => {
      const text = await fetchSessionExport('json');
      if (text === null) {
        pushError('Could not export the session — try again in a moment.');
        return;
      }
      downloadBlob(new Blob([text], { type: 'application/json' }), `${fileBase}.json`);
      addToast({ title: 'Exported session as JSON', description: fileBase });
    })();
  }, [fetchSessionExport, downloadBlob, fileBase, pushError]);

  const exportAsPdf = useCallback(() => {
    void (async () => {
      const text = await fetchSessionExport('json');
      if (text === null) {
        pushError('Could not export the session — try again in a moment.');
        return;
      }
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      const page = doc.internal.pageSize;
      const margin = 14;
      const maxWidth = page.getWidth() - margin * 2;
      let y = 16;
      const ensureSpace = (needed: number) => {
        if (y + needed > page.getHeight() - 14) {
          doc.addPage();
          y = 16;
        }
      };
      try {
        const data = JSON.parse(text);
        doc.setFontSize(15);
        doc.text(String(data.title || 'Session export'), margin, y);
        y += 6;
        doc.setFontSize(9);
        doc.setTextColor(130);
        doc.text(`Exported ${data.exportedAt}`, margin, y);
        y += 10;
        for (const m of data.messages || []) {
          doc.setTextColor(70);
          doc.setFontSize(9);
          doc.setFont('helvetica', 'bold');
          const when = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
          doc.text(`${pdfRoleLabel(m.role)}${when ? ` — ${when}` : ''}`, margin, y);
          y += 5;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(25);
          const lines = doc.splitTextToSize(sanitizePdfText(String(m.content || '')), maxWidth);
          for (const line of lines) {
            ensureSpace(5);
            doc.text(line, margin, y);
            y += 5;
          }
          y += 4;
          ensureSpace(14);
        }
        doc.save(`${fileBase}.pdf`);
        addToast({ title: 'Exported session as PDF', description: fileBase });
      } catch {
        pushError('Could not build the PDF — the export data was unreadable.');
      }
    })();
  }, [fetchSessionExport, fileBase, pushError]);

  const exportProjectChatLog = useCallback(() => {
    void (async () => {
      if (!activeProject) return;
      try {
        // Phase T: the chat-log route resolves the project inside the requesting tab's
        // workspace (a tab's project may not exist in the global cache at all).
        const q = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
        const res = await fetch(`/api/projects/${activeProject.id}/chat-log${q}`);
        if (!res.ok) {
          pushError('This project has no chat log yet — send a message first.');
          return;
        }
        const blob = await res.blob();
        downloadBlob(blob, `${activeProject.name || 'project'}-chat-log.md`.replace(/[^a-zA-Z0-9._-]/g, '_'));
        addToast({ title: 'Downloaded project chat log' });
      } catch {
        pushError('Could not download the project chat log — try again in a moment.');
      }
    })();
  }, [activeProject, downloadBlob, pushError, tabId]);

  return { exportAsMarkdown, exportAsJson, exportAsPdf, exportProjectChatLog };
}

/** jsPDF's built-in fonts only cover latin-1; the app's UI glyphs (⚙ ✓ → etc.) would render as
 *  garbage, so PDF output maps them to ASCII equivalents. Other unicode passes through as-is —
 *  typographic quotes/dashes are latin-1-safe. */
function sanitizePdfText(content: string): string {
  const map: Record<string, string> = {
    '⚙': '[tool]', '✓': 'OK', '🔧': '[tool]', '→': '->', '·': '-',
    '▸': '>', '—': '--', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '×': 'x',
  };
  return content.split('').map(ch => map[ch] ?? ch).join('');
}

function pdfRoleLabel(role: string): string {
  const map: Record<string, string> = {
    user: 'User', bot: 'Assistant', system: 'System', output: 'Output',
    error: 'Error', warning: 'Notice',
  };
  return map[role] || role;
}