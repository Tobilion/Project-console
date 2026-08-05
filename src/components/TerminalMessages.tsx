import React, { useMemo } from 'react';
import { TerminalMessage, PendingToolConfirm, PendingMemorySuggestion } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { Loader2, Square, AlertTriangle, ExternalLink } from 'lucide-react';
import { OutputBlock } from './TerminalOutputBlock';
import { StructuredJsonBlock } from './StructuredJsonBlock';
import { TerminalConfirmCards } from './TerminalConfirmCards';
import { TerminalEmptyState } from './TerminalEmptyState';

/** The server appends a performance note to the end of streamed AI replies (see
 * server/ollama.js chatStream): `\n\n_(2.0s, 9 tok/s)_`. Strip it from the rendered
 * markdown and surface it as a muted footer below the response block instead. */
const TELEMETRY_RE = /\n\n_\(([\d.]+s, \d+ tok\/s)\)_$/;
function splitTelemetry(content: string): { body: string; meta: string | null } {
  const m = content.match(TELEMETRY_RE);
  if (!m) return { body: content, meta: null };
  return { body: content.slice(0, content.length - m[0].length), meta: m[1] };
}

/** First http(s) URL in a message, trailing punctuation trimmed (Phase 15: "what is the
 *  link"-style answers embed bare URLs that react-markdown never autolinks — they get a
 *  dedicated "click here" anchor below the bubble instead). */
function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>()[\]"'`]+/);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/, '');
}

interface TerminalMessagesProps {
  messages: TerminalMessage[];
  centerCol: string;
  isBlocked: boolean;
  onSendMessage: (msg: string) => void;
  onDirectCommand?: (command: string) => void;
  onSwitchToProject?: (projectId: string) => void;
  aiMode: string;
  endRef: React.RefObject<HTMLDivElement | null>;
  aiThinking: boolean;
  aiThinkingText?: string;
  commandPending: boolean;
  onCancel?: () => void;
  pendingConfirm: { token: string; command: string } | null;
  onConfirm: (confirmed: boolean) => void;
  pendingToolConfirm: PendingToolConfirm | null;
  onToolConfirm: (confirmed: boolean) => void;
  onApproveTask?: () => void;
  pendingMemorySuggestion?: PendingMemorySuggestion | null;
  onMemorySuggestionRespond?: (accept: boolean) => void;
  emptyStatePrompt: string;
  emptyStateActions: string[];
  onDidYouMeanPick?: (intent: string) => void;
}

/** The scrollable message thread: chat bubbles (markdown/JSON/output), inline confirm
 *  cards, the scroll anchor, and the AI/trigger-mode busy indicators. */
export function TerminalMessages({
  messages,
  centerCol,
  isBlocked,
  onSendMessage,
  onDirectCommand,
  onSwitchToProject,
  aiMode,
  endRef,
  aiThinking,
  aiThinkingText,
  commandPending,
  onCancel,
  pendingConfirm,
  onConfirm,
  pendingToolConfirm,
  onToolConfirm,
  onApproveTask,
  pendingMemorySuggestion,
  onMemorySuggestionRespond,
  emptyStatePrompt,
  emptyStateActions,
  onDidYouMeanPick,
}: TerminalMessagesProps) {
  // Custom markdown components for structured JSON blocks
  const markdownComponents = useMemo(() => ({
    code({ className, children, ...props }: any) {
      const isJson = className === 'language-json' || className === 'language-js';
      if (isJson && aiMode === 'structured') {
        const text = String(children).replace(/\n$/, '');
        return <StructuredJsonBlock content={text} onSendMessage={onSendMessage} />;
      }
      return <code className={className} {...props}>{children}</code>;
    }
  }), [aiMode, onSendMessage]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {messages.length === 0 ? (
        <div className={`${centerCol} min-h-full flex flex-col items-center justify-center`}>
          <TerminalEmptyState greeting={emptyStatePrompt} actions={emptyStateActions} onAction={onSendMessage} />
        </div>
      ) : (
      <div className={`${centerCol} space-y-3`}>
      <AnimatePresence initial={false}>
        {messages.map((msg, i) => {
          if (msg.type === 'output') {
            return (
              <motion.div
                key={msg.id || i}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-start max-w-[85%]"
              >
                <OutputBlock content={msg.content} />
              </motion.div>
            );
          }
          const tel = splitTelemetry(msg.content);
          const linkUrl = msg.type !== 'user' ? extractUrl(tel.body) : null;
          return (
          <motion.div
            key={msg.id || i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`flex flex-col ${msg.type === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-5 py-3 ${
                msg.type === 'user' 
                  ? 'bg-[#3d6bff] text-white rounded-br-none' 
                  : msg.type === 'error'
                  ? 'bg-red-500/10 border border-red-500/20 text-red-400 rounded-bl-none font-mono text-sm'
                  : msg.type === 'warning'
                  ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-bl-none'
                  : 'bg-panel border border-border-soft text-fg rounded-bl-none'
              }`}
            >
              {msg.type === 'warning' ? (
                 <div className="flex items-start gap-2">
                   <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                   <div className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</div>
                 </div>
              ) : msg.type === 'user' || !msg.isMarkdown ? (
                 <div className="whitespace-pre-wrap text-sm leading-relaxed">{tel.body}</div>
              ) : (
                 <>
                   <div className="prose prose-sm max-w-none prose-pre:bg-scrim prose-pre:border prose-pre:border-border-soft prose-pre:p-0 prose-p:leading-relaxed prose-a:text-accent prose-a:underline">
                     <ReactMarkdown components={markdownComponents}>{tel.body}</ReactMarkdown>
                   </div>
                   {tel.meta && (
                     <div className="mt-2 text-xs font-mono text-fg-dim">{tel.meta}</div>
                   )}
                </>
               )}
               
               {linkUrl && (
                 <a
                   href={linkUrl}
                   target="_blank"
                   rel="noreferrer"
                   title={linkUrl}
                   className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#00d4a3]/10 border border-[#00d4a3]/30 text-xs text-[#00d4a3] hover:bg-[#00d4a3]/20 transition-colors"
                 >
                   Click here to open the site
                   <ExternalLink size={11} />
                 </a>
               )}
              
              {msg.suggestions && msg.suggestions.length > 0 && (
                <div className="mt-4 pt-4 border-t border-border-soft">
                  <p className="text-xs text-fg-dim mb-2">SUGGESTIONS:</p>
                  <div className="flex flex-wrap gap-2">
                    {msg.suggestions.map((sug, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          if (!isBlocked) {
                            if (onDirectCommand && /^(npm|npx|python|node|git)\s/.test(sug)) {
                              onDirectCommand(sug);
                            } else {
                              onSendMessage(sug);
                            }
                          }
                        }}
                        className="px-3 py-1 rounded-full bg-panel hover:bg-panel-strong border border-border-soft text-xs text-[#00d4a3] transition-colors"
                      >
                        {sug}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {msg.didYouMean && onDidYouMeanPick && (
                <div className="mt-3 pt-3 border-t border-border-soft">
                  <p className="text-xs text-fg-dim mb-2">DID YOU MEAN:</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        if (!isBlocked) onDidYouMeanPick(msg.didYouMean!.intent);
                      }}
                      className="px-3 py-1 rounded-full bg-panel hover:bg-panel-strong border border-border-soft text-xs text-[#00d4a3] transition-colors"
                    >
                      {msg.didYouMean.label || msg.didYouMean.intent}
                    </button>
                  </div>
                </div>
              )}

              {msg.switchProjectAction && onSwitchToProject && (
                <div className="mt-3 pt-3 border-t border-red-500/20">
                  <button
                    onClick={() => onSwitchToProject(msg.switchProjectAction!.projectId)}
                    className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-xs text-red-300 transition-colors"
                  >
                    Switch to "{msg.switchProjectAction.projectName}"
                  </button>
                </div>
              )}
            </div>
            </motion.div>
          );
        })}
      </AnimatePresence>

      <TerminalConfirmCards
        pendingConfirm={pendingConfirm}
        onConfirm={onConfirm}
        pendingToolConfirm={pendingToolConfirm}
        onToolConfirm={onToolConfirm}
        onApproveTask={onApproveTask}
        pendingMemorySuggestion={pendingMemorySuggestion}
        onMemorySuggestionRespond={onMemorySuggestionRespond}
      />

      <div ref={endRef} />

      {aiThinking && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3 text-teal-400/60 text-xs">
            <Loader2 size={14} className="animate-spin" />
            AI is thinking...
            {/* Requested directly (2026-07-29) after a query ran 5+ minutes with no way to stop
                it — CPU-only Ollama inference has no upper bound on its own. */}
            {onCancel && (
              <button
                onClick={onCancel}
                className="flex items-center gap-1 px-2 py-0.5 rounded border border-red-500/30 text-red-400/80 hover:text-red-300 hover:border-red-500/60 hover:bg-red-500/10 transition-colors"
                title="Cancel this request"
              >
                <Square size={10} /> Stop
              </button>
            )}
          </div>
          {/* Requested directly (2026-07-30) — the server already separates a reasoning
              model's internal deliberation (Ollama's `message.thinking`) from its real answer
              and streams the former as its own 'thinking' event; previously the spinner above
              was the only signal anything was happening, with no visibility into what the
              model was actually doing. Capped height + scroll so a long reasoning trace doesn't
              push the input bar off-screen; only rendered once there's actually text to show. */}
          {aiThinkingText && (
            <div className="max-h-24 overflow-y-auto text-teal-400/40 text-xs font-mono italic whitespace-pre-wrap pl-6 border-l border-teal-400/20">
              {aiThinkingText}
            </div>
          )}
        </motion.div>
      )}

      {/* Trigger-mode busy indicator — requested directly after "run the site" gave no visual
          sign the console was still working on a slow-starting command (e.g. a dev server
          still booting), leaving no way to tell "still running" from "silently done". */}
      {commandPending && !aiThinking && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 text-[#00d4a3]/60 text-xs">
          <Loader2 size={14} className="animate-spin" />
          Running...
          {onCancel && (
            <button
              onClick={onCancel}
              className="flex items-center gap-1 px-2 py-0.5 rounded border border-red-500/30 text-red-400/80 hover:text-red-300 hover:border-red-500/60 hover:bg-red-500/10 transition-colors"
              title="Cancel this command"
            >
              <Square size={10} /> Stop
            </button>
          )}
        </motion.div>
      )}
      </div>
      )}
    </div>
  );
}
