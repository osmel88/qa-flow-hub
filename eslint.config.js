import { baseConfig } from './packages/config/eslint.base.js';

export default [
  ...baseConfig,
  {
    // Configuration and tooling files run outside the strict application layers.
    files: ['**/*.config.js', '**/*.config.ts', '**/vite.config.ts', '**/vitest.config.ts'],
    rules: {
      'no-console': 'off',
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
