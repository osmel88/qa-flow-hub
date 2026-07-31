import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests boot the real Nest application against a real PostgreSQL
 * database and drive it over HTTP. They are the only tests that can prove
 * tenant isolation and authorization actually hold end to end.
 *
 * They run single-threaded on purpose: the suites share one database and
 * truncate tables between files.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['test/**/*.int-spec.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
