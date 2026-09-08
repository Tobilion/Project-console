// K-10 (2026-09-08): expose `console doctor`'s checks and auto-fixes over REST so a Settings
// Diagnostics panel can render and act on them without a terminal — the CLI/standalone path
// (bin/cli.js's `doctor` subcommand, `node --import tsx server/doctor.js`) remains the one
// that works when the server itself won't boot; this route is additive, served once the
// server IS up. asyncHandler wraps both so a check throwing doesn't crash the request.
import { runDoctorChecks, doctorExitCode, autoFixDoctor } from '../doctor.js';
import { asyncHandler } from '../asyncHandler.js';

export function registerDoctorRoutes(app) {
  app.get('/api/doctor', asyncHandler(async (req, res) => {
    const checks = await runDoctorChecks();
    res.json({ checks, exitCode: doctorExitCode(checks) });
  }));

  app.post('/api/doctor/fix', asyncHandler(async (req, res) => {
    const fixes = await autoFixDoctor();
    res.json({ fixes });
  }));
}
