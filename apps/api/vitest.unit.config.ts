import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests: no database, no HTTP server. They cover business rules in
 * isolation, which is why they can run in a few seconds on every save.
 *
 * The SWC plugin is required because Vitest does not emit the decorator
 * metadata NestJS relies on for dependency injection.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/unit',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/**/dto/**', 'src/**/*.module.ts'],
    },
  },
});
