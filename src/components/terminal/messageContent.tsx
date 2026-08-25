// The per-row message content renderer (2026-08-24, split out of TerminalMessages.tsx):
// one chat row's bubble / output block / suggestion chips. Memoized so a 16ms token update
// only re-renders the row whose message object changed (M21) — the custom comparator
// short-circuits on stable refs (markdownComponents, handlers) so an AI-mode stream only
// touches the live row.

import React from 'react';
import type { TerminalMessage } from '../../types';
import ReactMarkdown from 'react-markdown';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { OutputBlock } from '../TerminalOutputBlock';

/** The server appends a performance note to the end of streamed AI replies (see
 *  server/ollama.js chatStream): `\n\n_(2.0s, 9 tok/s)_`. Strip it from the rendered
 *  markdown and surface it as a muted footer below the response block instead. */
const TELEMETRY_RE = /\n\n_\(([\d.]+s, \d+ tok\/s)\)_$/;
export function splitTelemetry(content: string): { body: string; meta: string | null } {
  const m = content.match(TELEMETRY_RE);
  if (!m) return { body: content, meta: null };
  return { body: content.slice(0, content.length - m[0].length), meta: m[1] };
}

/** First http(s) URL in a message, trailing punctuation trimmed (Phase 15: "what is the
 *  link"-style answers embed bare URLs that react-markdown never autolinks — they get a
 *  dedicated "click here" anchor below the bubble instead). */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>()[\]"'`]+/);
  if (!m) return null;
  // Strip trailing punctuation AND markdown emphasis (`**bold**` URLs end with `**` — an
  // href containing those is an invalid URL and browsers land on about:blank#blocked).
  return m[0].replace(/[*_.,;:!?]+$/, '');
}

export const MessageRowContent = React.memo(function MessageRowContent({
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
          ? 'bg-accent-blue text-white rounded-br-none'
          : msg.type === 'error'
          ? 'bg-accent-red/10 border border-accent-red/20 text-accent-red rounded-bl-none font-mono text-sm'
          : msg.type === 'warning'
          ? 'bg-accent-orange/10 border border-accent-orange/30 text-accent-orange rounded-bl-none'
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
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent-teal/10 border border-accent-teal/30 text-xs text-accent-teal hover:bg-accent-teal/20 transition-colors"
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
                className="px-3 py-1 rounded-full bg-panel hover:bg-panel-strong border border-border-faint hover:border-accent-blue text-xs text-accent-teal transition-colors"
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
              className="px-3 py-1 rounded-full bg-panel hover:bg-panel-strong border border-border-faint hover:border-accent-blue text-xs text-accent-teal transition-colors"
            >
              {msg.didYouMean.label || msg.didYouMean.intent}
            </button>
          </div>
        </div>
      )}

      {msg.switchProjectAction && onSwitchToProject && (
        <div className="mt-3 pt-3 border-t border-accent-red/20">
          <button
            onClick={() => onSwitchToProject(msg.switchProjectAction!.projectId)}
            className="px-3 py-1.5 rounded-lg bg-accent-red/10 hover:bg-accent-red/20 border border-accent-red/30 text-xs text-accent-red transition-colors"
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