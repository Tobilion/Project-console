#!/usr/bin/env node
// Generates the NSIS installer art (2026-09-10): header banner (150x57) + sidebar
// (164x314) BMPs in the loading-screen palette (near-black, blue glow, red accent,
// faint sand-block texture). Deterministic — no fonts, no dependencies: 24-bit
// uncompressed BMP written by hand, so regenerating is byte-identical. NSIS shows its
// own title text over these; the art is backdrop only (matches the desktop splash and
// the web BootScreen brief: blue/red/black/white, blocks drifting like sand).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');

function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// p in [0,1] across, q in [0,1] down. Palette mirrors SandBlocks.tsx (BLUE/RED/WHITE)
// over the #0D0D0E base, with a blue glow blooming from the upper-left like the splash.
function pixel(p, q) {
  const base = [13, 13, 14];
  const dx = p - 0.22;
  const dy = (q - 0.30) * 1.4;
  const glow = Math.max(0, 1 - Math.hypot(dx, dy) / 0.75);
  const g = glow * glow * (3 - 2 * glow);
  const bi = Math.floor(p * 24);
  const bj = Math.floor(q * 12);
  const h = hash2(bi, bj);
  const block = h > 0.93 ? 26 : 0; // sparse lighter blocks, sand-field echo
  const redLine = Math.abs(q - 0.86) < 0.012 ? 1 : 0; // thin red accent near the base
  return [
    Math.min(255, base[0] + 0 * g + block + redLine * 200),
    Math.min(255, base[1] + 113 * g * 0.55 + block + redLine * 30),
    Math.min(255, base[2] + 227 * g * 0.6 + block + redLine * 30),
  ];
}

function writeBmp(name, w, h) {
  const rowSize = Math.floor((24 * w + 31) / 32) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22); // positive = bottom-up rows
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // q: 0 at the top row, 1 at the bottom (rows are written bottom-up).
      const [r, g, b] = pixel(x / (w - 1), (h - 1 - y) / (h - 1));
      const off = 54 + y * rowSize + x * 3;
      buf[off] = b;
      buf[off + 1] = g;
      buf[off + 2] = r;
    }
  }
  const file = path.join(outDir, name);
  fs.writeFileSync(file, buf);
  console.log(`[art] ${name} ${w}x${h} (${buf.length} bytes)`);
}

writeBmp('installerHeader.bmp', 150, 57);
writeBmp('installerSidebar.bmp', 164, 314);
