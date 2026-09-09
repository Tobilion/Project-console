import React, { useEffect, useRef, useState } from 'react';

export const GlowOrbs = ({ followMouse = true }: { followMouse?: boolean }) => (
  <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
    <div className="glow-orb absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-accent-teal/10 blur-[120px]" />
    <div className="glow-orb absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-accent-blue/10 blur-[150px]" />
    <div className="glow-orb absolute top-[20%] right-[20%] w-[30%] h-[30%] rounded-full bg-indigo/5 blur-[100px]" />
    {followMouse && <MouseGlow />}
  </div>
);

/**
 * G-4 (2026-09-09): sitewide "color follows mouse" — a 600px accent-teal radial at the
 * pointer, same token + intensity language as the static orbs above and SpotlightCard's
 * hover glow (color-mix keeps it theme-aware). One rAF-throttled window listener driving
 * a transform (GPU-composited, no layout); pointer-events-none so it can never intercept
 * input. Respects prefers-reduced-motion by rendering frozen at a fixed spot instead of
 * tracking. Rendered inside the same z-0 ambient layer, so it behaves exactly like the
 * orbs it joins (visible through translucent surfaces, never above content).
 */
function MouseGlow() {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: -600, y: -600 });
  const [frozen] = useState(() => {
    try {
      return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (frozen) return;
    let raf = 0;
    let queued = false;
    const onMove = (e: PointerEvent) => {
      pos.current = { x: e.clientX, y: e.clientY };
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(() => {
        queued = false;
        if (ref.current) {
          ref.current.style.transform = `translate(${pos.current.x - 300}px, ${pos.current.y - 300}px)`;
        }
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [frozen]);

  return (
    <div
      ref={ref}
      className="glow-orb absolute top-0 left-0 w-[600px] h-[600px] rounded-full blur-[120px]"
      style={{
        background: 'color-mix(in srgb, var(--color-accent-teal) 10%, transparent)',
        transform: frozen ? 'translate(calc(50vw - 300px), 30vh)' : undefined,
      }}
    />
  );
}
