// ESLint flat config. ESLint 10 + typescript-eslint 8.
//
// What this enforces:
//   - typescript-eslint `strictTypeChecked` ruleset for every .ts/.tsx
//     file in `packages/*/src`. That's the strictest preset that uses
//     type information — catches no-explicit-any, no-unsafe-* and the
//     full strict suite.
//   - `@eslint/js` recommended rules for JavaScript syntax.
//   - Tests get a relaxed slice of the rules (any/non-null/unsafe-* are
//     allowed inside *.test.ts). Type-checking is disabled on tests
//     because `packages/server/tsconfig.json` excludes them — the
//     ts project doesn't know about them, so the type-aware lint rules
//     can't run.
//   - `argsIgnorePattern: '^_'` for unused-vars, matching the standard
//     "prefix with underscore to mark deliberately unused".

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'pnpm-lock.yaml',
      // Build/release scripts are plain JS and not part of the TS project.
      // Leave them out of the type-aware run; if we want to lint them
      // later, a separate non-type-aware block can pick them up.
      'scripts/**',
      'packages/server/scripts/**',
      'packages/extension/scripts/**',
      'packages/extension/copy-assets.mjs',
      // ESLint config itself
      'eslint.config.mjs',
    ],
  },

  // Type-aware lint for source TypeScript only.
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Existing-debt rules — keep visible as warnings so CI doesn't
      // turn red on the introduction of this config. Each one will be
      // promoted back to `error` in a follow-up PR that fixes its
      // cluster of violations. Counts as of the introduction commit:
      //
      //   62 @typescript-eslint/restrict-template-expressions
      //   22 @typescript-eslint/no-unsafe-member-access
      //   19 @typescript-eslint/no-unnecessary-condition
      //   18 @typescript-eslint/no-non-null-assertion
      //   16 @typescript-eslint/no-unsafe-assignment
      //   15 @typescript-eslint/no-unnecessary-type-assertion
      //   12 @typescript-eslint/no-confusing-void-expression
      //   10 @typescript-eslint/no-unsafe-argument
      //    6 @typescript-eslint/use-unknown-in-catch-callback-variable
      //    5 @typescript-eslint/no-explicit-any
      //    4 @typescript-eslint/no-floating-promises
      //    4 @typescript-eslint/no-dynamic-delete
      //    2 @typescript-eslint/no-misused-promises
      //    2 @typescript-eslint/no-base-to-string
      //    2 @typescript-eslint/require-await
      //    2 no-useless-escape
      //    2 no-empty
      //    1 @typescript-eslint/no-deprecated
      //    1 preserve-caught-error
      //
      // Total: 205 warnings.
      // Everything not listed below stays at `strictTypeChecked` defaults
      // (i.e. `error`) — that protects against NEW violations of rules
      // we already comply with.
      //
      // Everything not listed below stays at `strictTypeChecked` defaults
      // (i.e. `error`) — that protects against NEW violations of rules
      // we already comply with.
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-dynamic-delete': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-deprecated': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-confusing-void-expression': 'warn',
      'no-useless-escape': 'warn',
      'no-empty': 'warn',
      'preserve-caught-error': 'warn',
    },
  },

  // Tests: syntax-level lint only. Type-aware rules are off because the
  // server tsconfig excludes *.test.ts from the TS project. We still
  // need the TypeScript parser to understand the syntax — just without
  // hooking the type-checker.
  {
    files: ['packages/*/src/**/*.test.{ts,tsx}'],
    extends: [js.configs.recommended],
    plugins: {
      // Register the plugin so eslint-disable comments referencing
      // its rules don't error with "Definition for rule not found",
      // even though the rules themselves are off here.
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // No `project` / `projectService` here — parse without type info.
      },
      // NodeJS namespace types (e.g. NodeJS.ErrnoException, NodeJS.Timeout)
      // are valid in this codebase but `no-undef` can't see them without
      // type info. Adding the symbol to the globals dictionary silences
      // the false positive without weakening real `no-undef` enforcement.
      globals: { ...globals.node, NodeJS: 'readonly' },
    },
    rules: {
      // Disable the type-aware rules entirely for tests.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
