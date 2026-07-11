import { describe, expect, test, vi } from 'vitest';
import {
  runFlow,
  type ActionOutcome,
  type ClickStepResult,
  type FindStepResult,
  type FlowDeps,
  type PressStepResult,
  type TypeStepResult,
} from './flow.js';

/**
 * Sequencing tests for `runFlow`. Every dependency is a fake — no CDP, no
 * chrome.debugger, no real DOM. This is exactly the point of extracting the
 * step executor into its own module: the fail-fast / implicit-target /
 * result-shaping logic is testable in isolation from the browser.
 */

function makeDeps(overrides: Partial<FlowDeps> = {}): FlowDeps {
  return {
    performFind: vi.fn(async () => ({
      ok: true,
      result: { matched: true, selector: '#default' },
    })) as FlowDeps['performFind'],
    performClick: vi.fn(async () => ({
      ok: true,
      result: { clicked: '#default', tag: 'button' },
    })) as FlowDeps['performClick'],
    performType: vi.fn(async () => ({
      ok: true,
      result: { typed: 5, selector: '#default' },
    })) as FlowDeps['performType'],
    performPress: vi.fn(async () => ({
      ok: true,
      result: { key: 'Enter', modifiers: [] },
    })) as FlowDeps['performPress'],
    performWaitFor: vi.fn(async () => ({
      ok: true,
      result: { matched: true, elapsed_ms: 10, checks: 1 },
    })) as FlowDeps['performWaitFor'],
    buildRecoverySnapshot: vi.fn(async () => ({ title: 'recovered', interactive: [] })),
    ...overrides,
  };
}

function okFind(result: Partial<FindStepResult>): ActionOutcome<FindStepResult> {
  return { ok: true, result: { matched: true, ...result } };
}

describe('runFlow — happy path', () => {
  test('runs every step in order and returns a compact result per step', async () => {
    const deps = makeDeps();
    const result = await runFlow(
      [
        { find: { text: 'GIF', role: 'button' } },
        { click: {} },
        { wait_for: { selector: '[data-testid=picker]', condition: 'visible' } },
        { type: { text: 'shrek' } },
        { press: { key: 'Enter' } },
      ],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.steps_completed).toBe(5);
    expect(result.results).toEqual([
      { selector: '#default' },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
  });

  test('settle object is preserved on action step results, omitted when absent', async () => {
    const deps = makeDeps({
      performClick: vi.fn(
        async () =>
          ({
            ok: true,
            result: { clicked: '#x', tag: 'button', settle: { settled: true, duration_ms: 5 } },
          }) satisfies ActionOutcome<ClickStepResult>,
      ),
    });
    const result = await runFlow([{ click: { selector: '#x' } }], deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.results).toEqual([{ ok: true, settle: { settled: true, duration_ms: 5 } }]);
  });
});

describe('runFlow — implicit target threading', () => {
  test('find sets the implicit target and a following click that omits selector uses it', async () => {
    const performClick = vi.fn(
      async () =>
        ({
          ok: true,
          result: { clicked: '#gif-btn', tag: 'button' },
        }) satisfies ActionOutcome<ClickStepResult>,
    );
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#gif-btn' })),
      performClick,
    });
    const result = await runFlow([{ find: { text: 'GIF' } }, { click: {} }], deps);
    expect(result.ok).toBe(true);
    expect(performClick).toHaveBeenCalledWith(expect.objectContaining({ selector: '#gif-btn' }));
  });

  test('find sets the implicit target and a following type that omits selector uses it', async () => {
    const performType = vi.fn(
      async () =>
        ({
          ok: true,
          result: { typed: 5, selector: '#search' },
        }) satisfies ActionOutcome<TypeStepResult>,
    );
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#search' })),
      performType,
    });
    const result = await runFlow([{ find: { text: 'Search' } }, { type: { text: 'shrek' } }], deps);
    expect(result.ok).toBe(true);
    expect(performType).toHaveBeenCalledWith(
      expect.objectContaining({ selector: '#search', text: 'shrek' }),
    );
  });

  test('explicit selector on the following step overrides the implicit target', async () => {
    const performClick = vi.fn(
      async () =>
        ({
          ok: true,
          result: { clicked: '#explicit', tag: 'button' },
        }) satisfies ActionOutcome<ClickStepResult>,
    );
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#implicit' })),
      performClick,
    });
    const result = await runFlow(
      [{ find: { text: 'GIF' } }, { click: { selector: '#explicit' } }],
      deps,
    );
    expect(result.ok).toBe(true);
    expect(performClick).toHaveBeenCalledWith(expect.objectContaining({ selector: '#explicit' }));
  });

  test('implicit target is single-use: a second omitting click after the first has none fails', async () => {
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#target' })),
    });
    const result = await runFlow([{ find: { text: 'GIF' } }, { click: {} }, { click: {} }], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failed_step).toBe(2);
    expect(result.step_kind).toBe('click');
    expect(result.error).toMatch(/no selector provided and no implicit target/);
  });

  test('type and press with no selector and no implicit target act on the current focus (no failure)', async () => {
    const performType = vi.fn(
      async () => ({ ok: true, result: { typed: 5 } }) satisfies ActionOutcome<TypeStepResult>,
    );
    const performPress = vi.fn(
      async () =>
        ({
          ok: true,
          result: { key: 'Enter', modifiers: [] },
        }) satisfies ActionOutcome<PressStepResult>,
    );
    const deps = makeDeps({ performType, performPress });
    const result = await runFlow([{ type: { text: 'shrek' } }, { press: { key: 'Enter' } }], deps);
    expect(result.ok).toBe(true);
    expect(performType).toHaveBeenCalledWith(
      expect.objectContaining({ selector: undefined, text: 'shrek' }),
    );
    expect(performPress).toHaveBeenCalledWith(expect.objectContaining({ selector: undefined }));
  });
});

describe('runFlow — fail-fast', () => {
  test('stops at the first failing step and reports steps_completed before it', async () => {
    const deps = makeDeps({
      performClick: vi.fn(async () => ({ ok: false, error: 'Element not found: #missing' })),
    });
    const result = await runFlow(
      [{ find: { text: 'GIF' } }, { click: { selector: '#missing' } }, { press: { key: 'Enter' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failed_step).toBe(1);
    expect(result.step_kind).toBe('click');
    expect(result.error).toBe('Element not found: #missing');
    expect(result.steps_completed).toBe(1);
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test('failure includes a recovery_snapshot built via buildRecoverySnapshot', async () => {
    const deps = makeDeps({
      performClick: vi.fn(async () => ({ ok: false, error: 'boom' })),
    });
    const result = await runFlow([{ click: { selector: '#x' } }], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.recovery_snapshot).toEqual({ title: 'recovered', interactive: [] });
    expect(deps.buildRecoverySnapshot).toHaveBeenCalledOnce();
  });

  test('a recovery snapshot failure does not mask the original step error', async () => {
    const deps = makeDeps({
      performClick: vi.fn(async () => ({ ok: false, error: 'original failure' })),
      buildRecoverySnapshot: vi.fn(async () => {
        throw new Error('tab gone');
      }),
    });
    const result = await runFlow([{ click: { selector: '#x' } }], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('original failure');
    expect(result.recovery_snapshot).toBeNull();
  });

  test('wait_for that never matches fails the flow (unlike the standalone tool)', async () => {
    const deps = makeDeps({
      performWaitFor: vi.fn(async () => ({
        ok: true,
        result: { matched: false, elapsed_ms: 5000, checks: 10, reason: 'timeout' },
      })) as FlowDeps['performWaitFor'],
    });
    const result = await runFlow(
      [{ wait_for: { selector: '[data-testid=x]', timeout_ms: 5000 } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.step_kind).toBe('wait_for');
    expect(result.error).toMatch(/condition not met within timeout/);
  });

  test('find with reason not-found fails the flow', async () => {
    const deps = makeDeps({
      performFind: vi.fn(async () => ({
        ok: true,
        result: { matched: false, reason: 'not-found' },
      })),
    });
    const result = await runFlow([{ find: { text: 'nope' } }], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.step_kind).toBe('find');
    expect(result.error).toContain('not-found');
  });

  test('find with multiple-matches fails the flow and lists candidates', async () => {
    const deps = makeDeps({
      performFind: vi.fn(async () => ({
        ok: true,
        result: {
          matched: false,
          reason: 'multiple-matches',
          candidates: [{ selector: '#a', text: 'A', tag: 'button' }],
        },
      })),
    });
    const result = await runFlow([{ find: { text: 'ambiguous text' } }], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('multiple-matches');
    expect(result.error).toContain('#a');
  });

  test('ambiguous find (matched but ambiguous:true) fails the flow', async () => {
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#twin', ambiguous: true })),
    });
    const result = await runFlow([{ find: { text: 'Settings' } }], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.step_kind).toBe('find');
    expect(result.error).toMatch(/ambiguous/);
    expect(result.steps_completed).toBe(0);
  });
});

describe('runFlow — structural validation', () => {
  test('rejects an empty steps array', async () => {
    const deps = makeDeps();
    const result = await runFlow([], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/non-empty array/);
  });

  test('rejects more than the step cap', async () => {
    const deps = makeDeps();
    const steps = Array.from({ length: 21 }, () => ({ press: { key: 'Enter' } }) as const);
    const result = await runFlow(steps, deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/at most 20 steps/);
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test('accepts exactly the step cap', async () => {
    const deps = makeDeps();
    const steps = Array.from({ length: 20 }, () => ({ press: { key: 'Enter' } }) as const);
    const result = await runFlow(steps, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.steps_completed).toBe(20);
  });

  test('rejects a step object with an unrecognized shape', async () => {
    const deps = makeDeps();
    const result = await runFlow(
      // @ts-expect-error — deliberately malformed step for the runtime guard
      [{ navigate: { url: 'https://example.com' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.step_kind).toBe('unknown');
  });

  test('rejects a step object naming more than one kind', async () => {
    const deps = makeDeps();
    const result = await runFlow(
      // @ts-expect-error — deliberately malformed step for the runtime guard
      [{ find: { text: 'GIF' }, click: {} }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.step_kind).toBe('unknown');
  });

  test('rejects a step object carrying extra unrecognized keys next to a valid kind', async () => {
    const deps = makeDeps();
    const result = await runFlow(
      // @ts-expect-error — deliberately malformed step for the runtime guard
      [{ find: { text: 'GIF' }, mystery: 1 }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.step_kind).toBe('unknown');
    expect(deps.performFind).not.toHaveBeenCalled();
  });
});

describe('runFlow — navigation race hint', () => {
  test('appends a page-load-race hint when the previous step settle reported context-destroyed', async () => {
    const performClick = vi
      .fn<FlowDeps['performClick']>()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          clicked: '#nav-link',
          tag: 'a',
          settle: { settled: false, reason: 'context-destroyed' },
        },
      })
      .mockResolvedValueOnce({ ok: false, error: 'Element not found: #next' });
    const deps = makeDeps({ performClick });
    const result = await runFlow(
      [{ click: { selector: '#nav-link' } }, { click: { selector: '#next' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failed_step).toBe(1);
    expect(result.error).toContain('Element not found: #next');
    expect(result.error).toContain('context-destroyed');
    expect(result.error).toContain('insert a wait_for step');
  });

  test('failed find right after a navigating click also carries the hint', async () => {
    const deps = makeDeps({
      performClick: vi.fn(async () => ({
        ok: true,
        result: {
          clicked: '#nav-link',
          tag: 'a',
          settle: { settled: false, reason: 'context-destroyed' },
        },
      })) as FlowDeps['performClick'],
      performFind: vi.fn(async () => ({
        ok: true,
        result: { matched: false, reason: 'not-found' },
      })) as FlowDeps['performFind'],
    });
    const result = await runFlow(
      [{ click: { selector: '#nav-link' } }, { find: { text: 'Dashboard' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('not-found');
    expect(result.error).toContain('insert a wait_for step');
  });

  test('no hint when the previous step settled normally', async () => {
    const performClick = vi
      .fn<FlowDeps['performClick']>()
      .mockResolvedValueOnce({
        ok: true,
        result: { clicked: '#a', tag: 'button', settle: { settled: true, duration_ms: 5 } },
      })
      .mockResolvedValueOnce({ ok: false, error: 'Element not found: #next' });
    const deps = makeDeps({ performClick });
    const result = await runFlow(
      [{ click: { selector: '#a' } }, { click: { selector: '#next' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('Element not found: #next');
    expect(result.error).not.toContain('wait_for');
  });

  test('a successful wait_for between the navigation and the failure clears the hint', async () => {
    const performClick = vi
      .fn<FlowDeps['performClick']>()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          clicked: '#nav-link',
          tag: 'a',
          settle: { settled: false, reason: 'context-destroyed' },
        },
      })
      .mockResolvedValueOnce({ ok: false, error: 'Element not found: #next' });
    const deps = makeDeps({ performClick });
    const result = await runFlow(
      [
        { click: { selector: '#nav-link' } },
        { wait_for: { selector: 'body', condition: 'visible' } },
        { click: { selector: '#next' } },
      ],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    // The page provably loaded (wait_for matched) — the later failure is a
    // genuine miss, not a race, so the hint must not appear.
    expect(result.error).toBe('Element not found: #next');
  });

  test('wait_for timeout right after a navigation does NOT carry the hint (wait_for IS the remedy)', async () => {
    const deps = makeDeps({
      performClick: vi.fn(async () => ({
        ok: true,
        result: {
          clicked: '#nav-link',
          tag: 'a',
          settle: { settled: false, reason: 'context-destroyed' },
        },
      })) as FlowDeps['performClick'],
      performWaitFor: vi.fn(async () => ({
        ok: true,
        result: { matched: false, elapsed_ms: 5000, checks: 10, reason: 'timeout' },
      })) as FlowDeps['performWaitFor'],
    });
    const result = await runFlow(
      [{ click: { selector: '#nav-link' } }, { wait_for: { selector: '#slow', timeout_ms: 5000 } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/condition not met within timeout/);
    expect(result.error).not.toContain('insert a wait_for step');
  });
});
