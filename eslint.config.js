// ESLint flat config — catches the v1.7.49/v1.7.50-class bugs that `node --check`
// misses (orphan imports, undefined references, dead vars) before they hit
// smoke.sh. Pair with smoke.sh: lint = static, smoke = runtime.

import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,

  // Browser-side game code
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Vendored libs loaded via <script> in index.html (Emscripten GME +
        // jsnes). Both expose globals on `window`.
        Module: 'readonly',
        jsnes: 'readonly',
      },
    },
    rules: {
      // Catch orphan imports / dead destructures / typos. Underscore prefix =
      // intentionally unused (matches existing convention in the codebase).
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // The high-signal rules: catches the v1.7.49 / v1.7.50 / spell-cast
      // `_damageImpactSFX` class of bug — module loads fine but explodes
      // when the code path runs.
      'no-undef': 'error',
      'no-undef-init': 'error',
      'no-unreachable': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      // Project style — accept these patterns rather than fighting them
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'no-cond-assign': 'off',
      'no-control-regex': 'off',
      'no-fallthrough': 'off',
      // ROM tile data has lots of intentional sparse-array literals
      'no-sparse-arrays': 'off',
      // Legacy patterns we don't want to chase right now. Warn (visible in
      // `npm run lint`) but don't fail (`npm run lint:errors` is the gate).
      'no-redeclare': 'warn',
      'no-useless-assignment': 'warn',
    },
  },

  // Node-side: server, tools, scripts
  {
    files: [
      'server.js',
      'api.js',
      'debug-server.js',
      'ws-presence.js',
      'tools/**/*.js',
      'tools/**/*.mjs',
      'tools/**/*.cjs',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-undef': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  {
    ignores: [
      'node_modules/**',
      'patches/**',
      'lib/**',
      'data/**',
      'docs/**',
      // jsnes is vendored or fetched at runtime — not our code
      'src/lib/**',
    ],
  },
];
