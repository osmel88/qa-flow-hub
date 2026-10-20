import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The browser talks to `/api/` and `/health` on its own origin and Vite forwards
 * them to the API. This keeps CORS out of the picture during development and
 * mirrors the reverse-proxy layout used in deployment. `preview` needs the same
 * rules because the end-to-end suite runs against the production build.
 */
const apiProxy = {
  '/api/': {
    target: process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000',
    changeOrigin: true,
  },
  '/health': {
    target: process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000',
    changeOrigin: true,
  },
};

/**
 * The headers nginx sends in deployment (apps/web/security-headers.conf),
 * repeated for `preview` so the end-to-end suite runs the production bundle
 * under the production policy: a CSP violation fails a test instead of a
 * release. The dev server is left alone; its HMR client needs inline code.
 */
const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, proxy: apiProxy },
  preview: { port: 4173, host: true, proxy: apiProxy, headers: securityHeaders },
  build: { outDir: 'dist', sourcemap: true },
});
