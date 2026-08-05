import type { TerminalMessage, ToolCallEntry, Project, PendingMemorySuggestion, PendingToolConfirm } from '../types';

/**
 * The bag of everything the WS-message case handlers (wsMessageCases.ts / wsStreamingCases.ts)
 * are allowed to touch. Owned by the useConsole orchestrator, which assigns it to a ref each
 * render; the stable router reads the ref at event time, so the handlers always see fresh
 * state (this also fixes the latent stale-closure the original handleWebSocketMessage had for
 * `projects.projects`, which was captured once at first render).
 *
 * Invariant: every setter/ref in here is stable across renders (React setState setters and
 * useRef objects), so a case handler can capture ctx values at event time without going stale.
 * The one exception is `projects.projects` (a live list) — that's exactly why ctx is re-read
 * from the ref on every WS message rather than captured by the router.
 */
export interface WsCtx {
  wsRef: React.MutableRefObject<WebSocket | null>;
  sessions: {
    setMessages: React.Dispatch<React.SetStateAction<TerminalMessage[]>>;
  };
  terminal: {
    setPendingConfirm: (v: { token: string; command: string } | null) => void;
    setPendingToolConfirm: (v: PendingToolConfirm | null) => void;
    setPendingMemorySuggestion: (v: PendingMemorySuggestion | null) => void;
  };
  ai: {
    setAiEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    setAiModel: React.Dispatch<React.SetStateAction<string>>;
    setAiMode: React.Dispatch<React.SetStateAction<string>>;
    setAiThinking: React.Dispatch<React.SetStateAction<boolean>>;
    setAiThinkingText: React.Dispatch<React.SetStateAction<string>>;
    /** True between the server's 'ai_start' and the end of the AI turn's stream — used to
     *  auto-expand output blocks that were created by commands the AI ran. */
    aiQueryInFlight: boolean;
    setAiQueryInFlight: React.Dispatch<React.SetStateAction<boolean>>;
  };
  projects: {
    projects: Project[];
    setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
    setIndexingProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  };
  workspace: {
    setWorkspaceProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  };
  stream: {
    tokenBuffer: React.MutableRefObject<string>;
    flushTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    streamHadTokenRef: React.MutableRefObject<boolean>;
  };
  commandPending: {
    setCommandPending: React.Dispatch<React.SetStateAction<boolean>>;
  };
  setDashboardUpdateSignal: React.Dispatch<React.SetStateAction<number>>;
  /** Grows with every server_url event and every processes poll that returns a URL — the
   *  only URLs that qualify for the "Click here to open the site" chip (a real NetPulse
   *  chat showed the chip on an Ollama error message because any http URL qualified). */
  setKnownDevUrls: React.Dispatch<React.SetStateAction<string[]>>;
  appendProcessOutput: (text: string) => void;
  addToolCall: (tool: string, args: Record<string, any>, result: any) => void;
  fetchProcesses: () => void;
}

export type WsCaseHandler = (ctx: WsCtx, payload: any) => void;

/** Per-message id, matching the original handleWebSocketMessage's `id` generation. */
export const makeId = () => Date.now().toString() + Math.random().toString();
