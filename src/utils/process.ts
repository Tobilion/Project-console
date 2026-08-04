// Process-display helpers (Phase 1 modularization — extracted from ProcessDock.tsx).

/** Shortens a command for the dock tab label without hiding the interesting part (the executable +
 *  first arg or two). Full command is always available via the title tooltip. */
export function shortCommand(command: string): string {
  const trimmed = command.replace(/^set\s+\w+=\S+\s*&&\s*/i, '').trim();
  return trimmed.length > 36 ? trimmed.slice(0, 36) + '…' : trimmed;
}

/** Pulls the port out of a detected dev URL ("http://localhost:5173/" → "5173"). */
export function portFromUrl(url: string): string | null {
  const m = url.match(/:(\d{2,5})/);
  return m ? m[1] : null;
}
