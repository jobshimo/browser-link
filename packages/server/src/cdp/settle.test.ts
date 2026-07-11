import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SETTLE_MS,
  MAX_SETTLE_MS,
  MAX_SETTLE_TIMEOUT_MS,
  resolveSettleParams,
  settleSafely,
} from './settle.js';

/* Local execution coverage of the server's verbatim settle copy. */

describe('resolveSettleParams', () => {
  test('defaults settle ON with the default quiet period', () => {
    expect(resolveSettleParams({})).toEqual({
      settleMs: DEFAULT_SETTLE_MS,
      settleTimeoutMs: 2000,
    });
  });

  test('settle_ms: 0 disables settle (returns null)', () => {
    expect(resolveSettleParams({ settle_ms: 0 })).toBeNull();
  });

  test('clamps settle_ms to MAX_SETTLE_MS', () => {
    expect(resolveSettleParams({ settle_ms: 99999 })?.settleMs).toBe(MAX_SETTLE_MS);
  });

  test('clamps settle_timeout_ms to MAX_SETTLE_TIMEOUT_MS', () => {
    expect(resolveSettleParams({ settle_ms: 100, settle_timeout_ms: 99999 })?.settleTimeoutMs).toBe(
      MAX_SETTLE_TIMEOUT_MS,
    );
  });
});

describe('settleSafely', () => {
  test('returns undefined when settle is disabled', async () => {
    expect(await settleSafely(async () => ({}), null)).toBeUndefined();
  });

  test('returns the in-page settle object on success', async () => {
    const result = await settleSafely(
      async () => ({ settled: true, duration_ms: 5, mutation_count: 0 }),
      { settleMs: 100, settleTimeoutMs: 2000 },
    );
    expect(result).toEqual({ settled: true, duration_ms: 5, mutation_count: 0 });
  });

  test('degrades to context-destroyed rather than throwing when the page navigated', async () => {
    const result = await settleSafely(
      () => Promise.reject(new Error('Execution context was destroyed')),
      { settleMs: 100, settleTimeoutMs: 2000 },
    );
    expect(result).toEqual({ settled: false, reason: 'context-destroyed' });
  });

  test('a non-navigation error degrades to settle-error', async () => {
    const result = await settleSafely(() => Promise.reject(new Error('something else')), {
      settleMs: 100,
      settleTimeoutMs: 2000,
    });
    expect(result).toEqual({ settled: false, reason: 'settle-error' });
  });
});
