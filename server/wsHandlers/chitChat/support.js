import fs from 'fs';
import path from 'path';
import os from 'os';
import archiver from 'archiver';
import { getLogDir, listLogFiles, readLogFile, whereAreLogs } from '../../fileLogger.js';
import { runDoctorChecks, printDoctorReport } from '../../doctor.js';

/**
 * system.chit_chat.* diagnostics/log-support handlers (extracted verbatim from builtinChitChat.js).
 * Troubleshoot runs the same console-doctor checks/auto-fixes the CLI's `console doctor --fix`
 * and the K-10 REST routes use — one source of truth for "what's wrong" and "how to fix it"
 * across chat, CLI, REST, and (via the Settings Diagnostics panel once built) the UI.
 */
export const supportHandlers = {
  // K-11 (2026-09-08/09): "a one-click path from 'here's what broke' to 'here's the fix'" —
  // the chat-side half of the troubleshoot flow (the fatal-boot-screen half lives in
  // desktop/main.cjs). Reached either by the user directly asking ("troubleshoot",
  // "run diagnostics", etc. — see server/preSemanticOverrides.js) or by tapping the
  // "Troubleshoot" suggestion chip a failed command's answer offers (see
  // server/executorClose.js's generic-failure fallback).
  'system.chit_chat.troubleshoot': async (ws, action, input, project, sessionContext) => {
    const { runDoctorChecks, autoFixDoctor } = await import('../../doctor.js');
    const before = await runDoctorChecks();
    const problems = before.filter((c) => c.status !== 'ok');
    if (problems.length === 0) {
      ws.send(JSON.stringify({ type: 'answer', data: "Ran a full diagnostic — everything checks out, nothing to fix right now." }));
      return;
    }
    let msg = `### Troubleshoot\n\nFound ${problems.length} issue${problems.length > 1 ? 's' : ''}:\n\n` +
      problems.map((c) => `- **${c.name}**: ${c.detail}`).join('\n');
    const fixes = await autoFixDoctor();
    if (fixes.length > 0) {
      msg += `\n\n**Auto-fixed:**\n` + fixes.map((f) => `- ${f}`).join('\n');
      const after = await runDoctorChecks();
      const stillBroken = after.filter((c) => c.status !== 'ok');
      msg += stillBroken.length > 0
        ? `\n\n**Still needs attention:**\n` + stillBroken.map((c) => `- **${c.name}**: ${c.detail}`).join('\n')
        : `\n\nEverything's clear now.`;
    } else {
      msg += `\n\nNone of these have a safe automatic fix yet — \`console doctor\` (CLI) has the full detail.`;
    }
    ws.send(JSON.stringify({ type: 'answer', data: msg }));
  },

  'system.chit_chat.where_are_logs': async (ws, action, input, project, sessionContext) => {
    ws.send(JSON.stringify({ type: 'answer', data: whereAreLogs() }));
  },

  'system.chit_chat.export_logs': async (ws, action, input, project, sessionContext) => {
    try {
      const logDir = getLogDir();
      const files = listLogFiles();
      if (files.length === 0) {
        ws.send(JSON.stringify({ type: 'answer', data: 'No log files found to export.' }));
        return;
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const exportPath = path.join(os.homedir(), `console-logs-${timestamp}.zip`);
      const archive = archiver('zip', { zlib: { level: 9 } });
      const output = fs.createWriteStream(exportPath);
      archive.pipe(output);
      for (const f of files) {
        const content = readLogFile(f);
        if (content) archive.append(content, { name: f });
      }
      // Add doctor report
      const checks = await runDoctorChecks();
      const report = printDoctorReport(checks).replace(/\*\*/g, '');
      archive.append(report, { name: 'doctor-report.txt' });
      await new Promise((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.finalize().catch(reject);
      });
      ws.send(JSON.stringify({
        type: 'answer',
        data: `Exported ${files.length} log file(s) + doctor report to:\n\`${exportPath}\`\n\nAttach this file to a bug report — it contains recent server/cli/daemon/desktop crash logs and a full machine diagnostic.`,
      }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error_output', data: `Failed to export logs: ${err.message}` }));
    }
  },
};