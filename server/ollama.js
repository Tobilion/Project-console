import { spawn, execSync } from 'child_process';
import fs from 'fs';

// Allow user to point at a remote Ollama server via env var
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

// Context window sent to Ollama per request.
const NUM_CTX = parseInt(process.env.OLLAMA_NUM_CTX, 10) || 16384;

export function findOllamaBinary() {
  const candidates = [
    'ollama',
    'C:\\Program Files\\Ollama\\ollama.exe',
    'C:\\Program Files (x86)\\Ollama\\ollama.exe',
    `${process.env.LOCALAPPDATA || ''}\\Ollama\\ollama.exe`,
    `${process.env.USERPROFILE || ''}\\AppData\\Local\\Ollama\\ollama.exe`,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (candidate === 'ollama') {
        execSync('ollama --version', { stdio: 'ignore', timeout: 3000 });
        return 'ollama';
      }
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

export async function checkOllama(hostOverride) {
  const host = hostOverride || OLLAMA_HOST;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkOnline() {
  try {
    await fetch('https://ollama.com', { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

export async function startOllama() {
  const alreadyRunning = await checkOllama();
  if (alreadyRunning) return true;

  const binary = findOllamaBinary();
  if (!binary) return false;

  try {
    spawn(binary, ['serve'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await checkOllama()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function pullModel(modelName, onChunk) {
  const binary = findOllamaBinary();
  if (!binary) throw new Error('Ollama binary not found. Install from ollama.com/download/windows');

  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ['pull', modelName], { shell: true });

    let lastLine = '';
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      lastLine = text.trim();
      if (onChunk) onChunk(text);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      if (onChunk) onChunk(text);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: `Model ${modelName} pulled successfully` });
      } else {
        reject(new Error(`ollama pull failed (exit ${code}): ${lastLine}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ollama pull: ${err.message}`));
    });
  });
}

export async function listModels(hostOverride) {
  const host = hostOverride || OLLAMA_HOST;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => ({ name: m.name, size: m.size, modified: m.modified_at }));
  } catch {
    return [];
  }
}

// Ollama Cloud (":cloud"-suffixed models, e.g. "kimi-k2.6:cloud") run on Ollama's own
// GPUs instead of the local machine, but go through the exact same local `ollama serve` daemon
// and the exact same /api/chat endpoint used by chatStream() below — the daemon detects the
// ":cloud" suffix and proxies the request once the user has run `ollama signin` and has an
// internet connection. There is no separate API key or provider integration: this is still
// "just Ollama," which is why it's the natural online fallback for this app rather than wiring
// up a real Anthropic/OpenAI client. Curated list below is a best-effort seed list, not an
// exhaustive registry browse, since Ollama doesn't expose a "list available cloud models" API —
// the full current catalog is at ollama.com/search?c=cloud and DOES drift over time (models get
// added/retired), so a name here can go stale and start 404ing even though sign-in is fine.
// Confirmed live 2026-07-29: "qwen3-coder-480b:cloud" and "deepseek-v4-pro:cloud" (the previous
// entries here) returned a plain "404 Not Found" from Ollama's own cloud endpoint despite correct
// sign-in — those tags no longer resolve to anything in Ollama's catalog. Swapped for tags
// verified against the live catalog as of this date. If a 404 recurs on one of these, it means
// Ollama has retired/renamed it again — check ollama.com/search?c=cloud and update this list
// rather than assuming it's a sign-in/auth problem.
export const CLOUD_MODELS = [
  { name: 'qwen3.5:cloud', label: 'Qwen3.5 (cloud)' },
  { name: 'kimi-k2.6:cloud', label: 'Kimi K2.6 (cloud)' },
  { name: 'deepseek-v4-flash:cloud', label: 'DeepSeek V4 Flash (cloud)' },
  { name: 'minimax-m3:cloud', label: 'MiniMax M3 (cloud)' },
  { name: 'gpt-oss:120b-cloud', label: 'GPT-OSS 120B (cloud)' },
];

/** Merge the curated catalog with any ":cloud" models already pulled/used locally (dedupe by name). */
export async function listCloudModels(hostOverride) {
  const local = await listModels(hostOverride);
  const alreadyKnown = new Set(CLOUD_MODELS.map(m => m.name));
  const extraLocalCloud = local
    .filter(m => m.name.endsWith(':cloud') && !alreadyKnown.has(m.name))
    .map(m => ({ name: m.name, label: m.name }));
  return [...CLOUD_MODELS, ...extraLocalCloud];
}

export async function getModelInfo(modelName, hostOverride) {
  const host = hostOverride || OLLAMA_HOST;
  try {
    const res = await fetch(`${host}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * One bounded, non-streaming /api/chat call — used by the local-router tier (server/localRouter.js)
 * for its single classify+extract call. Deliberately not `chatStream()`: the router needs one
 * short blocking response to parse as JSON, not a token stream, and wants its own low
 * temperature/num_predict regardless of whatever the user's full-AI-mode chat is configured with.
 * Caller is expected to pass an AbortSignal.timeout(...) so a stalled/unreachable Ollama can't
 * block the trigger-mode fallback chain — on any failure this throws and the caller falls through
 * to today's existing behavior.
 */
export async function chatOnce(model, messages, options = {}, signal, hostOverride) {
  const host = hostOverride || OLLAMA_HOST;
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      // See chatStream()'s comment below — same reasoning/content split, requested here too so a
      // reasoning-capable model's router classification doesn't get its "thinking" text mixed
      // into the one short response this call parses.
      think: true,
      options: {
        num_ctx: NUM_CTX,
        temperature: options.temperature ?? 0,
        num_predict: options.num_predict ?? 200,
      },
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Ollama error (${res.status}): ${res.statusText}`);
  }
  const data = await res.json();
  return data.message?.content || '';
}

/**
 * Streams a chat completion, yielding `{ type: 'content' | 'thinking', text }` chunks.
 *
 * Requests `think: true` so Ollama splits a reasoning-capable model's internal deliberation
 * (`message.thinking`) from its actual answer (`message.content`) instead of the two being
 * indistinguishable. Confirmed live 2026-07-29: without this, a thinking model (GPT-OSS,
 * Qwen3.5, etc.) could stream its raw reasoning ("We need to call getGitStatus.") straight
 * through as if it were the final reply — this app had no way to tell "still thinking" apart
 * from "done answering," so it just showed whatever text arrived and closed the turn the moment
 * Ollama reported `done`. `think: true` is safe to always send: a model that doesn't support
 * thinking simply never populates `message.thinking`, so this is fully backward compatible with
 * plain (non-reasoning) local models — every chunk just comes through as `type: 'content'` like
 * before. Callers (see aiStream.js) are responsible for only treating `content` chunks as the
 * real answer / scanning them for `<tool_call>` blocks; `thinking` chunks are reasoning-only and
 * must never be mistaken for a finished response.
 */
export async function* chatStream(model, messages, signal, hostOverride) {
  const host = hostOverride || OLLAMA_HOST;
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, think: true, options: { num_ctx: NUM_CTX } }),
    signal
  });

  if (!res.ok) {
    throw new Error(`Ollama error (${res.status}): ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (json.done) {
          if (json.total_duration) {
            yield { type: 'content', text: `\n\n_(${(json.total_duration / 1e9).toFixed(1)}s, ${(json.eval_count / (json.total_duration / 1e9)).toFixed(0)} tok/s)_` };
          }
          return;
        }
        if (json.message?.thinking) yield { type: 'thinking', text: json.message.thinking };
        if (json.message?.content) yield { type: 'content', text: json.message.content };
      } catch {}
    }
  }
}
