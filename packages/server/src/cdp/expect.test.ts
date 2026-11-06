import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_EXPECT_TIMEOUT_MS,
  MAX_EXPECT_TIMEOUT_MS,
  alreadyHeldExpectations,
  beginExpect,
  resolveExpectParams,
  unmetExpectations,
  verifyExpect,
  type ExpectBaseline,
} from './expect.js';

describe('resolveExpectParams', () => {
  test('returns null when expect is absent, empty or only url_changed:false', () => {
    expect(resolveExpectParams(undefined)).toBeNull();
    expect(resolveExpectParams({})).toBeNull();
    expect(resolveExpectParams({ url_changed: false })).toBeNull();
    expect(resolveExpectParams('nope')).toBeNull();
  });

  test('maps every condition and defaults the window', () => {
    expect(
      resolveExpectParams({
        url_changed: true,
        selector_appears: '#a',
        selector_disappears: '#b',
        text_appears: 'Done',
      }),
    ).toEqual({
      urlChanged: true,
      selectorAppears: '#a',
      selectorDisappears: '#b',
      textAppears: 'Done',
      timeoutMs: DEFAULT_EXPECT_TIMEOUT_MS,
    });
  });

  test('clamps timeout_ms into (0, MAX] and ignores garbage', () => {
    expect(resolveExpectParams({ url_changed: true, timeout_ms: 999_999 })?.timeoutMs).toBe(
      MAX_EXPECT_TIMEOUT_MS,
    );
    expect(resolveExpectParams({ url_changed: true, timeout_ms: 250 })?.timeoutMs).toBe(250);
    expect(resolveExpectParams({ url_changed: true, timeout_ms: -1 })?.timeoutMs).toBe(
      DEFAULT_EXPECT_TIMEOUT_MS,
    );
    expect(resolveExpectParams({ url_changed: true, timeout_ms: 'x' })?.timeoutMs).toBe(
      DEFAULT_EXPECT_TIMEOUT_MS,
    );
  });
});

describe('unmetExpectations', () => {
  const spec = resolveExpectParams({
    url_changed: true,
    selector_appears: '#a',
    selector_disappears: '#b',
    text_appears: 'Done',
  })!;
  const baseline: ExpectBaseline = { url: 'https://x/1' };

  test('lists every condition that does not hold', () => {
    expect(unmetExpectations(spec, baseline, { url: 'https://x/1' })).toEqual([
      'url_changed',
      'selector_appears "#a"',
      'selector_disappears "#b"',
      'text_appears "Done"',
    ]);
  });

  test('is empty when all hold', () => {
    expect(
      unmetExpectations(spec, baseline, {
        url: 'https://x/2',
        selector_appears: true,
        selector_disappears: true,
        text_appears: true,
      }),
    ).toEqual([]);
  });

  test('url_changed with an unknown start url never counts as met', () => {
    const s = resolveExpectParams({ url_changed: true })!;
    expect(unmetExpectations(s, undefined, { url: 'https://x/2' })).toEqual(['url_changed']);
  });

  test('an invalid selector is surfaced as its own unmet reason', () => {
    const s = resolveExpectParams({ selector_disappears: '##bad[' })!;
    expect(
      unmetExpectations(s, undefined, { url: 'u', invalid_selector: 'selector_disappears' }),
    ).toEqual(['selector_disappears "##bad[" (invalid selector)']);
  });
});

describe('alreadyHeldExpectations (transition semantics)', () => {
  const spec = resolveExpectParams({
    selector_appears: '#a',
    selector_disappears: '#b',
    text_appears: 'Done',
  })!;

  test('flags every condition that already held before the action', () => {
    const baseline: ExpectBaseline = {
      url: 'u',
      observed: {
        url: 'u',
        selector_appears: true,
        selector_disappears: true, // absent already
        text_appears: true,
      },
    };
    expect(alreadyHeldExpectations(spec, baseline)).toEqual([
      'selector_appears "#a" was already present before the action',
      'selector_disappears "#b" was not present before the action',
      'text_appears "Done" was already on the page before the action',
    ]);
  });

  test('is empty when the page was in the opposite state beforehand', () => {
    const baseline: ExpectBaseline = {
      url: 'u',
      observed: {
        url: 'u',
        selector_appears: false,
        selector_disappears: false,
        text_appears: false,
      },
    };
    expect(alreadyHeldExpectations(spec, baseline)).toEqual([]);
  });

  test('is empty without a baseline sample', () => {
    expect(alreadyHeldExpectations(spec, undefined)).toEqual([]);
  });
});

describe('beginExpect', () => {
  test('does not touch the page when nothing is expected', async () => {
    const evaluate = vi.fn();
    expect(await beginExpect(evaluate, null)).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('samples every requested condition and the url before the action', async () => {
    const sample = { url: 'https://x/1', text_appears: false };
    const evaluate = vi.fn(async () => sample);
    const spec = resolveExpectParams({ text_appears: 'x' });
    expect(await beginExpect(evaluate, spec)).toEqual({ url: 'https://x/1', observed: sample });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('verifyExpect', () => {
  const fastSleep = (): Promise<void> => Promise.resolve();

  test('with no spec it is a no-op success without evaluating', async () => {
    const evaluate = vi.fn();
    expect(await verifyExpect(evaluate, null, undefined, undefined)).toEqual({ ok: true });
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('returns met:true with elapsed_ms as soon as the transition completes', async () => {
    const spec = resolveExpectParams({ selector_appears: '#a' })!;
    const baseline: ExpectBaseline = {
      url: 'u',
      observed: { url: 'u', selector_appears: false },
    };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ url: 'u', selector_appears: false })
      .mockResolvedValueOnce({ url: 'u', selector_appears: true });
    let t = 0;
    const out = await verifyExpect(evaluate, spec, baseline, undefined, {
      now: () => (t += 40),
      sleep: fastSleep,
    });
    expect(out).toEqual({ ok: true, expect: { met: true, elapsed_ms: expect.any(Number) } });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  test('a condition that already held fails without waiting or probing', async () => {
    const spec = resolveExpectParams({ selector_appears: '[role=dialog]' })!;
    const baseline: ExpectBaseline = {
      url: 'u',
      observed: { url: 'u', selector_appears: true },
    };
    const evaluate = vi.fn(async () => ({ url: 'u', selector_appears: true }));
    const out = await verifyExpect(
      evaluate,
      spec,
      baseline,
      { settled: true, mutation_count: 0 },
      { now: () => 0, sleep: fastSleep },
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error).toMatch(
      /^expectation not met: selector_appears "\[role=dialog\]" was already present before the action/,
    );
    expect(out.error).toContain('"mutation_count":0');
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('fails with "expectation not met: <which> after <ms>ms" and carries the settle info', async () => {
    const spec = resolveExpectParams({ url_changed: true, timeout_ms: 300 })!;
    const evaluate = vi.fn(async () => ({ url: 'https://x/1' }));
    let t = 0;
    const out = await verifyExpect(
      evaluate,
      spec,
      { url: 'https://x/1' },
      { settled: true, mutation_count: 0 },
      { now: () => (t += 100), sleep: fastSleep },
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error).toMatch(/^expectation not met: url_changed after \d+ms/);
    expect(out.error).toContain('"mutation_count":0');
  });

  test('a probe that throws once (navigation tore down the context) is retried, not fatal', async () => {
    const spec = resolveExpectParams({ url_changed: true })!;
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Execution context was destroyed'))
      .mockResolvedValueOnce({ url: 'https://x/2' });
    const out = await verifyExpect(evaluate, spec, { url: 'https://x/1' }, undefined, {
      now: () => 0,
      sleep: fastSleep,
    });
    expect(out.ok).toBe(true);
  });

  test('a probe that fails on every attempt says so in the error', async () => {
    const spec = resolveExpectParams({ url_changed: true, timeout_ms: 300 })!;
    const evaluate = vi.fn().mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    let t = 0;
    const out = await verifyExpect(evaluate, spec, { url: 'https://x/1' }, undefined, {
      now: () => (t += 100),
      sleep: fastSleep,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error).toMatch(/probe failed \d+ times/);
    expect(out.error).toContain('Cannot access a chrome:// URL');
  });

  test('a probe that never answers cannot overrun the window by more than one poll', async () => {
    const spec = resolveExpectParams({ url_changed: true, timeout_ms: 150 })!;
    const evaluate = vi.fn(() => new Promise<unknown>(() => undefined));
    const startedAt = Date.now();
    const out = await verifyExpect(evaluate, spec, { url: 'https://x/1' }, undefined);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error).toMatch(/probe failed \d+ times/);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  test('an invalid selector fails immediately instead of waiting out the window', async () => {
    const spec = resolveExpectParams({ selector_disappears: '##bad[', timeout_ms: 5000 })!;
    const evaluate = vi.fn(async () => ({ url: 'u', invalid_selector: 'selector_disappears' }));
    const out = await verifyExpect(
      evaluate,
      spec,
      { url: 'u', observed: { url: 'u', selector_disappears: false } },
      undefined,
      { now: () => 0, sleep: fastSleep },
    );
    expect(out.ok).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
