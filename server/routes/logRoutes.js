// Log inspection + export (2026-08-29, Round 3 Part E6).
// - GET /api/logs — list available log files with sizes
// - GET /api/logs/:name — read one log file (tailed if large)
// - GET /api/logs/export — bundle recent logs + doctor report into a zip

import fs from 'fs';
import path from 'path';
import { getLogDir, listLogFiles, readLogFile } from '../fileLogger.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerLogRoutes(app) {
  app.get('/api/logs', (req, res) => {
    const dir = getLogDir();
    const files = listLogFiles().map((name) => {
      let size = 0;
      try { size = fs.statSync(path.join(dir, name)).size; } catch {}
      return { name, size };
    });
    res.json({ dir, files });
  });

  app.get('/api/logs/:name', (req, res) => {
    const name = req.params.name;
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      return res.status(400).json({ error: 'Invalid log name.' });
    }
    const content = readLogFile(name);
    if (content === null) return res.status(404).json({ error: `Log not found: ${name}` });
    res.type('text/plain').send(content);
  });

  app.get('/api/logs/export', asyncHandler(async (req, res) => {
    // Bundle: every .log in logs/ + doctor report + profile summary (no secrets).
    const dir = getLogDir();
    const files = listLogFiles();
    let doctorReport = '';
    try {
      const { runDoctorChecks, printDoctorReport } = await import('../doctor.js');
      const checks = await runDoctorChecks();
      doctorReport = printDoctorReport(checks);
    } catch (e) { doctorReport = `Doctor failed: ${e.message}`; }

    // For now, stream a simple multi-section text file (no zip dependency needed).
    // Keep Content-Disposition so the browser downloads it.
    let bundle = `# Console log export — ${new Date().toISOString()}\n`;
    bundle += `Log dir: ${dir}\n\n`;
    bundle += `## Doctor report\n${doctorReport}\n\n`;
    for (const name of files) {
      const content = readLogFile(name, 128 * 1024) || '(empty or unreadable)';
      bundle += `\n## ${name}\n\`\`\`\n${content.slice(-120 * 1024)}\n\`\`\`\n`;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="console-logs-${stamp}.md"`);
    res.type('text/markdown').send(bundle);
  }));
}
