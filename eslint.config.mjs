// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/drizzle/**', '**/coverage/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,

  // TypeScript app code: type-aware rules.
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Strictness the codebase relies on (see CLAUDE.md rule 12).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      // A forgotten await on a DB or POS call silently breaks ordering guarantees.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Nest DTOs and modules use empty classes on purpose.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },

  // Plain Node scripts (Claude hooks, tooling).
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
