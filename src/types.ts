export interface ProjectConfig {
  projectName: string;
  entries: {
    triggers: string[];
    type: 'command' | 'answer';
    action?: string;
    response?: string;
    risky?: boolean;
    /** True if this entry was auto-derived from package.json scripts rather than hand-written
     *  in console.config.json (see server/scriptEntries.js). */
    auto?: boolean;
  }[];
}

export interface ContextFile {
  filename: string;
  content: string;
}

export interface ParsedKnowledge {
  stack: string;
  commands: string;
  gotchas: string;
  architecture: string;
}

export interface CodebaseIndex {
  totalDirs: number;
  totalFiles: number;
  languages: string[];
  entryPoints: string[];
  /** Source excerpts of the first couple non-HTML entry points (see server/codebaseIndexer.js). */
  entrySnippets?: Record<string, string>;
  directoryTree: string[];
  fileSample: string[];
  keyFiles: Record<string, string>;
  hasCli: boolean;
  hasTests: boolean;
  hasConfig: boolean;
}

export interface Project {
  id: string;
  folderName: string;
  name: string;
  path: string;
  config: ProjectConfig;
  contextFiles?: ContextFile[];
  parsedKnowledge?: ParsedKnowledge;
  codebaseIndex?: CodebaseIndex | null;
}

export interface TerminalMessage {
  id: string;
  type: 'user' | 'bot' | 'system' | 'error' | 'warning' | 'output';
  content: string;
  suggestions?: string[];
  /** Non-blocking "did you mean" suggestion (intent id + confidence + human label) attached to a bot answer. */
  didYouMean?: { intent: string; confidence: number; label?: string } | null;
  isMarkdown?: boolean;
  /** True while an AI response is still streaming into this message's content. */
  streaming?: boolean;
  /** Set on the "session is locked to a different project" error — lets the UI offer a direct
   *  one-click switch instead of just telling the user what went wrong. */
  switchProjectAction?: { projectId: string; projectName: string };
}

export interface ChatSession {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredSession {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  messages: { id: string; role: string; content: string; timestamp: number }[];
  createdAt: number;
  updatedAt: number;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified: string;
}

export interface CloudModel {
  name: string;
  label: string;
}

export interface AIStatus {
  running: boolean;
  models: OllamaModel[];
  cloudModels?: CloudModel[];
  internetReachable?: boolean;
}

export interface AISessionState {
  enabled: boolean;
  model?: string;
  mode?: string;
}

/** A gated AI tool call (writeFile/editFile/risky executeCommand) awaiting user approval. */
export interface PendingToolConfirm {
  token: string;
  tool: string;
  args: Record<string, any>;
}

/**
 * A proactive "adaptive project memory" nudge (Layer 4 self-learning) — the server noticed a
 * repeated question, a frequently-run command, or a frequently-edited file (or a substantive AI
 * answer worth remembering) and is offering to write it into the project's CLAUDE.md.
 */
export interface PendingMemorySuggestion {
  type: 'question_repeat' | 'command_frequency' | 'file_edit_frequency' | 'candidate_addition';
  topic: string;
  message: string;
  count?: number;
  command?: string;
  filePath?: string;
  content?: string;
}

/** A recorded tool call in the history panel. */
export interface ToolCallEntry {
  id: string;
  tool: string;
  args: Record<string, any>;
  result: any;
  timestamp: number;
  /** True if this tool call requires user approval (gated). */
  gated: boolean;
}
