import React, { useMemo, useRef, useEffect, useCallback, ErrorInfo, ReactNode } from 'react';
import { TerminalMessage, PendingToolConfirm, PendingMemorySuggestion } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { Loader2, Square, AlertTriangle, ExternalLink } from 'lucide-react';
import { OutputBlock } from './TerminalOutputBlock';
import { StructuredJsonBlock } from './StructuredJsonBlock';
import { TerminalConfirmCards } from './TerminalConfirmCards';
import { TerminalEmptyState } from './TerminalEmptyState';

/** M23: a message-level boundary (local, NOT the app's shared ErrorBoundary) so a single
 *  malformed message renders inline in the thread instead of unmounting the whole messages
 *  area. resetKeys is keyed on the message id so that deleting/refreshing a bad message clears
 *  the error and re-renders the real row. */
class RowErrorBoundary extends React.Component<
  { children: ReactNode; resetKeys?: ReactNode[]; fallback: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode; resetKeys?: ReactNode[]; fallback: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Message row render error (M23):', error, info.componentStack);
  }
  componentDidUpdate(prev: { resetKeys?: ReactNode[] }) {
    if (
      this.state.error &&
      this.props.resetKeys &&
      JSON.stringify(prev.resetKeys) !== JSON.stringify(this.props.resetKeys)
    ) {
      this.setState({ error: null });
    }
  }
  handleReset = () => this.setState({ error: null });
  render() {
    if (this.state.error) return this.props.fallback;
    return this.props.children;
  }
}

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
  // Strip trailing punctuation AND markdown emphasis (`**bold**` URLs end with `**` — an
  // href containing those is an invalid URL and browsers land on about:blank#blocked).
  return m[0].replace(/[*_.,;:!?]+$/, '');
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
  /** Dev-server site URLs the console has actually seen (server_url events + processes
   *  polls) — the "Click here to open the site" chip is gated on these so arbitrary links
   *  in messages (e.g. an Ollama endpoint inside an error text) never get one. */
  knownDevUrls: string[];
}

/** One chat row's *content* (bubble / output block / suggestion chips), extracted into a memoized
 *  component so a 16ms token update only re-renders the row whose message object changed (M21).
 *  The motion.div wrapper AnimatePresence tracks stays inline in the parent map — its key/props
 *  don't change for unchanged rows, so React skips it and this memo skips the expensive ReactMarkdown
 *  parse entirely. The custom comparator also short-circuits on stable refs (markdownComponents,
 *  handlers) so an AI-mode stream only touches the live row. */
const MessageRowContent = React.memo(function MessageRowContent({
  msg, isBlocked, onSendMessage, onDirectCommand, onSwitchToProject, aiMode,
  knownDevUrls, markdownComponents, onDidYouMeanPick,
}: {
  msg: TerminalMessage;
  isBlocked: boolean;
  onSendMessage: (m: string) => void;
  onDirectCommand?: (c: string) => void;
  onSwitchToProject?: (p: string) => void;
  aiMode: string;
  knownDevUrls: string[];
  markdownComponents: any;
  onDidYouMeanPick?: (intent: string) => void;
}) {
  if (msg.type === 'output') {
    return <OutputBlock content={msg.content} autoExpand={msg.autoExpand} />;
  }
  const tel = splitTelemetry(msg.content);
  const linkUrl = msg.type !== 'user' ? extractUrl(tel.body) : null;
  // Only real dev-server sites get the chip — the server_url/processes sources in
  // knownDevUrls are the console's ground truth for "this is the site link" (an
  // Ollama error message used to qualify just because it contained an http URL).
  const isKnownDevUrl = !!linkUrl && knownDevUrls.some(u =>
    u.replace(/\/$/, '').toLowerCase() === linkUrl.replace(/\/$/, '').toLowerCase()
  );
  return (
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

      {isKnownDevUrl && (
        <a
          href={linkUrl!}
          target="_blank"
          rel="noreferrer"
          title={linkUrl!}
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

      {msg.didYouMean && (onDidYouMeanPick as any) && (
        <div className="mt-3 pt-3 border-t border-border-soft">
          <p className="text-xs text-fg-dim mb-2">DID YOU MEAN:</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                if (!isBlocked) (onDidYouMeanPick as any)(msg.didYouMean!.intent);
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
  );
}, (prev, next) => (
  prev.msg === next.msg
  && prev.markdownComponents === next.markdownComponents
  && prev.isBlocked === next.isBlocked
  && prev.knownDevUrls === next.knownDevUrls
  && prev.onSendMessage === next.onSendMessage
  && prev.onDirectCommand === next.onDirectCommand
  && prev.onSwitchToProject === next.onSwitchToProject
  && prev.aiMode === next.aiMode
  && (prev as any).onDidYouMeanPick === (next as any).onDidYouMeanPick
));

/** The scrollable message thread: chat bubbles (markdown/JSON/output), inline confirm
 * cards, the scroll anchor, and the AI/trigger-mode busy indicators. */
const TerminalMessagesComponent = ({
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
  knownDevUrls,
}: TerminalMessagesProps) => {
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

  // Auto-scroll to the newest message ONLY while the user is already at (or near) the bottom
  // of the thread — scrolling up to re-read something must not be yanked back down by new
  // output (M6/M22). The container owns both the scroll events and the anchor, so this lives
  // here instead of Terminal.tsx.
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const handleContainerScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useEffect(() => {
    if (atBottomRef.current) {
      // M22: during an active AI token stream the server pushes a new `messages` array
      // reference per token (wsStreamingCases appends via prev.map), so this effect re-fires
      // every ~16ms. With `behavior: 'smooth'` that produces visible scroll-jank; jump
      // instantly (`auto`) only while streaming, and keep the smooth, pleasant scroll for
      // the natural cadence of discrete user/system/error message arrivals.
      endRef.current?.scrollIntoView({ behavior: aiThinking ? 'auto' : 'smooth' });
    }
  }, [messages, pendingConfirm, pendingToolConfirm, pendingMemorySuggestion, endRef]);

  return (
    <div ref={containerRef} onScroll={handleContainerScroll} className="flex-1 overflow-y-auto p-4">
      {messages.length === 0 ? (
        <div className={`${centerCol} min-h-full flex flex-col items-center justify-center`}>
          <TerminalEmptyState greeting={emptyStatePrompt} actions={emptyStateActions} onAction={onSendMessage} />
        </div>
      ) : (
      <div className={`${centerCol} space-y-3`}>
      <AnimatePresence initial={false}>
      {messages.map((msg, i) => {
        const rowClass = msg.type === 'output'
          ? 'flex flex-col items-start max-w-[85%]'
          : `flex flex-col ${msg.type === 'user' ? 'items-end' : 'items-start'}`;
        return (
          // M23: boundary per row (not whole-thread) so a single bad render is contained.
          <RowErrorBoundary
            key={msg.id || i}
            resetKeys={[msg.id || i]}
            fallback={
              <div
                className={`${rowClass} px-3 py-2 text-xs text-red-400/80 bg-red-500/5 border border-red-500/20 rounded-lg`}
              >
                <AlertTriangle size={12} className="inline-block mr-1" />
                Couldn't render this message — malformed or removed.
              </div>
            }
          >
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={rowClass}
            >
              <MessageRowContent
                msg={msg}
                isBlocked={isBlocked}
                onSendMessage={onSendMessage}
                onDirectCommand={onDirectCommand}
                onSwitchToProject={onSwitchToProject}
                onDidYouMeanPick={onDidYouMeanPick}
                aiMode={aiMode}
                knownDevUrls={knownDevUrls}
                markdownComponents={markdownComponents}
              />
            </motion.div>
          </RowErrorBoundary>
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

      {/* Gate on aiThinking OR aiThinkingText: stream_start (which the server sends before
          the model's thinking phase) clears aiThinking, so a reasoning trace that only ever
          accumulated AFTER that event never rendered — the panel was hidden the entire time
          the model was deliberating (audit 2026-08-06, Phase 3). The trace is cleared by the
          turn's final 'end', so the panel can't linger after the turn either. */}
      {(aiThinking || aiThinkingText) && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3 text-teal-400/60 text-xs">
            <Loader2 size={14} className="animate-spin" />
            AI is thinking...
            {/* M16: a live cancel affordance exists while any turn is in flight. */}
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
          {/* The server separates a reasoning model's internal deliberation (Ollama's `message.thinking`)
              from its real answer and streams the former as its own 'thinking' event; previously the
              spinner above was the only signal anything was happening. Capped height + scroll so a long
              reasoning trace doesn't push the input bar off-screen; only rendered once there's text. */}
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
};

export const TerminalMessages = React.memo(TerminalMessagesComponent);
