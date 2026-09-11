import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { getTuning } from './tuningStore.js';

// Allow user to point at a remote Ollama server via env var
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

// Phase 8 (2026-08-11): exported for the health-check admin command so it can probe the same
// daemon the chat path talks to, rather than hardcoding a second default.
export function getOllamaHost() {
  return OLLAMA_HOST;
}

// Context window sent to Ollama per request.
const NUM_CTX_ENV_DEFAULT = parseInt(process.env.OLLAMA_NUM_CTX, 10) || 16384;
// Phase B.3 (2026-09-08): OLLAMA_NUM_CTX still sets the boot-time default (unchanged for
// anyone already using it); a tuningStore override — settable live from Settings, no
// restart — wins once one exists. Read at call time, not module load, so a live change
// applies to the next request immediately.
const currentNumCtx = () => getTuning('NUM_CTX', NUM_CTX_ENV_DEFAULT);

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
  // The model name is user-supplied (POST /api/ollama/pull). Validate against a strict charset
  // and never run through a shell — a crafted name must not become shell syntax even if a
  // future caller reintroduces shell:true.
  if (typeof modelName !== 'string' || !/^[\w.:-]+$/.test(modelName)) {
    throw new Error(`Invalid model name: ${modelName}`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ['pull', modelName]);

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

// Ollama Cloud (":cloud"-suffixed models) proxies through the same local `ollama serve`
// daemon and /api/chat endpoint as a local model — no separate API key or provider client,
// just `ollama signin` plus internet. The list below is a best-effort seed (Ollama exposes no
// "list cloud models" API); the real catalog lives at ollama.com/search?c=cloud and drifts, so
// a 404 on one of these tags means it's been retired/renamed there, not a sign-in problem —
// check the catalog and update this list rather than assuming auth is broken.
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
      // Step 5: JSON-schema-constrained decoding for the router tier — passed through ONLY
      // when the caller supplies options.format (today: localRouter.js alone). The AI-chat
      // path never sets it, so full-mode conversation behavior is byte-identical.
      ...(options.format !== undefined ? { format: options.format } : {}),
      // See chatStream()'s comment below — same reasoning/content split, requested here too so a
      // reasoning-capable model's router classification doesn't get its "thinking" text mixed
      // into the one short response this call parses.
      think: true,
      options: {
        num_ctx: currentNumCtx(),
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

// Watchdog bound for the streaming loop: a daemon that accepts the request but never emits
// chunks (hung model load, GPU stall) previously left the turn pending forever, with the busy
// spinner stuck until the user happened to hit Cancel (audit 2026-08-06, Phase 2). Idle-based
// rather than a total cap, because long CPU generations are legitimate; the external signal
// (user cancel) still wins because the abort handler checks it independently.
const STREAM_IDLE_TIMEOUT_ENV_DEFAULT = 120_000;
const currentStreamIdleTimeoutMs = () => getTuning('STREAM_IDLE_TIMEOUT_MS', STREAM_IDLE_TIMEOUT_ENV_DEFAULT);

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
export async function* chatStream(model, messages, signal, hostOverride, extraOptions) {
  const host = hostOverride || OLLAMA_HOST;
  // Internal controller: the external signal (user cancel) forwards into it, and the idle
  // watchdog aborts it with a distinguishing reason. Callers can tell the two apart via the
  // external signal's own `aborted` flag (user cancel) vs `err.reason` (watchdog timeout).
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    const idleMs = currentStreamIdleTimeoutMs();
    idleTimer = setTimeout(
      () => controller.abort(new Error(`Ollama stream stalled (no chunks for ${idleMs / 1000}s)`)),
      idleMs
    );
  };
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  resetIdle();
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, think: true, options: { num_ctx: currentNumCtx(), ...extraOptions } }),
      signal: controller.signal
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
      resetIdle();
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
    // A non-empty tail at end-of-stream means the daemon closed mid-line — NDJSON is always
    // newline-terminated, so this is a truncated response, not a partial chunk. Surface it
    // instead of silently ending the turn with whatever had already streamed.
    if (buffer.trim()) {
      throw new Error('Ollama stream ended mid-line (truncated response)');
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}
