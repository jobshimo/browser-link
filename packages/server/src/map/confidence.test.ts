import { describe, expect, test } from 'vitest';
import {
  SITUATIONAL_REASONS,
  STRUCTURAL_REASONS,
  confidenceOf,
  countsAsStructural,
  incrementsStructural,
  type ConfidenceRow,
} from './confidence.js';

const base: ConfidenceRow = {
  ok_n: 0,
  fail_n: 0,
  last_reason: null,
  last_ok_build: null,
  last_fail_build: null,
  last_ok_at: null,
  struct_fail_n: 0,
  struct_fail_build: null,
};

describe('failure reason classes', () => {
  test('structural and situational vocabularies are exactly the spec ones', () => {
    expect([...STRUCTURAL_REASONS]).toEqual([
      'not-found',
      'multiple-matches',
      'retargeted',
      'hit-mismatch',
    ]);
    expect([...SITUATIONAL_REASONS]).toEqual(['timeout', 'unsettled', 'unmatched', 'ref-stale']);
  });

  test.each([
    ['not-found', true],
    ['retargeted', true],
    ['expect-failed', true],
    ['timeout', false],
    ['ref-stale', false],
    ['unknown', false],
  ])('countsAsStructural(%s) = %s', (reason, expected) => {
    expect(countsAsStructural(reason)).toBe(expected);
  });
});

describe('incrementsStructural', () => {
  const prev = (last_reason: string | null, last_fail_build: string | null) => ({
    last_reason,
    last_fail_build,
  });

  test.each<[string, string, ReturnType<typeof prev> | null, string | null, boolean]>([
    ['structural reason always', 'not-found', null, 'b1', true],
    ['situational reason never', 'timeout', prev('timeout', 'b1'), 'b1', false],
    ['a first expect-failed', 'expect-failed', null, 'b1', false],
    ['expect-failed after another reason', 'expect-failed', prev('not-found', 'b1'), 'b1', false],
    [
      'expect-failed after one on another build',
      'expect-failed',
      prev('expect-failed', 'b0'),
      'b1',
      false,
    ],
    [
      'expect-failed repeated on the same build',
      'expect-failed',
      prev('expect-failed', 'b1'),
      'b1',
      true,
    ],
  ])('%s', (_label, reason, previous, build, expected) => {
    expect(incrementsStructural(reason, previous, build)).toBe(expected);
  });
});

describe('confidenceOf', () => {
  test.each<[string, Partial<ConfidenceRow>, string | null, string]>([
    ['ok on the current build', { ok_n: 1, last_ok_build: 'B' }, 'B', 'fresh'],
    ['ok on another build only', { ok_n: 3, last_ok_build: 'A' }, 'B', 'unverified'],
    ['ok without a known build', { ok_n: 3, last_ok_build: null }, 'B', 'unverified'],
    ['current build unknown', { ok_n: 3, last_ok_build: 'B' }, null, 'unverified'],
    ['never ok, never failed', {}, 'B', 'unverified'],
    [
      'two structural failures on the current build',
      { ok_n: 5, last_ok_build: 'B', fail_n: 2, struct_fail_n: 2, struct_fail_build: 'B' },
      'B',
      'failing',
    ],
    [
      'two structural failures on an older build',
      { ok_n: 5, last_ok_build: 'A', fail_n: 2, struct_fail_n: 2, struct_fail_build: 'A' },
      'B',
      'unverified',
    ],
    [
      'one structural failure on the current build',
      { ok_n: 5, last_ok_build: 'B', fail_n: 1, struct_fail_n: 1, struct_fail_build: 'B' },
      'B',
      'fresh',
    ],
    [
      'situational failures never change confidence',
      {
        ok_n: 1,
        last_ok_build: 'B',
        fail_n: 9,
        last_reason: 'timeout',
        last_fail_build: 'B',
        struct_fail_n: 0,
      },
      'B',
      'fresh',
    ],
    [
      'failing with an unknown current build is impossible',
      { ok_n: 0, fail_n: 3, struct_fail_n: 3, struct_fail_build: null },
      null,
      'unverified',
    ],
  ])('%s', (_label, row, build, expected) => {
    expect(confidenceOf({ ...base, ...row }, build).confidence).toBe(expected);
  });

  test('returns the raw evidence untouched', () => {
    const row: ConfidenceRow = {
      ...base,
      ok_n: 4,
      fail_n: 1,
      last_reason: 'timeout',
      last_ok_build: 'B',
      last_fail_build: 'A',
      last_ok_at: '2026-11-09T10:00:00.000Z',
    };
    expect(confidenceOf(row, 'B').evidence).toEqual({
      ok_n: 4,
      fail_n: 1,
      last_reason: 'timeout',
      last_ok_build: 'B',
      last_fail_build: 'A',
      last_ok_at: '2026-11-09T10:00:00.000Z',
    });
  });

  test('rows without the structural counters fall back to zero', () => {
    const { struct_fail_n: _n, struct_fail_build: _b, ...legacy } = base;
    expect(confidenceOf({ ...legacy, ok_n: 1, last_ok_build: 'B' }, 'B').confidence).toBe('fresh');
  });
});
