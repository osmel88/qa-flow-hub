import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The browser talks to `/api` and `/health` on its own origin and Vite forwards
 * them to the API. This keeps CORS out of the picture during development and
 * mirrors the reverse-proxy layout used in deployment. `preview` needs the same
 * rules because the end-to-end suite runs against the production build.
 */
const apiProxy = {
  '/api': {
    target: process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000',
    changeOrigin: true,
  },
  '/health': {
    target: process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, proxy: apiProxy },
  preview: { port: 4173, host: true, proxy: apiProxy },
  build: { outDir: 'dist', sourcemap: true },
});
