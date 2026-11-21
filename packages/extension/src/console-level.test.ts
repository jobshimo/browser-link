import { describe, expect, test } from 'vitest';
import { normalizeConsoleLevel } from '@browser-link/core';

describe('normalizeConsoleLevel', () => {
  test('Chrome "warning" is stored as the documented "warn"', () => {
    expect(normalizeConsoleLevel('warning')).toBe('warn');
  });

  test('Log.entryAdded "verbose" is stored as the documented "debug"', () => {
    expect(normalizeConsoleLevel('verbose')).toBe('debug');
  });

  test.each(['log', 'info', 'error', 'debug', 'warn'])('%s is unchanged', (level) => {
    expect(normalizeConsoleLevel(level)).toBe(level);
  });

  test('a missing level defaults to log; other CDP types are kept', () => {
    expect(normalizeConsoleLevel(undefined)).toBe('log');
    expect(normalizeConsoleLevel('table')).toBe('table');
  });
});
