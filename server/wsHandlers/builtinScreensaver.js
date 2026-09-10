// Screensaver (2026-09-11): opens the SandBlocks idle surface.
// The web client listens for {type:'open_screensaver'} and overlays the Screensaver
// component (same SandBlocks field as BootScreen, but with a "Back to console" button
// instead of a loading bar — Windows-style). CLI reuses the same answer text.
export const screensaverHandlers = {
  'system.screensaver.open': async (ws) => {
    ws.send(JSON.stringify({
      type: 'answer',
      data: 'Opening the screensaver — the SandBlocks field with a **Back to console** button. Press Esc or click anywhere to return. You can also trigger it from the Command Deck (Ctrl+K → Screensaver) or let it auto-open after idle (Settings → Appearance → Screensaver).',
    }));
    ws.send(JSON.stringify({ type: 'open_screensaver' }));
  },
};
