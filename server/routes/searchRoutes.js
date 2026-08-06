import { webSearch, deepResearch } from '../webSearch.js';
import { checkOllama, listModels, listCloudModels, startOllama, pullModel, findOllamaBinary, checkOnline } from '../ollama.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerSearchRoutes(app) {
  // Express's default extended query parser turns ?q=a&q=b into an array and ?q[x]=1 into an
  // object — a raw .trim() on those used to throw inside an unwrapped async handler, and the
  // rejection was swallowed by the process-level guard, leaving the request pending forever
  // (audit 2026-08-06, Phase 2). Normalize to a string; asyncHandler turns any other
  // rejection into a 500 instead of a hang.
  app.get('/api/search', asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return res.status(400).json({ error: 'Query too short' });
    const results = await webSearch(q);
    res.json(results);
  }));

  app.get('/api/deep-research', asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return res.status(400).json({ error: 'Query too short' });
    const result = await deepResearch(q);
    res.json(result);
  }));

  app.get('/api/ollama/status', async (req, res) => {
    const running = await checkOllama();
    const models = running ? await listModels() : [];
    // Cloud models are listed regardless of whether the local daemon is running elsewhere on
    // this machine's PATH — the picker should still let the user try to switch to cloud even if
    // the local server needs a `ollama serve` kick first (selecting a model doesn't require
    // `running` to already be true, only sending a chat message does).
    const cloudModels = await listCloudModels();
    const internetReachable = await checkOnline();
    const binary = findOllamaBinary();
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    res.json({ running, models, cloudModels, internetReachable, binaryFound: !!binary, host });
  });

  app.post('/api/ollama/start', async (req, res) => {
    const started = await startOllama();
    if (started) {
      const models = await listModels();
      res.json({ success: true, running: true, models });
    } else {
      const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
      const binary = findOllamaBinary();
      if (host !== 'http://localhost:11434') {
        res.json({ success: false, running: false, error: `Could not reach Ollama at ${host}. Make sure your remote server is running and accessible.` });
      } else if (binary) {
        res.json({ success: false, running: false, error: 'Ollama binary found but failed to start. Try launching Ollama manually from the Start menu.' });
      } else {
        res.json({ success: false, running: false, error: 'Ollama not found. Set OLLAMA_HOST to a remote server URL, or install Ollama locally from ollama.com.' });
      }
    }
  });

  app.post('/api/ollama/pull', asyncHandler(async (req, res) => {
    const { model } = req.body || {};
    const modelName = model || 'qwen2.5-coder:7b';

    // Set SSE headers for streaming pull progress
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    // A client that closes the tab mid-pull makes the next res.write() emit 'error' on the
    // response — with no listener that used to surface as an uncaughtException (audit
    // 2026-08-06, Phase 2).
    res.on('error', () => {});

    try {
      await pullModel(modelName, (chunk) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', text: chunk })}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ type: 'done', success: true, message: `Model ${modelName} pulled successfully` })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: err.message })}\n\n`);
    }
    res.end();
  }));
}
