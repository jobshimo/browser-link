import { describe, expect, test } from 'vitest';
import {
  compareSemver,
  computeVersionCheck,
  runningInstalledLine,
  shouldShowVersionBanner,
} from './version-status.js';

describe('compareSemver', () => {
  test('orders by major, then minor, then patch, numerically', () => {
    expect(compareSemver('0.41.0', '0.40.9')).toBeGreaterThan(0);
    expect(compareSemver('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.41.0', '0.41.0')).toBe(0);
  });

  test('ignores a prerelease or build suffix and a leading v', () => {
    expect(compareSemver('v0.41.0', '0.41.0')).toBe(0);
    expect(compareSemver('0.41.0-rc.1', '0.41.0')).toBe(0);
  });

  test('treats missing or non-numeric parts as zero', () => {
    expect(compareSemver('0.41', '0.41.0')).toBe(0);
    expect(compareSemver('garbage', '0.0.0')).toBe(0);
  });
});

describe('computeVersionCheck', () => {
  test('still returns extension, server and aligned as before (touched behaviour)', () => {
    const check = computeVersionCheck({ extension: '0.41.0', server: '0.41.0', installed: null });
    expect(check.extension).toBe('0.41.0');
    expect(check.server).toBe('0.41.0');
    expect(check.aligned).toBe(true);
    const drift = computeVersionCheck({ extension: '0.41.0', server: '0.40.0', installed: null });
    expect(drift.aligned).toBe(false);
  });

  test('aligned is null while no server has reported a version', () => {
    const check = computeVersionCheck({ extension: '0.41.0', server: null, installed: null });
    expect(check).toEqual({
      extension: '0.41.0',
      server: null,
      installed: null,
      aligned: null,
      serverOutdated: false,
    });
  });

  test('serverOutdated is true only when the installed version is newer than the running one', () => {
    const outdated = (server: string | null, installed: string | null): boolean =>
      computeVersionCheck({ extension: '0.41.0', server, installed }).serverOutdated;
    expect(outdated('0.40.0', '0.41.0')).toBe(true);
    expect(outdated('0.41.0', '0.41.0')).toBe(false);
    expect(outdated('0.42.0', '0.41.0')).toBe(false);
    expect(outdated('0.41.0', null)).toBe(false);
    expect(outdated(null, '0.41.0')).toBe(false);
  });
});

describe('shouldShowVersionBanner (existing "server behind" banner)', () => {
  test('hidden when aligned and not outdated', () => {
    const check = computeVersionCheck({
      extension: '0.41.0',
      server: '0.41.0',
      installed: '0.41.0',
    });
    expect(shouldShowVersionBanner(check)).toBe(false);
  });

  test('hidden while no server version is known', () => {
    const check = computeVersionCheck({ extension: '0.41.0', server: null, installed: null });
    expect(shouldShowVersionBanner(check)).toBe(false);
  });

  test('shown when the extension and the server differ, as before', () => {
    const check = computeVersionCheck({ extension: '0.41.0', server: '0.40.0', installed: null });
    expect(shouldShowVersionBanner(check)).toBe(true);
  });
});

describe('runningInstalledLine', () => {
  test('says "Server running X · installed Y" when the installed version differs', () => {
    const check = computeVersionCheck({
      extension: '0.41.0',
      server: '0.40.0',
      installed: '0.41.0',
    });
    expect(runningInstalledLine(check)).toBe('Server running 0.40.0 · installed 0.41.0');
  });

  test('is null when the versions match or either one is unknown', () => {
    const line = (server: string | null, installed: string | null): string | null =>
      runningInstalledLine(computeVersionCheck({ extension: '0.41.0', server, installed }));
    expect(line('0.41.0', '0.41.0')).toBeNull();
    expect(line('0.40.0', null)).toBeNull();
    expect(line(null, '0.41.0')).toBeNull();
  });
});
