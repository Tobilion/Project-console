// Screensaver (2026-09-11): full-screen idle / on-demand screensaver.
// Reuses the SandBlocks field from BootScreen — same blue/red/white palette and
// pointer-reactive sand drift. Unlike BootScreen's loading bar, this shows a
// "Back to console" button (Windows-style) and dismisses on Esc / any key / click.
import * as React from 'react';
import { SandBlocks } from './SandBlocks';

export function Screensaver({ onClose }: { onClose: () => void }) {
  const [time, setTime] = React.useState(() => new Date());

  React.useEffect(() => {
    const t = window.setInterval(() => setTime(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Dismiss on Esc
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const ss = String(time.getSeconds()).padStart(2, '0');

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col overflow-hidden"
      style={{ background: '#0D0D0E' }}
      role="dialog"
      aria-modal="true"
      aria-label="Screensaver"
      onClick={onClose}
    >
      <SandBlocks />
      {/* Top half — wordmark + credit, same as BootScreen */}
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
        <p className="mt-6 font-mono text-3xl tracking-widest" style={{ color: '#64D2FF' }}>
          {hh}:{mm}
          <span className="text-lg opacity-60">:{ss}</span>
        </p>
        <p className="mt-1 text-xs" style={{ color: '#86868B' }}>
          {time.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>
      {/* Bottom half — button instead of loading indicator */}
      <div className="relative z-10 shrink-0 pb-10 flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="px-6 py-2.5 rounded-xl text-sm font-bold bg-white text-black hover:bg-white/90 transition-colors shadow-lg glass glass-btn"
        >
          Back to console
        </button>
        <p className="text-[11px]" style={{ color: '#48484A' }}>
          Press Esc or click anywhere to return · Move the mouse to interact with the sand
        </p>
      </div>
    </div>
  );
}
