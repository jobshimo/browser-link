import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_SETTLE_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
  MAX_SETTLE_MS,
  MAX_SETTLE_TIMEOUT_MS,
  resolveSettleParams,
  settleSafely,
} from './settle.js';

describe('resolveSettleParams', () => {
  test('defaults to DEFAULT_SETTLE_MS / DEFAULT_SETTLE_TIMEOUT_MS when params are absent', () => {
    expect(resolveSettleParams({})).toEqual({
      settleMs: DEFAULT_SETTLE_MS,
      settleTimeoutMs: DEFAULT_SETTLE_TIMEOUT_MS,
    });
  });

  test('settle_ms: 0 disables settle entirely (returns null)', () => {
    expect(resolveSettleParams({ settle_ms: 0 })).toBeNull();
  });

  test('clamps settle_ms and settle_timeout_ms to their ceilings', () => {
    expect(resolveSettleParams({ settle_ms: 999_999, settle_timeout_ms: 999_999 })).toEqual({
      settleMs: MAX_SETTLE_MS,
      settleTimeoutMs: MAX_SETTLE_TIMEOUT_MS,
    });
  });

  test('non-numeric or negative values fall back to defaults', () => {
    expect(resolveSettleParams({ settle_ms: 'fast', settle_timeout_ms: -5 })).toEqual({
      settleMs: DEFAULT_SETTLE_MS,
      settleTimeoutMs: DEFAULT_SETTLE_TIMEOUT_MS,
    });
  });

  test('valid in-range values pass through unchanged', () => {
    expect(resolveSettleParams({ settle_ms: 300, settle_timeout_ms: 4000 })).toEqual({
      settleMs: 300,
      settleTimeoutMs: 4000,
    });
  });
});

describe('settleSafely', () => {
  const PARAMS = { settleMs: 150, settleTimeoutMs: 2000 };

  test('returns undefined without evaluating when settle is disabled', async () => {
    const evaluate = vi.fn(async () => ({}));
    const out = await settleSafely(evaluate, null);
    expect(out).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('passes the in-page settle result through on success', async () => {
    const settleResult = { settled: true, duration_ms: 180, mutation_count: 3 };
    const evaluate = vi.fn(async () => settleResult);
    const out = await settleSafely(evaluate, PARAMS);
    expect(out).toEqual(settleResult);
  });

  test('NEVER throws when the evaluation rejects — the action already succeeded', async () => {
    // The dominant real-world failure: the action navigated the page and
    // the execution context the settle expression runs in was destroyed.
    // A thrown error here would flip a SUCCESSFUL action to ok:false and
    // bait the agent into a duplicate retry.
    const evaluate = vi.fn(async () => {
      throw new Error('Execution context was destroyed.');
    });
    const out = await settleSafely(evaluate, PARAMS);
    expect(out).toEqual({ settled: false, reason: 'context-destroyed' });
  });

  test('a navigation-flavored error message also maps to context-destroyed', async () => {
    const evaluate = vi.fn(async () => {
      throw new Error('Cannot evaluate: page navigated away');
    });
    const out = await settleSafely(evaluate, PARAMS);
    expect(out).toEqual({ settled: false, reason: 'context-destroyed' });
  });

  test('any other evaluation error degrades to settle-error, still without throwing', async () => {
    const evaluate = vi.fn(async () => {
      throw new Error('WebSocket closed');
    });
    const out = await settleSafely(evaluate, PARAMS);
    expect(out).toEqual({ settled: false, reason: 'settle-error' });
  });

  test('a non-object evaluation result degrades to settle-error', async () => {
    const evaluate = vi.fn(async () => undefined);
    const out = await settleSafely(evaluate, PARAMS);
    expect(out).toEqual({ settled: false, reason: 'settle-error' });
  });
});
