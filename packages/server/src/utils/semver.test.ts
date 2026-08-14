import { describe, expect, test } from 'vitest';
import { compareSemver } from './semver.js';

/**
 * Coverage for the shared semver helper. Both call sites (file-ops version
 * detection and updates registry comparison) previously had their own
 * comparator; this suite enshrines the unified behaviour so a future tweak
 * cannot silently regress either of them.
 */

describe('compareSemver', () => {
  test('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  test('returns negative when a < b on the patch segment', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  test('returns positive when a > b on the minor segment', () => {
    expect(compareSemver('1.3.0', '1.2.9')).toBeGreaterThan(0);
  });

  test('major beats minor and patch', () => {
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  test('null on the left is older than any real version (legacy marker)', () => {
    expect(compareSemver(null, '0.0.1')).toBeLessThan(0);
    expect(compareSemver(null, '0.0.0')).toBeLessThan(0);
  });

  test('null on the right is newer than null on the left (symmetric legacy)', () => {
    expect(compareSemver('0.0.1', null)).toBeGreaterThan(0);
  });

  test('null vs null is equal', () => {
    expect(compareSemver(null, null)).toBe(0);
  });

  test('handles short versions by padding missing segments with 0', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('1', '1.0.0')).toBe(0);
  });

  test('handles long versions (4+ segments)', () => {
    expect(compareSemver('1.2.3.4', '1.2.3.5')).toBeLessThan(0);
    expect(compareSemver('1.2.3.0', '1.2.3')).toBe(0);
  });

  test('non-numeric segments fall back to 0 rather than throwing', () => {
    // Real-world: an npm dist-tag that somehow returned "1.2.x". Better to
    // produce a stable comparison than NaN-poison the result.
    expect(() => compareSemver('1.2.x', '1.2.0')).not.toThrow();
    expect(compareSemver('1.2.x', '1.2.0')).toBe(0);
  });
});
