import React, { useMemo, useRef, useEffect, useCallback, ErrorInfo, ReactNode } from 'react';
import { TerminalMessage, PendingToolConfirm, PendingMemorySuggestion } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Square, AlertTriangle } from 'lucide-react';
import { StructuredJsonBlock } from './StructuredJsonBlock';
import { TerminalConfirmCards } from './TerminalConfirmCards';
import { TerminalEmptyState } from './TerminalEmptyState';
import { MessageRowContent } from './terminal/messageContent';

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
  // Confirm cards render inline in the thread when the chat is the active view (the
  // App-level ConfirmCardsOverlay covers the panel/dashboard views where this thread
  // is unmounted â€” see App.tsx).
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
   *  polls) â€” the "Click here to open the site" chip is gated on these so arbitrary links
   *  in messages (e.g. an Ollama endpoint inside an error text) never get one. */
  knownDevUrls: string[];
  /** Phase 6 (2026-08-17): "load earlier" â€” visible while the buffer holds fewer stored
      messages than the session log contains; fetches the previous page and prepends. */
  historyHasMore?: boolean;
  onLoadEarlier?: () => void;
}

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
  historyHasMore,
  onLoadEarlier,
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
  // of the thread â€” scrolling up to re-read something must not be yanked back down by new
  // output (M6/M22). The container owns both the scroll events and the anchor, so this lives
  // here instead of Terminal.tsx.
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastScrolledTailRef = useRef('');
  const handleContainerScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useEffect(() => {
    // Phase 6: gate on the tail's identity+length. Mid-list updates (tool_start status,
    // confirm-card state) rebuild the messages array but leave the tail untouched â€” those
    // must not trigger redundant scrollIntoView calls. A changed tail (new message, or a
    // stream flush that grew the last row) still scrolls exactly as before.
    const last = messages[messages.length - 1];
    const tailKey = last ? `${last.id}:${last.content.length}` : '';
    if (lastScrolledTailRef.current === tailKey) return;
    if (!atBottomRef.current) return;
    lastScrolledTailRef.current = tailKey;
    // M22: during an active AI token stream the server pushes a new `messages` array
    // reference per flush (wsStreamingCases appends via prev.map), so this effect re-fires
    // every ~45ms. With `behavior: 'smooth'` that produces visible scroll-jank; jump
    // instantly (`auto`) only while streaming, and keep the smooth, pleasant scroll for
    // the natural cadence of discrete user/system/error message arrivals.
    endRef.current?.scrollIntoView({ behavior: aiThinking ? 'auto' : 'smooth' });
  }, [messages, pendingConfirm, pendingToolConfirm, pendingMemorySuggestion, endRef, aiThinking]);

  return (
    <div ref={containerRef} onScroll={handleContainerScroll} className="flex-1 overflow-y-auto p-4">
      {messages.length === 0 ? (
        <div className={`${centerCol} min-h-full flex flex-col items-center justify-center`}>
          <TerminalEmptyState greeting={emptyStatePrompt} actions={emptyStateActions} onAction={onSendMessage} />
          {/* An empty thread still needs its confirm cards â€” a confirm-gated action can
              arrive with a fresh session (panel-triggered, then the user comes back here). */}
          <div className="w-full max-w-[85%] mt-4 space-y-3">
            <TerminalConfirmCards
              pendingConfirm={pendingConfirm}
              onConfirm={onConfirm}
              pendingToolConfirm={pendingToolConfirm}
              onToolConfirm={onToolConfirm}
              onApproveTask={onApproveTask}
              pendingMemorySuggestion={pendingMemorySuggestion}
              onMemorySuggestionRespond={onMemorySuggestionRespond}
            />
          </div>
        </div>
      ) : (
      <div className={`${centerCol} space-y-3`}>
      {historyHasMore && (
        // Phase 6: pagination â€” prepending shifts the thread, but the auto-scroll gate keys
        // on the tail's identity+length, so a loaded page never yanks the view.
        <div className="flex justify-center pt-1">
          <button
            onClick={onLoadEarlier}
            className="px-3 py-1.5 text-xs text-fg-dim hover:text-fg-strong bg-scrim-faint hover:bg-panel border border-border-soft rounded-full transition-colors"
            title="Load the previous page of this chat's history"
          >
            Load earlier messages
          </button>
        </div>
      )}
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
                className={`${rowClass} px-3 py-2 text-xs text-accent-red/80 bg-accent-red/5 border border-accent-red/20 rounded-lg`}
              >
                <AlertTriangle size={12} className="inline-block mr-1" />
                Couldn't render this message â€” malformed or removed.
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
          accumulated AFTER that event never rendered â€” the panel was hidden the entire time
          the model was deliberating (audit 2026-08-06, Phase 3). The trace is cleared by the
          turn's final 'end', so the panel can't linger after the turn either. */}
      {(aiThinking || aiThinkingText) && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3 text-accent-teal/60 text-xs">
            <Loader2 size={14} className="animate-spin" />
            AI is thinking...
            {/* M16: a live cancel affordance exists while any turn is in flight. */}
            {onCancel && (
              <button
                onClick={onCancel}
                className="flex items-center gap-1 px-2 py-0.5 rounded border border-accent-red/30 text-accent-red/80 hover:text-accent-red hover:border-accent-red/60 hover:bg-accent-red/10 transition-colors"
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
            <div className="max-h-24 overflow-y-auto text-accent-teal/40 text-xs font-mono italic whitespace-pre-wrap pl-6 border-l border-accent-teal/20">
              {aiThinkingText}
            </div>
          )}
        </motion.div>
      )}

      {/* Trigger-mode busy indicator â€” requested directly after "run the site" gave no visual
          sign the console was still working on a slow-starting command (e.g. a dev server
          still booting), leaving no way to tell "still running" from "silently done". */}
      {commandPending && !aiThinking && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 text-accent-teal/60 text-xs">
          <Loader2 size={14} className="animate-spin" />
          Running...
          {onCancel && (
            <button
              onClick={onCancel}
              className="flex items-center gap-1 px-2 py-0.5 rounded border border-accent-red/30 text-accent-red/80 hover:text-accent-red hover:border-accent-red/60 hover:bg-accent-red/10 transition-colors"
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
