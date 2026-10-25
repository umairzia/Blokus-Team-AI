import { defineConfig } from 'vite';

// The site is served from https://umairzia.github.io/Blokus-Team-AI/, so every
// asset URL must start with the repository name. BASE_PATH overrides it for a
// fork or a custom domain (use "/" for a domain root).
const base = process.env.BASE_PATH ?? '/Blokus-Team-AI/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
