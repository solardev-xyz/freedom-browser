const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'dev-scripts/**',
      'dist/**',
      'out/**',
      'coverage/**',
      'node_modules/**',
      'src/renderer/vendor/**',
      'ant-bin/**',
      'ipfs-bin/**',
      'ant-data/**',
      'ipfs-data/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.test.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    // Playwright E2E specs run in Node and use the test fixtures from
    // test-e2e/fixtures.js rather than the global jest harness.
    files: ['test-e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Electron runs a sandboxed preload inside a function wrapper, so
    // webview-preload.js may `return` at top level (it does, in sub-frames).
    files: ['src/main/webview-preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-useless-escape': 'off',
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
];
