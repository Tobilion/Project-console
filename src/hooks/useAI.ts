import { useRef, useState } from 'react';
import { AIStatus, TerminalMessage } from '../types';
import { makeMessage } from '../utils/makeMessage';

export function useAI(sendWS: (data: object) => void, setMessages: React.Dispatch<React.SetStateAction<TerminalMessage[]>>) {
  const [aiEnabled, setAiEnabled] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<AIStatus | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  // Requested directly (2026-07-30): the server already separates a reasoning model's internal
  // deliberation (Ollama's `message.thinking`) from its actual answer and streams the former as
  // its own 'thinking' WS event (see ollama.js/aiStream.js) — this used to arrive and be silently
  // dropped client-side, so the busy spinner was the only signal anything was happening, with no
  // visibility into what the model was actually doing. Accumulates the raw reasoning text for the
  // current in-flight query; cleared whenever a new query starts or the real answer begins
  // streaming (stream_start), since thinking is done being useful once the answer itself arrives.
  const [aiThinkingText, setAiThinkingText] = useState('');
  const [aiModel, setAiModel] = useState('qwen2.5-coder:7b');
  const [aiMode, setAiMode] = useState('default');
  // In-flight guard for the AI toggle: the ON path is async (Ollama status fetch + possible
  // model auto-pick), and rapid re-clicks used to run it several times over — each success
  // appended its own "AI Assistant activated" banner (seen 3x in a real exported NetPulse chat).
  const toggleBusyRef = useRef(false);

  const fetchOllamaStatus = async () => {
    try {
      const res = await fetch('/api/ollama/status');
      const status = await res.json();
      setOllamaStatus(status);
      return status;
    } catch {
      setOllamaStatus(null);
      return null;
    }
  };

  const handleAIToggle = async () => {
    if (toggleBusyRef.current) return;
    toggleBusyRef.current = true;
    try {
      const newState = !aiEnabled;

      if (!newState) {
        sendWS({ type: 'ai_toggle', payload: { enabled: false } });
        setAiEnabled(false);
        setMessages(prev => [...prev, makeMessage('system', 'AI Assistant deactivated — returning to trigger mode.')]);
        return;
      }

      const status = await fetchOllamaStatus();

      // Detection order, per how AI ON should behave:
      //   1. Is the machine online at all?
      //   2. If so, is an online (Ollama Cloud) model reachable? Prefer that.
      //   3. If not (offline, or cloud unreachable), is Ollama available locally?
      //   4. If neither online nor local works, AI mode fails with a concrete reason.
      // Note: Ollama Cloud models still proxy through the *local* `ollama serve` daemon (same
      // /api/chat endpoint, just a ":cloud" tag) — so `status.running` is a shared prerequisite
      // for both paths, not just the local one. If the daemon itself isn't reachable, neither
      // source can work regardless of internet.
      if (!status || !status.running) {
        const host = status?.host || 'http://localhost:11434';
        const errorMsg = host !== 'http://localhost:11434'
          ? `Could not reach Ollama at ${host}. Make sure your remote server is running and accessible.`
          : `Ollama isn't running at ${host}, so neither local nor online (Ollama Cloud) AI mode can start. To use AI mode:\n\n` +
            `1. Install Ollama from ollama.com and make sure it's running, OR\n` +
            `2. Set OLLAMA_HOST to a remote server URL (e.g., OLLAMA_HOST=https://my-server.com:11434)\n\n` +
            `Then toggle AI ON again.`;
        setAiEnabled(false);
        setMessages(prev => [...prev, { id: Date.now().toString(), type: 'error', content: errorMsg }]);
        return;
      }

      const onlineAvailable = !!status.internetReachable && (status.cloudModels?.length ?? 0) > 0;
      const localAvailable = (status.models?.length ?? 0) > 0;

      if (!onlineAvailable && !localAvailable) {
        setAiEnabled(false);
        const reason = status.internetReachable
          ? 'no internet connection was detected'
          : 'no local models are installed and no internet connection was detected';
        setMessages(prev => [...prev, makeMessage(
          'error',
          `AI mode can't start: ${reason}. Pull a local model (e.g. "ollama pull qwen2.5-coder:7b"), or connect to the internet and run "ollama signin" to use Ollama Cloud, then toggle AI ON again.`
        )]);
        return;
      }

      // Respect a model the user already deliberately picked (local or cloud), even across
      // toggling AI off/on — only fall back to an auto-pick when the current one is invalid.
      const modelStillValid = status.models?.some((m: any) => {
        const name = typeof m === 'string' ? m : m.name;
        return name === aiModel;
      }) || status.cloudModels?.some((m: any) => m.name === aiModel);

      let activeModel = aiModel;
      let source: 'cloud' | 'local' = status.cloudModels?.some((m: any) => m.name === aiModel) ? 'cloud' : 'local';

      if (!modelStillValid) {
        if (onlineAvailable) {
          activeModel = status.cloudModels![0].name;
          source = 'cloud';
        } else {
          const first = status.models[0];
          activeModel = typeof first === 'string' ? first : first.name;
          source = 'local';
        }
        setAiModel(activeModel);
        sendWS({ type: 'ai_set_model', payload: { model: activeModel } });
      }

      sendWS({ type: 'ai_toggle', payload: { enabled: true } });
      setAiEnabled(true);
      setMessages(prev => [...prev, makeMessage(
        'system',
        `AI Assistant activated — using ${source === 'cloud' ? '🌐 Ollama Cloud' : 'local'} model: ${activeModel}. Switch between local and cloud anytime via the model picker.`
      )]);
    } finally {
      toggleBusyRef.current = false;
    }
  };

  const handlePullModel = async (modelName: string) => {
    const msgId = Date.now().toString();
    setMessages(prev => [...prev, makeMessage('system', `Downloading ${modelName}...\n`, { id: msgId })]);
    try {
      const pullRes = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName })
      });
      const reader = pullRes.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          for (const line of text.split('\n').filter(l => l.startsWith('data: '))) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'done') {
                if (data.success) {
                 setMessages(prev => [...prev, makeMessage('system', `✅ ${data.message}`)]);
                   fetchOllamaStatus();
                   setAiModel(modelName);
                   sendWS({ type: 'ai_set_model', payload: { model: modelName } });
                 } else {
                   setMessages(prev => [...prev, makeMessage('error', `Failed: ${data.error}`)]);
                }
              }
            } catch {}
          }
        }
      }
     } catch (err: any) {
       setMessages(prev => [...prev, makeMessage('error', `Pull failed: ${err.message}`)]);
    }
  };

  const handleSetModel = (model: string) => {
    sendWS({ type: 'ai_set_model', payload: { model } });
    setAiModel(model);
  };

  const handleSetMode = (mode: string) => {
    sendWS({ type: 'ai_set_model', payload: { mode } });
    setAiMode(mode);
  };

  return {
    aiEnabled, setAiEnabled, ollamaStatus, aiThinking, setAiThinking,
    aiThinkingText, setAiThinkingText,
    aiModel, setAiModel, aiMode, setAiMode,
    fetchOllamaStatus, handleAIToggle, handlePullModel, handleSetModel, handleSetMode,
  };
}
