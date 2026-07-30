import { chatStream } from '../ollama.js';

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';
// How much of the tail of the "safe" buffer to hold back at all times, in case it's the
// start of a split '<tool_call>' marker that hasn't fully arrived yet.
const MARKER_MARGIN = OPEN_TAG.length - 1;

/**
 * Streams a chat completion from Ollama, sending live `token` events to the client for
 * plain text while transparently buffering and extracting any `<tool_call>{...}</tool_call>`
 * blocks (so the user never sees raw tool-call JSON flash by). Returns the full visible text
 * and any parsed tool calls once the stream ends.
 *
 * `chatStream()` now yields `{ type: 'content' | 'thinking', text }` (see ollama.js) — only
 * `content` chunks are fed into the buffer/tool-call detection below. `thinking` chunks (a
 * reasoning model's internal deliberation, e.g. "We need to call getGitStatus.") are
 * deliberately dropped here rather than shown or scanned: confirmed live 2026-07-29, a model's
 * raw reasoning used to be indistinguishable from its actual answer and could stream through as
 * if it were the final reply, with no tool call ever actually made. Sent as a `thinking` WS event
 * instead of silently discarded, so the frontend has the option to surface it later (e.g. a
 * "thinking…" indicator) without that ever being possible to confuse with real answer text.
 */
export async function streamWithToolDetection(model, messages, ws, signal) {
  let buffer = '';
  let visible = '';
  let inToolCall = false;
  let toolCallBuffer = '';
  const toolCalls = [];

  const flushText = (text) => {
    if (!text) return;
    visible += text;
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'token', data: text }));
  };

  const processBuffer = () => {
    // Drain as much of `buffer` as we can safely resolve into either visible text or a
    // completed tool call, leaving only an undecided tail (e.g. a partial marker) behind.
    for (;;) {
      if (!inToolCall) {
        const openIdx = buffer.indexOf(OPEN_TAG);
        if (openIdx === -1) {
          const safeLen = Math.max(0, buffer.length - MARKER_MARGIN);
          if (safeLen === 0) return;
          flushText(buffer.slice(0, safeLen));
          buffer = buffer.slice(safeLen);
          return;
        }
        flushText(buffer.slice(0, openIdx));
        buffer = buffer.slice(openIdx + OPEN_TAG.length);
        inToolCall = true;
        toolCallBuffer = '';
        // loop again in case the close tag is already in the remaining buffer
      } else {
        const closeIdx = buffer.indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          toolCallBuffer += buffer;
          buffer = '';
          return;
        }
        toolCallBuffer += buffer.slice(0, closeIdx);
        buffer = buffer.slice(closeIdx + CLOSE_TAG.length);
        inToolCall = false;
        try {
          const call = JSON.parse(toolCallBuffer.trim());
          if (call?.tool) toolCalls.push({ tool: call.tool, args: call.args || {} });
        } catch {
          // Malformed tool call JSON — drop it silently rather than surfacing raw JSON to the user.
        }
        toolCallBuffer = '';
        // loop again in case there's more content (text or another tool call) after this one
      }
    }
  };

  for await (const chunk of chatStream(model, messages, signal)) {
    if (chunk.type === 'thinking') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'thinking', data: chunk.text }));
      continue;
    }
    buffer += chunk.text;
    processBuffer();
  }

  // Flush whatever safe text remains (won't include an unterminated tool call — if the
  // model cut off mid tool-call, we simply drop that trailing fragment).
  if (!inToolCall && buffer) flushText(buffer);

  return { visibleText: visible, toolCalls };
}

/** Plain streaming pass with no tool-call parsing — used for the post-tool follow-up answer.
 *  Same content/thinking split as streamWithToolDetection above — only content chunks count as
 *  the visible answer. */
export async function streamPlain(model, messages, ws, signal) {
  let visible = '';
  for await (const chunk of chatStream(model, messages, signal)) {
    if (chunk.type === 'thinking') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'thinking', data: chunk.text }));
      continue;
    }
    visible += chunk.text;
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'token', data: chunk.text }));
  }
  return visible;
}
