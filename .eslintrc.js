// ESLint config. Deliberately `.eslintrc.js` and not `.eslintrc.json` so the
// rule choices below can carry their reasoning — several of them look like
// "someone silenced a warning" and are not.
//
// Pinned to ESLint 8 (see .github/workflows/ci.yml): v9 ignores .eslintrc.* and
// requires a flat `eslint.config.js`.
module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: { react: { version: 'detect' } },
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-undef': 'error',
    'no-redeclare': 'error',
  },
  overrides: [
    {
      files: ['web/**/*.jsx', 'web/**/*.js'],
      // Without these plugins every JSX identifier read as an unused variable, which
      // is why the lint job reported ~240 problems that were almost all noise.
      plugins: ['react', 'react-hooks'],
      extends: ['plugin:react/recommended', 'plugin:react-hooks/recommended'],
      globals: { crypto: 'readonly' },
      rules: {
        // Vite's JSX transform — no React import needed.
        'react-in-jsx-scope': 'off',
        'react/react-in-jsx-scope': 'off',
        // No prop-types in this codebase; props are documented in comments.
        'react/prop-types': 'off',

        // react-three-fiber passes three.js props (position-y, rotation-x, args,
        // castShadow, …) that a DOM-oriented plugin cannot know about.
        'react/no-unknown-property': 'off',

        // Stylistic rule about ambiguous ' and " inside JSX prose. React renders
        // them correctly; escaping every apostrophe in the UI copy would make the
        // source materially harder to read for no behavioural gain.
        'react/no-unescaped-entities': 'off',

        // This one stays an ERROR — it catches genuine defects (conditional hooks).
        'react-hooks/rules-of-hooks': 'error',

        // ADVISORY, and OFF on purpose: this codebase deliberately controls its own
        // effect dependencies. `useLiveEvents` keys on a JOINED channel string so a
        // fresh array literal each render doesn't tear down the EventSource, and
        // RoomFreeRoam's autosave effect must not re-run on every clock tick. Adding
        // the "missing" deps would reintroduce bugs Phase 2 fixed.
        'react-hooks/exhaustive-deps': 'off',
      },
    },
    {
      files: ['services/**/*.js'],
      env: { browser: false, node: true },
    },
  ],
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.prisma/**',
    'web/dist/**',
    '**/migrations/**',
    // Quarantined build output pending deletion — see .attic/README.md.
    '.attic/**',
  ],
};
