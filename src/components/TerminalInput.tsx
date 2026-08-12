import React from 'react';
import { AIStatus, Project } from '../types';
import { Send, Brain } from 'lucide-react';
import { AIAssistantInterface } from './ui/AIAssistantInterface';

const AI_MODES = [
  { value: 'default', label: 'General' },
  { value: 'coding', label: 'Coding' },
  { value: 'tutor', label: 'Tutor' },
  { value: 'creative', label: 'Creative' },
  { value: 'consultant', label: 'Consultant' },
  { value: 'structured', label: 'Structured' }
];

interface TerminalInputProps {
  centerCol: string;
  aiEnabled: boolean;
  aiThinking: boolean;
  commandPending: boolean;
  isBlocked: boolean;
  activeProject: Project | null;
  ollamaStatus: AIStatus | null;
  aiModel: string;
  aiMode: string;
  onAIToggle: () => void;
  onSetModel: (model: string) => void;
  onSetMode: (mode: string) => void;
  chatPrompt: string;
  input: string;
   onInputChange: (value: string) => void;
   onInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
   onSubmit: (e: React.FormEvent) => void;
   inputRef: React.RefObject<HTMLInputElement | null>;
   onAISend: (text: string) => void;
   onSearch?: (query: string) => void;
   onDeepResearch?: (query: string) => void;
   getHistory: () => string[];
   connected: boolean;
 }

/** Bottom cluster of the terminal column: the AI toggle/model/mode bar and the input row
 *  (AIAssistantInterface when AI is on, the plain command form otherwise). Pure presentation —
 *  all state and handlers stay in Terminal.tsx. */
export function TerminalInput({
  centerCol, aiEnabled, aiThinking, commandPending, isBlocked, activeProject, ollamaStatus,
  aiModel, aiMode, onAIToggle, onSetModel, onSetMode, chatPrompt, input,   onInputChange,
  onInputKeyDown, onSubmit, inputRef, onAISend, onSearch, onDeepResearch, getHistory,
  connected,
}: TerminalInputProps) {
  return (
    <>
      {ollamaStatus && (
        <div className={`${centerCol} flex items-center gap-2 px-4 py-1.5 bg-panel border-t border-border-soft flex-wrap`}>
          <button onClick={onAIToggle} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] transition-colors border flex-shrink-0 ${aiEnabled ? 'bg-accent-green/20 border-accent-green/40 text-accent-green' : 'bg-panel border-border-soft text-fg-muted hover:text-fg-strong'}`}>
            <Brain size={13} />
            <span>AI {aiEnabled ? 'ON' : 'OFF'}</span>
          </button>
          {aiEnabled && ((ollamaStatus.models?.length ?? 0) > 0 || (ollamaStatus.cloudModels?.length ?? 0) > 0) && (
            <>
              <select
                value={aiModel}
                onChange={(e) => onSetModel(e.target.value)}
                title={ollamaStatus.cloudModels?.some(m => m.name === aiModel) ? 'Running on Ollama Cloud — needs internet + `ollama signin`' : 'Running locally'}
                className="bg-surface border border-border-soft rounded-md px-1.5 py-1 text-[11px] text-fg-muted focus:outline-none focus:border-accent-teal/40 flex-shrink-0 max-w-[220px]"
              >
                {(ollamaStatus.models?.length ?? 0) > 0 && (
                  <optgroup label="Local (offline)">
                    {ollamaStatus.models.map((m: any) => (
                      <option key={m.name} value={m.name}>{m.name}</option>
                    ))}
                  </optgroup>
                )}
                {(ollamaStatus.cloudModels?.length ?? 0) > 0 && (
                  <optgroup label="Ollama Cloud (needs sign-in + internet)">
                    {ollamaStatus.cloudModels!.map((m) => (
                      <option key={m.name} value={m.name}>{m.label}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <select
                value={aiMode}
                onChange={(e) => onSetMode(e.target.value)}
                className="bg-surface border border-border-soft rounded-md px-1.5 py-1 text-[11px] text-fg-muted focus:outline-none focus:border-accent-teal/40 flex-shrink-0"
              >
                {AI_MODES.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </>
          )}
        </div>
      )}

      {aiEnabled ? (
        <div className={`${centerCol} p-3 bg-panel border border-border-strong rounded-xl`}>
           <AIAssistantInterface onSend={onAISend} onSearch={(q) => { onSearch?.(q); }} onDeepResearch={(q) => { onDeepResearch?.(q); }} disabled={!activeProject || aiThinking || isBlocked || !connected} placeholder={isBlocked ? 'Resolve the pending confirmation first (Esc to cancel)...' : aiThinking ? 'AI is thinking...' : !connected ? 'Reconnecting…' : chatPrompt} getHistory={getHistory} />
        </div>
      ) : (
        <form onSubmit={onSubmit} className={`${centerCol} p-3 bg-panel border border-border-strong rounded-xl`}>
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => { onInputChange(e.target.value); }}
              onKeyDown={onInputKeyDown}
              disabled={!activeProject || aiThinking || commandPending || !connected}
              placeholder={!activeProject ? "Select a project to start..." : aiThinking ? "AI is thinking..." : commandPending ? "Running..." : !connected ? "Reconnecting…" : chatPrompt}
              className="w-full bg-surface border border-border-soft rounded-xl py-3 pl-4 pr-12 text-fg text-sm focus:outline-none focus:border-accent-blue transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
               disabled={!input.trim() || !activeProject || aiThinking || commandPending || isBlocked || !connected}
               title={!connected ? 'WebSocket disconnected — reconnecting…' : isBlocked ? 'Resolve the pending confirmation first (Esc to cancel)' : undefined}
              className="absolute right-1.5 w-9 h-9 rounded-lg bg-accent-blue text-white hover:opacity-90 flex items-center justify-center disabled:opacity-50 transition-opacity"
            >
              <Send size={18} />
            </button>
          </div>
        </form>
      )}
    </>
  );
}
