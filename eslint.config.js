import tseslint from 'typescript-eslint';
import { baseConfig } from './packages/config/eslint.base.js';

export default [
  ...baseConfig,
  {
    // Tooling files are outside every tsconfig, so there are no types to lint
    // with. Adding them to a tsconfig would put build configuration inside the
    // programs it configures.
    files: ['**/*.js', '**/*.mjs', '**/*.config.ts', '**/playwright.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Configuration and tooling files run outside the strict application layers.
    files: ['**/*.config.js', '**/*.config.ts', '**/vite.config.ts', '**/vitest.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // An HTTP response body is genuinely untyped: `response.json()` gives back
    // `any`, and that is the truth of the boundary — a test that asserts on the
    // wire format is exactly the place where the type system has nothing to say.
    // The alternative is ~800 casts asserting types nobody verified, which reads
    // as safety without adding any. The rules that do apply to tests — an
    // unawaited promise, a floating one — stay on.
    //
    // The version worth building later is parsing responses through the shared
    // Zod contracts, which would type them *and* catch contract drift. Noted in
    // docs/technical-debt.md.
    files: ['apps/api/test/**/*.ts', '**/*.test.ts', '**/*.test.tsx', 'apps/web/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // `vi.fn(async () => new Response(...))` has no await and does not need
      // one: the `async` is there to produce the promise `fetch` must return.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Prisma seeds and scripts are operational tooling: printing progress is the point.
    files: ['apps/api/prisma/**/*.ts', 'apps/api/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
