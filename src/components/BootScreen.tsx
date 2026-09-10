// BootScreen (Phase H, 2026-09-10): the web entry point's full-screen loading state —
// the browser equivalent of the desktop splash. Same concept: large "Project Console"
// wordmark + "made by Tobiloba Jagun" credit across the top half, live elapsed time +
// status line in the bottom half, blue/red/black/white palette with the SandBlocks
// field behind it all. Shown only while the profile fetch is in flight (App gates on
// !profileLoaded, which always resolves — this can never trap), and only after a short
// delay so fast loads never flash it.

import * as React from 'react';
import { SandBlocks } from './SandBlocks';

export function BootScreen({ status }: { status?: string }) {
  const [slow, setSlow] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 400);
    return () => window.clearTimeout(t);
  }, []);

  React.useEffect(() => {
    if (!slow) return;
    const started = Date.now();
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [slow]);

  if (!slow) return null;

  return (
    <div className="h-screen relative flex flex-col overflow-hidden" style={{ background: '#0D0D0E' }}>
      <SandBlocks />
      <div className="relative z-10 flex-1 min-h-0 flex flex-col items-center justify-center px-6 text-center">
        <h1
          className="font-bold tracking-tight"
          style={{ color: '#FFFFFF', fontSize: 'clamp(40px, 7vw, 76px)', lineHeight: 1.05, letterSpacing: '-0.02em' }}
        >
          Project Console
        </h1>
        <p className="mt-3 text-[11px] font-semibold uppercase" style={{ color: '#86868B', letterSpacing: '0.22em' }}>
          Made by Tobiloba Jagun
        </p>
      </div>
      <div className="relative z-10 shrink-0 pb-10 flex flex-col items-center gap-1.5">
        <div className="h-[3px] w-56 rounded-full overflow-hidden" style={{ background: '#2C2C2E' }}>
          <div
            className="h-full w-2/5 rounded-full"
            style={{ background: 'linear-gradient(90deg,#0071E3,#FF453A,#FFFFFF)', animation: 'bootscreen-slide 1.2s ease-in-out infinite' }}
          />
        </div>
        <p className="text-xs" style={{ color: '#64D2FF' }}>{status ?? 'Starting the local console…'}</p>
        <p className="text-[11px]" style={{ color: '#48484A' }}>Elapsed: {elapsed}s</p>
      </div>
      <style>{'@keyframes bootscreen-slide{0%{transform:translateX(-90%)}100%{transform:translateX(260%)}}'}</style>
    </div>
  );
}
