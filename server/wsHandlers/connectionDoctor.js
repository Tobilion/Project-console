import { runDoctorChecks, printDoctorReport } from '../doctor.js';

// `console doctor` chat command (2026-08-26) — the proactive sibling of the health check:
// runs the same machine-side checks the standalone doctor does (ports, daemon, embedding
// cache, writability, Ollama, update, tooling, disk) and answers as markdown. Pre-matcher
// admin tier (wired in connectionExecute.js next to the health check): never touches the
// matching pipeline, never confirms, never mutates. Answer + trailing `end` — the admin-tier
// contract every handler here follows (a missing `end` leaves the web terminal spinning).
//
// The standalone path (`node bin/cli.js doctor` / `npm run doctor`) runs the identical
// checks without a server — use that when the console won't boot at all.

function doctorPhrases(input) {
  const i = input.toLowerCase();
  return (
    i === 'doctor' || i === 'console doctor' || i === 'run doctor' || i === 'run the doctor' ||
    i === 'doctor check' || i === 'diagnose' || i === 'diagnose the console'
  );
}

export async function handleDoctorCommand(ws, lowerInput) {
  if (!doctorPhrases(lowerInput)) return false;

  const checks = await runDoctorChecks();
  ws.send(JSON.stringify({ type: 'answer', data: printDoctorReport(checks) }));
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}