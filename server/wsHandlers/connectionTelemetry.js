import { getIntentStats, suggestThresholds, getThresholdOverrides, setThresholdOverride, removeThresholdOverride, clearTelemetry, autoApplyThresholds, autoApplyThresholdsForAll } from '../intentTelemetry.js';
import { getModelInfo } from '../confidenceModel.js';
import { semanticMatcher } from '../semanticMatcher.js';

// Telemetry/threshold admin commands (handleExecute block F). Returns true when the input was
// one of the telemetry command phrasings and was consumed.
export async function handleTelemetryCommand(ws, project, lowerInput) {
  if (lowerInput === 'telemetry review' || lowerInput === 'check telemetry' || lowerInput === 'telemetry stats') {
    const stats = getIntentStats(project.id);
    if (stats.size === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No telemetry data collected yet. Start using the console to gather matching data.\n' }));
    } else {
      let reply = `**Intent Telemetry for ${project.name}**\n\n`;
      const sorted = [...stats.entries()].sort((a, b) => b[1].matches - a[1].matches);
      for (const [intent, s] of sorted.slice(0, 15)) {
        const stagesStr = Object.entries(s.stages).map(([k, v]) => `${k}:${v}`).join(' ');
        reply += `**${intent}** — ${s.matches} matches, avg ${s.avgConfidence.toFixed(2)}, fp ${(s.falsePositiveRate * 100).toFixed(0)}%\n`;
        reply += `  stages: ${stagesStr}  range: ${s.minConfidence.toFixed(2)}–${s.maxConfidence.toFixed(2)}\n`;
      }
      const modelInfo = getModelInfo();
      reply += modelInfo.trained
        ? `\n**Learned confidence model**: active — trained on ${modelInfo.sampleCount} real accept/reject outcomes, last updated ${new Date(modelInfo.trainedAt).toLocaleString()}. Threshold suggestions below now come from this model instead of the fixed heuristic.\n`
        : `\n**Learned confidence model**: not trained yet — needs ${modelInfo.minRequired}+ real accept/reject outcomes (currently uses the fixed heuristic for suggestions).\n`;
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput === 'telemetry thresholds' || lowerInput === 'list thresholds') {
    const overrides = getThresholdOverrides();
    const active = Object.keys(overrides);
    let reply = active.length
      ? `**Active threshold overrides:**\n${active.map(i => `  ${i}: ${overrides[i].toFixed(2)}`).join('\n')}\n`
      : 'No threshold overrides. All intents use the default 0.6.\n';
    ws.send(JSON.stringify({ type: 'answer', data: reply }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput.startsWith('telemetry suggest') || lowerInput.startsWith('suggest thresholds')) {
    const suggestions = suggestThresholds(project.id);
    if (suggestions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'Not enough telemetry data for threshold suggestions. Need 5+ matches per intent.\n' }));
    } else {
      let reply = `**Threshold adjustment suggestions for ${project.name}**\n`;
      for (const s of suggestions) {
        reply += `\n**${s.intent}**: ${s.currentFloor.toFixed(2)} → ${s.recommendedFloor.toFixed(2)}\n`;
        reply += `  ${s.reason}\n`;
        reply += `  ${s.matchCount} matches, avg ${s.avgConfidence.toFixed(3)}, semantic ${s.semanticRatio} fuzzy ${s.fuzzyRatio} keyword ${s.keywordRatio}\n`;
        reply += `  Apply: \`threshold set ${s.intent} ${s.recommendedFloor}\`\n`;
      }
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput.startsWith('threshold set ')) {
    const rest = lowerInput.replace('threshold set ', '');
    const match = rest.match(/^(.+?)\s+([\d.]+)$/);
    if (match) {
      const intent = match[1].trim();
      const floor = parseFloat(match[2]);
      if (floor >= 0 && floor <= 1) {
        setThresholdOverride(intent, floor);
        ws.send(JSON.stringify({ type: 'answer', data: `Set threshold for **${intent}** to ${floor.toFixed(2)}.\n` }));
      } else {
        ws.send(JSON.stringify({ type: 'error_output', data: 'Threshold must be between 0 and 1.\n' }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'error_output', data: 'Usage: threshold set <intent> <floor>\nExample: threshold set git_push 0.5\n' }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput.startsWith('threshold remove ') || lowerInput.startsWith('threshold reset ')) {
    const intent = lowerInput.replace(/threshold (remove|reset) /, '').trim();
    if (intent) {
      removeThresholdOverride(intent);
      ws.send(JSON.stringify({ type: 'answer', data: `Reset **${intent}** to default threshold (0.6).\n` }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput === 'telemetry auto-apply' || lowerInput === 'auto apply thresholds') {
    const result = autoApplyThresholds(project.id);
    ws.send(JSON.stringify({
      type: 'answer',
      data: `Auto-applied ${result.applied} threshold adjustment(s) (${result.total} suggestions evaluated).\nUse \`list thresholds\` to see active overrides.\n`
    }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput === 'telemetry auto-apply all' || lowerInput === 'auto apply all') {
    const results = autoApplyThresholdsForAll();
    if (results.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No threshold adjustments applied — insufficient telemetry data.\n' }));
    } else {
      let reply = '**Auto-applied thresholds across all projects:**\n';
      for (const r of results) {
        reply += `  ${r.projectId}: ${r.applied} adjustment(s)\n`;
      }
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput === 'check collisions' || lowerInput === 'intent collisions') {
    const collisions = semanticMatcher.findIntentCollisions();
    if (collisions.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: 'No intent collisions detected (threshold: 0.9).\n' }));
    } else {
      let reply = '**Intent embedding collisions (cosine similarity ≥ 0.9):**\n\n';
      for (const c of collisions) {
        reply += `**${c.intentA}** ↔ **${c.intentB}**  (${(c.similarity * 100).toFixed(1)}%)\n`;
      }
      reply += '\nThese intents have very similar embedding profiles. Consider distinguishing their example phrases or merging them.\n';
      ws.send(JSON.stringify({ type: 'answer', data: reply }));
    }
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  if (lowerInput === 'telemetry clear' || lowerInput === 'clear telemetry') {
    clearTelemetry(project.id);
    ws.send(JSON.stringify({ type: 'answer', data: `Cleared telemetry data for ${project.name}.\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  return false;
}
