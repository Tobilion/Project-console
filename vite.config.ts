import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Matches tsconfig.json's "@/*" -> "./src/*" path mapping (shadcn's default convention) —
    // tsconfig alone only affects type-checking, Vite needs its own alias to actually resolve
    // "@/..." imports at build/dev time.
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    // Keep in sync with the inline config passed to createViteServer() in server/index.js —
    // `data/` holds this app's own runtime-written state (conversation index, telemetry,
    // near-miss logs) and should never be treated as a source-file change.
    watch: { ignored: ['**/data/**', '**/.cache/**', '**/*.console/**'] },
  },
});
