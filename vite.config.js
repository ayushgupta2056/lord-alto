import { defineConfig } from 'vite';

// Dev: `npm run dev` (Vite, reachable from phones on the LAN) + `npm run server` (game server on :8787).
// The browser connects to ws(s)://<page host>/ws; in dev Vite proxies that to the game server.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true, changeOrigin: true },
      '/healthz': { target: 'http://localhost:8787' },
    },
  },
  preview: {
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1500,
  },
});
