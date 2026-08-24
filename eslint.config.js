import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.mastra/**',
      'node_modules/**',
      // Vendored: the Mastra skill pack ships with the scaffold and is updated
      // by `create-mastra`, not by hand. Linting it would mean maintaining
      // someone else's code style.
      '.claude/**',
      // Test *data*, not source. The fixture repo is deliberately full
      // of code with known problems — that is the point of it.
      'fixtures/sample-repo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      // Unused args are fine when prefixed with `_` — common in step and tool
      // signatures where the shape is fixed but not every field is needed.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
