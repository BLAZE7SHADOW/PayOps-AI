import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** Layering rules from docs/02-architecture.md §2. */
const restrict = (patterns) => ['error', { patterns }];

export default tseslint.config(
  // scripts/demo holds one-off video recording tools (CommonJS, console output), not product code.
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'fixtures/**', 'scripts/demo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['packages/shared/**'],
    rules: { 'no-restricted-imports': restrict([{ group: ['@payops/*'], message: 'shared depends on nothing internal.' }]) },
  },
  {
    files: ['packages/core/**'],
    rules: { 'no-restricted-imports': restrict([{ group: ['@payops/agents', '@payops/agents/*', '@payops/simulator', '@payops/simulator/*'], message: 'core must not depend on agents or simulator.' }]) },
  },
  {
    files: ['apps/web/**'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': restrict([
        { group: ['@payops/core', '@payops/core/*', '@payops/agents', '@payops/agents/*', '@payops/simulator', '@payops/simulator/*'], message: 'web may only import @payops/shared.' },
        { group: ['lucide-react', 'lucide-react/*'], message: 'Lucide is banned (docs/05-ui-design.md §5).' },
      ]),
    },
  },
);
