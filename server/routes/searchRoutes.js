import { webSearch, deepResearch } from '../webSearch.js';
import { checkOllama, listModels, listCloudModels, startOllama, pullModel, findOllamaBinary, checkOnline } from '../ollama.js';

export function registerSearchRoutes(app) {
  app.get('/api/search', async (req, res) => {
    const q = req.query.q;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query too short' });
    const results = await webSearch(q.trim());
    res.json(results);
  });

  app.get('/api/deep-research', async (req, res) => {
    const q = req.query.q;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query too short' });
    const result = await deepResearch(q.trim());
    res.json(result);
  });

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

  app.post('/api/ollama/pull', async (req, res) => {
    const { model } = req.body || {};
    const modelName = model || 'qwen2.5-coder:7b';

    // Set SSE headers for streaming pull progress
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      await pullModel(modelName, (chunk) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', text: chunk })}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ type: 'done', success: true, message: `Model ${modelName} pulled successfully` })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: err.message })}\n\n`);
    }
    res.end();
  });
}
