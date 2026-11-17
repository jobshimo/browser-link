import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    // The generated mirror of packages/core and packages/shared (written by
    // scripts/sync-core.mjs) is never a test here: core's tests run once, in
    // packages/core.
    exclude: ['src/generated/**', ...configDefaults.exclude],
    pool: 'forks',
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.integration.test.ts',
        'src/generated/**',
        'dist/**',
      ],
    },
  },
});
