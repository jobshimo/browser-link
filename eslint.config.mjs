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

      // `restrict-template-expressions`: promoted to `error` with
      // `allowNumber: true` + `allowBoolean: true`. Interpolating a
      // number into a string is a normal, safe pattern — the rule's
      // raison d'être is to catch `unknown`/`any`/object stringification
      // (which still ERROR out under this config).
      //
      // Counts at v0.7.6, before this PR:
      //   50 Invalid type "number"
      //   11 Invalid type "17529"  (the WS port literal)
      //    1 Invalid type "number | null"
      // → all 62 cleared by `allowNumber: true`.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: true,
          // Other options keep their stricter defaults: allowAny: false,
          // allowNullish: false, allowRegExp: false, allowNever: false.
        },
      ],

      // All other strictTypeChecked rules stay at their default (error).
      // The codebase is at zero violations across them as of v0.7.7;
      // future regressions will fail CI rather than accumulate as
      // silent warnings.
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
