import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // CDN-ready: build with VITE_CDN_BASE=https://cdn.example.com/ to prefix every asset URL.
  base: process.env.VITE_CDN_BASE || '/',
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: false,
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    // React in its own long-cached chunk: an app-only change re-downloads a few KB, not React again.
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'] } } },
  },
  server: {
    port: 5173,
    // `npm run dev:frontend` proxies the API to the NGINX container (docker compose must be running).
    proxy: { '/api': 'http://localhost:8080' },
  },
});