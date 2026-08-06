import type { WsCtx, WsCaseHandler } from './wsCtx';
import { makeId } from './wsCtx';

/**
 * The token-streaming trio (stream_start / token / stream_end) — the AI-mode chat-stream
 * machinery extracted verbatim from useConsole.ts's handleWebSocketMessage switch. Owns the
 * token buffer + 16ms flush timer and the wsRef._streamId bookkeeping. The flush timer
 * captures ctx values at event time (safe: every member it uses — wsRef, stream refs,
 * setMessages — is stable across renders).
 */

export const streamStartCase: WsCaseHandler = (ctx, payload) => {
  const id = makeId();
  ctx.ai.setAiThinking(false);
  ctx.ai.setAiThinkingText('');
  if (ctx.wsRef.current) (ctx.wsRef.current as any)._streamId = id;
  ctx.sessions.setMessages(prev => [...prev, { id, type: 'bot', content: '', isMarkdown: true, streaming: true }]);
};

export const tokenCase: WsCaseHandler = (ctx, payload) => {
  const streamId = ctx.wsRef.current ? (ctx.wsRef.current as any)._streamId : null;
  if (!streamId || !payload.data) return;
  ctx.stream.streamHadTokenRef.current = true;
  ctx.stream.tokenBuffer.current += payload.data;
  if (!ctx.stream.flushTimer.current) {
    ctx.stream.flushTimer.current = setTimeout(() => {
      const content = ctx.stream.tokenBuffer.current;
      ctx.stream.tokenBuffer.current = '';
      ctx.stream.flushTimer.current = null;
      // Check that the stream ID hasn't changed (guards against race where
      // stream_end cleared _streamId between when this timeout was scheduled
      // and when it fires).
      const currentStreamId = ctx.wsRef.current ? (ctx.wsRef.current as any)._streamId : null;
      if (currentStreamId !== streamId) return;
      ctx.sessions.setMessages(prev => prev.map(m => m.id === streamId ? { ...m, content: m.content + content } : m));
    }, 16);
  }
};

export const streamEndCase: WsCaseHandler = (ctx, payload) => {
  // Flush any buffered tokens before clearing stream ID
  const streamId = ctx.wsRef.current ? (ctx.wsRef.current as any)._streamId : null;
  if (ctx.stream.tokenBuffer.current && streamId) {
    const content = ctx.stream.tokenBuffer.current;
    ctx.stream.tokenBuffer.current = '';
    if (ctx.stream.flushTimer.current) { clearTimeout(ctx.stream.flushTimer.current); ctx.stream.flushTimer.current = null; }
    ctx.sessions.setMessages(prev => prev.map(m => m.id === streamId ? { ...m, content: m.content + content } : m));
  }
  if (ctx.wsRef.current) (ctx.wsRef.current as any)._streamId = null;
  // NOTE: aiQueryInFlight is deliberately NOT cleared here — a stream_end fires after EVERY
  // answer round of a multi-round tool-call turn, so clearing here dropped the auto-expand
  // flag mid-turn and output blocks created by later tool rounds collapsed again (audit
  // 2026-08-06, Phase 3). The turn's own final data-less 'end' clears it (streamOutputCase).
  // The placeholder bot message opened by stream_start carries `streaming: true` and was
  // never cleared on stream_end. If the stream produced zero tokens at all, that message
  // would otherwise stay as an empty bubble (real NetPulse transcript bug) — replace it
  // with an honest fallback so a silent AI completion is never invisible.
  if (streamId) {
    ctx.sessions.setMessages(prev => prev.map(m => {
      if (m.id !== streamId) return m;
      return {
        ...m,
        streaming: false,
        content: !m.content.trim() ? '(AI returned no response — try rephrasing your request.)' : m.content,
      };
    }));
  }
  ctx.stream.streamHadTokenRef.current = false;
};

export const WS_STREAMING_CASES: Record<string, WsCaseHandler> = {
  stream_start: streamStartCase,
  token: tokenCase,
  stream_end: streamEndCase,
};
