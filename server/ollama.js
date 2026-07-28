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

// Ollama Cloud (":cloud"-suffixed models, e.g. "qwen3-coder-480b:cloud") run on Ollama's own
// GPUs instead of the local machine, but go through the exact same local `ollama serve` daemon
// and the exact same /api/chat endpoint used by chatStream() below — the daemon detects the
// ":cloud" suffix and proxies the request once the user has run `ollama signin` and has an
// internet connection. There is no separate API key or provider integration: this is still
// "just Ollama," which is why it's the natural online fallback for this app rather than wiring
// up a real Anthropic/OpenAI client. Curated list below is the catalog as of mid-2026 (ollama.com
// adds/retires cloud models over time — this is a best-effort seed list, not an exhaustive
// registry browse, since Ollama doesn't expose a "list available cloud models" API).
export const CLOUD_MODELS = [
  { name: 'qwen3-coder-480b:cloud', label: 'Qwen3 Coder 480B (cloud)' },
  { name: 'kimi-k2.6:cloud', label: 'Kimi K2.6 (cloud)' },
  { name: 'deepseek-v4-pro:cloud', label: 'DeepSeek V4 Pro (cloud)' },
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

export async function* chatStream(model, messages, signal, hostOverride) {
  const host = hostOverride || OLLAMA_HOST;
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: NUM_CTX } }),
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
            yield `\n\n_(${(json.total_duration / 1e9).toFixed(1)}s, ${(json.eval_count / (json.total_duration / 1e9)).toFixed(0)} tok/s)_`;
          }
          return;
        }
        if (json.message?.content) yield json.message.content;
      } catch {}
    }
  }
}
