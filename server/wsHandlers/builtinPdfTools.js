// Phase 3 (UPGRADE-ROADMAP.md, 2026-08-11): chat-side trigger handlers for the PDF toolkit.
// Five intents (pdf.merge / pdf.split / pdf.extract_text / pdf.extract_pages / pdf.watermark),
// all tagged `opensPanel: 'pdf-tools'` in pdfIntents.js. Rule per the roadmap: read-only
// extract_text answers immediately; every op that writes a file goes through the standard
// confirm flow (pendingConfirmations pdfOp record, consumed in connectionConfirm.js) and is
// journaled inside pdfKit.js via appendAction. When the input lacks the parameters an
// operation needs, the answer carries the additive `openPanel: 'pdf-tools'` field so the
// user lands in the interactive panel — the same answer text stays CLI-usable (Phase 1.5
// convention), naming the exact commands the terminal user would type.

import crypto from 'crypto';
import { pendingConfirmations } from '../state.js';
import {
  MAX_MERGE_INPUTS, resolvePdfInput, parsePdfNames, parsePdfOutput,
  parsePageSpec, extractWatermarkText, extractText,
} from '../pdfKit.js';

const PANEL_ID = 'pdf-tools';

const GUIDE =
  'The PDF tools work from chat too — the PDF Tools panel also opened here. Try e.g.:\n\n' +
  '- `merge these pdfs into combined.pdf`\n' +
  '- `split report.pdf at page 5` (or "into one file per page")\n' +
  '- `extract text from report.pdf`\n' +
  '- `extract pages 2-5 from report.pdf into excerpt.pdf`\n' +
  '- `watermark report.pdf with confidential`';

const answer = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data }));
const answerWithPanel = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data, openPanel: PANEL_ID }));

/** Writes go through the standard confirm flow with a pdfOp pending record (consumed by the
 *  pdfOp branch in connectionConfirm.js — checkpoint first, then the pdfKit.js op, which
 *  journals the created file itself). */
function askConfirm(ws, project, input, commandText, trigger, pdfOp) {
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    owner: ws,
    projectId: project.id,
    command: commandText,
    trigger: input,
    createdAt: Date.now(),
    pdfOp,
  });
  ws.send(JSON.stringify({
    type: 'confirm_prompt',
    token,
    command: `${commandText}\n\nThis creates a new file (never overwrites an existing one) and is reversible via "revert action <id>" after it runs.`,
    trigger,
  }));
}

async function handleMerge(ws, action, input, project, sessionContext) {
  const names = parsePdfNames(input);
  const output = parsePdfOutput(input);
  if (names.length === 0 || !output) return answerWithPanel(ws, GUIDE);
  const inputs = [];
  const missing = [];
  for (const n of names) {
    const hit = resolvePdfInput(project.path, n);
    if (hit) inputs.push(hit.path);
    else missing.push(n);
  }
  if (missing.length > 0) {
    return answer(ws, `Could not find these PDFs in **[${project.name}]**: ${missing.join(', ')}${inputs.length ? ` (found: ${inputs.join(', ')})` : ''}. Check the exact file names — the PDF Tools panel shows the project's file list.`);
  }
  if (inputs.length < 2) {
    return answer(ws, `Merge needs at least two PDFs — found only: ${inputs.join(', ')}.`);
  }
  if (inputs.length > MAX_MERGE_INPUTS) {
    return answer(ws, `Merge is capped at ${MAX_MERGE_INPUTS} PDFs per run — pick fewer files.`);
  }
  if (new Set(inputs).size !== inputs.length) {
    return answer(ws, `The same PDF appears twice in your merge — pick each file once.`);
  }
  if (inputs.includes(output)) {
    return answer(ws, `The output name "${output}" is also one of the inputs — pick a different output name.`);
  }
  askConfirm(ws, project, input,
    `Merge ${inputs.length} PDF(s) into **${output}**?\n\n${inputs.map((f) => `  - ${f}`).join('\n')}`,
    'pdf_merge', { kind: 'merge', inputs, output });
  return true;
}

async function handleSplit(ws, action, input, project, sessionContext) {
  const names = parsePdfNames(input);
  const spec = parsePageSpec(input);
  if (names.length === 0 || !spec) return answerWithPanel(ws, GUIDE);
  const hit = resolvePdfInput(project.path, names[0]);
  if (!hit) return answer(ws, `Could not find "${names[0]}" in **[${project.name}]**.`);
  const mode = spec.kind === 'perPage'
    ? 'one file per page'
    : `two parts around page ${spec.page}`;
  askConfirm(ws, project, input,
    `Split **${hit.path}** into ${mode}?`,
    'pdf_split', { kind: 'split', input: hit.path, spec });
  return true;
}

async function handleExtractText(ws, action, input, project, sessionContext) {
  const names = parsePdfNames(input);
  if (names.length === 0) return answerWithPanel(ws, GUIDE);
  const hit = resolvePdfInput(project.path, names[0]);
  if (!hit) return answer(ws, `Could not find "${names[0]}" in **[${project.name}]**.`);
  const result = await extractText(project.path, hit.path);
  if (!result.ok) return answer(ws, result.error);
  if (!result.text) {
    return answer(ws, `No extractable text in **${hit.path}** (scanned-image PDFs have none — this extracts the text layer, not OCR).`);
  }
  const more = result.text.length > result.preview.length
    ? `\n\n*…${result.text.length - result.preview.length} more characters — this preview is capped.*`
    : '';
  answer(ws, `**Text from ${hit.path}** (${result.pages} page${result.pages === 1 ? '' : 's'}):\n\n\`\`\`\n${result.preview}\n\`\`\`${more}`);
  return true;
}

async function handleExtractPages(ws, action, input, project, sessionContext) {
  const names = parsePdfNames(input);
  const spec = parsePageSpec(input);
  const output = parsePdfOutput(input);
  if (names.length === 0 || !spec || spec.kind !== 'range') return answerWithPanel(ws, GUIDE);
  const hit = resolvePdfInput(project.path, names[0]);
  if (!hit) return answer(ws, `Could not find "${names[0]}" in **[${project.name}]**.`);
  const outName = output || `${hit.path.replace(/\.pdf$/i, '')}-pages-${spec.from}-${spec.to}.pdf`;
  askConfirm(ws, project, input,
    `Extract pages **${spec.from}-${spec.to}** from **${hit.path}** into **${outName}**?`,
    'pdf_extract_pages', { kind: 'extract_pages', input: hit.path, range: { from: spec.from, to: spec.to }, output: outName });
  return true;
}

async function handleWatermark(ws, action, input, project, sessionContext) {
  const names = parsePdfNames(input);
  const text = extractWatermarkText(input);
  const output = parsePdfOutput(input);
  if (names.length === 0 || !text) return answerWithPanel(ws, GUIDE);
  const hit = resolvePdfInput(project.path, names[0]);
  if (!hit) return answer(ws, `Could not find "${names[0]}" in **[${project.name}]**.`);
  const outName = output || `${hit.path.replace(/\.pdf$/i, '')}-watermarked.pdf`;
  askConfirm(ws, project, input,
    `Watermark **${hit.path}** with "${text}" into **${outName}**?`,
    'pdf_watermark', { kind: 'watermark', input: hit.path, text, output: outName });
  return true;
}

export const pdfHandlers = {
  'pdf.merge': handleMerge,
  'pdf.split': handleSplit,
  'pdf.extract_text': handleExtractText,
  'pdf.extract_pages': handleExtractPages,
  'pdf.watermark': handleWatermark,
};
