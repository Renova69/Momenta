import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/', 'coverage/', '**/*.cjs', '**/*.js'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    // @vitest/eslint-plugin is the maintained successor of eslint-plugin-vitest,
    // whose last release pinned a vulnerable @typescript-eslint/utils 7.
    plugins: {
      '@vitest': vitest,
      'react-hooks': reactHooks,
    },
    rules: {
      // The base rule misfires on TypeScript type-only identifiers; the plugin
      // version understands them. Leading underscores mark deliberate discards.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // This app is built on hand-written subscription effects, where a missing
      // dependency shows up as a stale closure rather than a crash.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['warn', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn',

      // Prevent permanently skipped tests
      '@vitest/no-disabled-tests': 'error',

      // Prevent focused tests (.only) from being accidentally committed
      '@vitest/no-focused-tests': 'error',

      // Ensure tests actually have assertions. `expectNoViolations` is one:
      // it runs axe over the rendered markup and asserts the violation list is
      // empty, reporting the rule ids and offending HTML when it is not.
      '@vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expectNoViolations'] }],

      // Avoid identical titles which makes debugging flaky tests impossible
      '@vitest/no-identical-title': 'error',
    },
  },
  {
    // Tests must stay free of explicit `any`.
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
    },
  },
  {
    // Application and server code: warn on `any` rather than fail the build,
    // so linting the whole app is actionable without a large refactor.
    files: ['src/**/*.{ts,tsx}', 'server/**/*.ts', 'shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Server code logs to stdout by design; it has no other reporting channel.
    files: ['server/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
