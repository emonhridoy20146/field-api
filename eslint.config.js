// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '**/*.cjs', 'templates/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // CLAUDE.md §2.8: domain code gets time from the injected clock, never from the system.
    // Exempt: in-process cache TTLs (rbac/flags/settings), migration timing, the breaker's injectable default.
    files: ['src/modules/**/*.ts', 'src/core/**/*.ts'],
    ignores: ['**/__tests__/**', 'src/core/time/**', 'src/core/db/migrations.ts', 'src/modules/erp-gateway/client/circuit-breaker.ts', 'src/modules/rbac/service.ts', 'src/modules/flags/service.ts', 'src/modules/settings/service.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Use ctx().clock.now() (CLAUDE.md §2.8).' },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Use ctx().clock.now() (CLAUDE.md §2.8).' },
      ],
    },
  },
  {
    // Tests read response bodies loosely; scripts and entrypoints may print.
    files: ['test/**/*.ts', '**/__tests__/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  { files: ['scripts/**/*.ts', 'mock-erp/**/*.ts', 'src/main.ts'], rules: { 'no-console': 'off' } },
  {
    // Vercel function shims (ADR-034): plain ESM JavaScript running on Node.
    files: ['api/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);
