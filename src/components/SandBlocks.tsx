// SandBlocks (Phase H, 2026-09-10): a canvas block field for loading surfaces —
// the web BootScreen and (as a compact vanilla mirror) the desktop splash page.
// Small rounded blocks in the loading palette (blue/red/white) drift away from the
// pointer like sand while their color blends toward white with proximity — a continuous
// pointer-distance field, not discrete pings. Self-contained (no deps): one rAF loop,
// DPR capped at 1.5, paused off-screen/hidden-tab, and a single static frame under
// prefers-reduced-motion. Blocks are placed by a stable hash, never per-frame random,
// so the field doesn't shimmer.

import * as React from 'react';
import { cn } from '../lib/utils';

type RGB = [number, number, number];

const BLUE: RGB = [0, 113, 227];
const RED: RGB = [255, 69, 58];
const WHITE: RGB = [255, 255, 255];

const MAX_DPR = 1.5;
const FIELD_RADIUS = 190;
const MAX_SHIFT = 16;

function hash2(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = (h * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function SandBlocks({ spacing = 26, block = 11, baseOpacity = 0.55, interactive = true, className }: {
  spacing?: number;
  block?: number;
  baseOpacity?: number;
  interactive?: boolean;
  className?: string;
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const opts = React.useRef({ spacing, block, baseOpacity, interactive });
  opts.current = { spacing, block, baseOpacity, interactive };

  React.useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let raf = 0;
    let visible = true;
    // Smoothed pointer in host coords (null until the first move — the field idles
    // until the user actually slides across it).
    let px: number | null = null;
    let py: number | null = null;
    let tx: number | null = null;
    let ty: number | null = null;

    const draw = () => {
      const o = opts.current;
      if (px !== null && tx !== null && py !== null && ty !== null) {
        px += (tx - px) * 0.18;
        py += (ty - py) * 0.18;
      }
      ctx.clearRect(0, 0, width, height);
      const cols = Math.ceil(width / o.spacing) + 1;
      const rows = Math.ceil(height / o.spacing) + 1;
      const ox = (width - (cols - 1) * o.spacing) / 2;
      const oy = (height - (rows - 1) * o.spacing) / 2;
      for (let i = 0; i < cols; i++) {
        const cx = ox + i * o.spacing;
        for (let j = 0; j < rows; j++) {
          const cy = oy + j * o.spacing;
          const h = hash2(i, j);
          const base = h < 0.55 ? BLUE : h < 0.75 ? RED : WHITE;
          let fall = 0;
          let dx = 0;
          let dy = 0;
          if (px !== null && py !== null) {
            dx = cx - px;
            dy = cy - py;
            const d = Math.hypot(dx, dy);
            if (d < FIELD_RADIUS && d > 0.01) {
              const t = 1 - d / FIELD_RADIUS;
              fall = t * t * (3 - 2 * t);
              const push = (fall * MAX_SHIFT) / d;
              dx *= push;
              dy *= push;
            } else {
              dx = 0;
              dy = 0;
            }
          }
          const c = mix(base, WHITE, fall * 0.65);
          const size = o.block * (1 + fall * 0.7);
          ctx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${(o.baseOpacity + (1 - o.baseOpacity) * fall).toFixed(3)})`;
          const x = cx + dx - size / 2;
          const y = cy + dy - size / 2;
          if (typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown }).roundRect === 'function') {
            ctx.beginPath();
            (ctx as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x, y, size, size, Math.min(3, size / 3));
            ctx.fill();
          } else {
            ctx.fillRect(x, y, size, size);
          }
        }
      }
    };

    const tick = () => {
      raf = 0;
      if (!visible || document.hidden) return;
      draw();
      raf = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (!raf && !reduceMotion.matches) raf = requestAnimationFrame(tick);
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
      wake();
    };

    // Tracked on window, not the host: the host is pointer-events-none (content above
    // it owns the events), so a host-level listener would never fire.
    const onMove = (e: PointerEvent) => {
      if (!opts.current.interactive || !visible || reduceMotion.matches) return;
      const rect = host.getBoundingClientRect();
      tx = e.clientX - rect.left;
      ty = e.clientY - rect.top;
      if (px === null) { px = tx; py = ty; }
      wake();
    };
    const onVisibility = () => { if (!document.hidden) { resize(); } };

    const ro = new ResizeObserver(resize);
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? true;
        if (visible) {
          resize();
        } else {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      { threshold: 0 },
    );
    resize();
    ro.observe(host);
    io.observe(host);
    window.addEventListener('pointermove', onMove);
    document.addEventListener('visibilitychange', onVisibility);
    const onMotionChange = () => { draw(); wake(); };
    reduceMotion.addEventListener('change', onMotionChange);

    return () => {
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
      reduceMotion.removeEventListener('change', onMotionChange);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={hostRef} aria-hidden="true" className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <canvas ref={canvasRef} className="size-full" />
    </div>
  );
}
