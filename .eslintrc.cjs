module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  plugins: ['@typescript-eslint', 'vitest', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
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
    'vitest/no-disabled-tests': 'error',

    // Prevent focused tests (.only) from being accidentally committed
    'vitest/no-focused-tests': 'error',

    // Ensure tests actually have assertions
    'vitest/expect-expect': 'error',

    // Avoid identical titles which makes debugging flaky tests impossible
    'vitest/no-identical-title': 'error',
  },
  overrides: [
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
  ],
  ignorePatterns: ['dist/', 'coverage/', 'node_modules/', '*.cjs', '*.js'],
};
