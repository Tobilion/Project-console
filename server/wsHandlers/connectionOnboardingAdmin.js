// Phase 13 audit (2026-08-12): onboarding-reset admin command. "reset onboarding" /
// "retake tour" sets setupComplete back to false through the SAME profile write path the
// wizard uses (profileRoutes.writeProfile), so the first-run wizard reappears on the next
// load without hand-editing data/user-profile.json. Dispatched from the pre-matcher admin
// tier (connectionExecute.js), same pattern as the notify/mode admin handlers.
import { readProfile, writeProfile } from '../routes/profileRoutes.js';

export async function handleOnboardingCommand(ws, lowerInput) {
  if (!/^(reset onboarding|retake tour|restart onboarding|show onboarding again)$/.test(lowerInput)) {
    return false;
  }
  const current = readProfile();
  const err = writeProfile({ ...current, setupComplete: false });
  if (err) {
    ws.send(JSON.stringify({ type: 'error_output', data: `Could not reset onboarding: ${err.message}\n` }));
    ws.send(JSON.stringify({ type: 'end' }));
    return true;
  }
  ws.send(JSON.stringify({
    type: 'answer',
    data: 'Onboarding reset — the first-run wizard will show again on the next page load (or run `retake tour` from the profile settings anytime).',
  }));
  ws.send(JSON.stringify({ type: 'end' }));
  return true;
}
