/**
 * Polls until the given WebSocket is OPEN or `attempts` probes have elapsed. Returns true when
 * open, false when it gave up. Accepts a *getter* (not a captured ref) so a reconnect that
 * swaps `wsRef.current` mid-poll is still detected — matches handleSendMessage's original
 * re-read-`readyState` loop.
 */
export async function waitForSocketOpen(
  getWs: () => WebSocket | null,
  attempts = 30,
  delayMs = 100,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const ws = getWs();
    if (ws && ws.readyState === WebSocket.OPEN) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  const final = getWs();
  return !!final && final.readyState === WebSocket.OPEN;
}
