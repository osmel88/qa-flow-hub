import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Shared flat ESLint configuration.
 *
 * Type-aware: the rules that matter here — a promise nobody awaited, a
 * condition that is always true, an `any` flowing in from an untyped boundary —
 * cannot be expressed without types, and `tsc --noEmit` does not report them.
 * The cost is a slower lint run, paid once per CI job.
 */
export const baseConfig = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // `projectService` lets each file find its own tsconfig, which is what makes
    // this work in a monorepo without listing every project by hand.
    languageOptions: {
      parserOptions: { projectService: true },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  prettier,
);

export default baseConfig;
