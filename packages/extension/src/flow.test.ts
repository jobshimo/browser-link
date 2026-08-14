import { describe, expect, test, vi } from 'vitest';
import {
  runFlow,
  type ActionOutcome,
  type ClickStepResult,
  type DragStepResult,
  type FindStepResult,
  type FlowDeps,
  type FlowStep,
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
    performDrag: vi.fn(async () => ({
      ok: true,
      result: okDragResult(),
    })) as FlowDeps['performDrag'],
    buildRecoverySnapshot: vi.fn(async () => ({ title: 'recovered', interactive: [] })),
    ...overrides,
  };
}

function okDragResult(overrides: Partial<DragStepResult> = {}): DragStepResult {
  return {
    from: { x: 10, y: 20, selector: '#card' },
    to: { x: 300, y: 20, selector: '#slot' },
    duration_ms_actual: 120,
    drag_mode: 'pointer',
    interception_attempted: false,
    intercept_received: false,
    events_fired: [],
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

  test('hit_element on a click result survives compaction, omitted when absent', async () => {
    const deps = makeDeps({
      performClick: vi.fn(
        async () =>
          ({
            ok: true,
            result: { clicked: '#x', tag: 'button', hit_element: 'div.overlay' },
          }) satisfies ActionOutcome<ClickStepResult>,
      ),
    });
    const result = await runFlow(
      [{ click: { selector: '#x' } }, { press: { key: 'Enter' } }],
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.results).toEqual([{ ok: true, hit_element: 'div.overlay' }, { ok: true }]);
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

describe('runFlow — drag steps', () => {
  test('executes via performDrag and compacts the result to { ok, drag_mode }', async () => {
    const performDrag = vi.fn(
      async () =>
        ({
          ok: true,
          result: okDragResult({ drag_mode: 'html5' }),
        }) satisfies ActionOutcome<DragStepResult>,
    );
    const deps = makeDeps({ performDrag });
    const result = await runFlow(
      [{ drag: { from_selector: '#card', to_selector: '#slot' } }],
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.results).toEqual([{ ok: true, drag_mode: 'html5' }]);
    expect(performDrag).toHaveBeenCalledWith({ from_selector: '#card', to_selector: '#slot' });
  });

  test('coordinate endpoints and duration/hold options pass through unchanged', async () => {
    const deps = makeDeps();
    const params = {
      from_x: 10,
      from_y: 20,
      to_x: 300,
      to_y: 40,
      duration_ms: 500,
      hold_before_move_ms: 100,
      hold_before_release_ms: 200,
    };
    const result = await runFlow([{ drag: params }], deps);
    expect(result.ok).toBe(true);
    expect(deps.performDrag).toHaveBeenCalledWith(params);
  });

  test('drag neither consumes nor sets the implicit target', async () => {
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
    const result = await runFlow(
      [
        { find: { text: 'GIF' } },
        { drag: { from_selector: '#card', to_selector: '#slot' } },
        { click: {} },
      ],
      deps,
    );
    expect(result.ok).toBe(true);
    // The drag step received EXACTLY its own params — no injected selector —
    // and the find's implicit target survived it for the later click.
    expect(deps.performDrag).toHaveBeenCalledWith({ from_selector: '#card', to_selector: '#slot' });
    expect(performClick).toHaveBeenCalledWith(expect.objectContaining({ selector: '#gif-btn' }));
  });

  test('a failing drag stops the flow with step_kind drag and the standalone error string', async () => {
    const deps = makeDeps({
      performDrag: vi.fn(async () => ({
        ok: false,
        error: 'drag: provide from_selector or both from_x and from_y',
      })) as FlowDeps['performDrag'],
    });
    const result = await runFlow(
      [{ drag: { to_selector: '#slot' } }, { press: { key: 'Enter' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failed_step).toBe(0);
    expect(result.step_kind).toBe('drag');
    expect(result.error).toBe('drag: provide from_selector or both from_x and from_y');
    expect(result.recovery_snapshot).toEqual({ title: 'recovered', interactive: [] });
    expect(deps.performPress).not.toHaveBeenCalled();
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

describe('runFlow — sleep step', () => {
  test('pauses for the requested time and reports it back', async () => {
    const deps = makeDeps();
    const started = Date.now();
    const result = await runFlow([{ sleep: { ms: 40 } }], deps);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.results).toEqual([{ slept_ms: 40 }]);
    // Timer resolution is coarse; assert the pause really happened without
    // being brittle about the exact millisecond.
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  test('names no element, so it neither consumes nor sets the implicit target', async () => {
    // find leaves '#found' pending; the sleep must not eat it, so the
    // selector-less click AFTER the sleep still resolves against it.
    const performClick = vi.fn<FlowDeps['performClick']>().mockResolvedValue({
      ok: true,
      result: { clicked: '#found', tag: 'button' },
    });
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#found' })) as FlowDeps['performFind'],
      performClick,
    });

    const result = await runFlow(
      [{ find: { text: 'Delete' } }, { sleep: { ms: 1 } }, { click: {} }],
      deps,
    );

    expect(result.ok).toBe(true);
    expect(performClick).toHaveBeenCalledWith(expect.objectContaining({ selector: '#found' }));
  });

  test('does NOT clear a pending navigation-race hint — a sleep proves nothing', async () => {
    // find/wait_for/drag clear the hint because each probes the document.
    // A sleep just waits, so the hint must still fire on the next failure.
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
        { sleep: { ms: 1 } },
        { click: { selector: '#next' } },
      ],
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failed_step).toBe(2);
    expect(result.error).toContain('context-destroyed');
    expect(result.error).toContain('insert a wait_for step');
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 12.5],
    ['over the 30s ceiling', 30_001],
  ])('rejects %s ms with a recovery snapshot and dispatches nothing after it', async (_l, ms) => {
    const deps = makeDeps();
    const result = await runFlow([{ sleep: { ms } }, { click: { selector: '#never' } }], deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failed_step).toBe(0);
    expect(result.step_kind).toBe('sleep');
    expect(result.error).toContain('sleep: ms must be an integer between 1 and 30000');
    expect(result.recovery_snapshot).toEqual({ title: 'recovered', interactive: [] });
    // Fail-fast: the step after the bad sleep must never run.
    expect(deps.performClick).not.toHaveBeenCalled();
  });

  test('rejects a sleep step with no ms at all', async () => {
    const deps = makeDeps();
    const result = await runFlow([{ sleep: {} as unknown as { ms: number } }], deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('sleep: ms must be an integer');
  });
});

describe('runFlow — repeat step', () => {
  test('with no while_found, runs exactly max_iterations times', async () => {
    const performClick = vi.fn<FlowDeps['performClick']>().mockResolvedValue({
      ok: true,
      result: { clicked: '#row', tag: 'button' },
    });
    const deps = makeDeps({ performClick });

    const result = await runFlow(
      [{ repeat: { steps: [{ click: { selector: '#row' } }], max_iterations: 3 } }],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(performClick).toHaveBeenCalledTimes(3);
    expect(result.results).toEqual([
      {
        iterations_completed: 3,
        stopped_by: 'max_iterations',
        iterations: [[{ ok: true }], [{ ok: true }], [{ ok: true }]],
      },
    ]);
  });

  test('while_found stops the loop the first time it does not match', async () => {
    // The probe is a wait_for with timeout_ms:0 — matched twice, then not.
    const performWaitFor = vi
      .fn<FlowDeps['performWaitFor']>()
      .mockResolvedValueOnce({ ok: true, result: { matched: true, elapsed_ms: 1, checks: 1 } })
      .mockResolvedValueOnce({ ok: true, result: { matched: true, elapsed_ms: 1, checks: 1 } })
      .mockResolvedValueOnce({
        ok: true,
        result: { matched: false, elapsed_ms: 1, checks: 1, reason: 'timeout' },
      });
    const performClick = vi.fn<FlowDeps['performClick']>().mockResolvedValue({
      ok: true,
      result: { clicked: '#row', tag: 'button' },
    });
    const deps = makeDeps({ performWaitFor, performClick });

    const result = await runFlow(
      [
        {
          repeat: {
            steps: [{ click: { selector: '.row button' } }],
            max_iterations: 50,
            while_found: '.row',
          },
        },
      ],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(performClick).toHaveBeenCalledTimes(2);
    expect(result.results[0]).toMatchObject({
      iterations_completed: 2,
      stopped_by: 'condition',
    });
    // The probe must be a ONE-SHOT presence test, never a real wait.
    expect(performWaitFor).toHaveBeenCalledWith({
      selector: '.row',
      condition: 'visible',
      timeout_ms: 0,
    });
  });

  test('max_iterations still caps a while_found that never stops matching', async () => {
    const deps = makeDeps();
    const result = await runFlow(
      [
        {
          repeat: {
            steps: [{ press: { key: 'Enter' } }],
            max_iterations: 4,
            while_found: '.row',
          },
        },
      ],
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.results[0]).toMatchObject({
      iterations_completed: 4,
      stopped_by: 'max_iterations',
    });
  });

  test('a failing inner step fails the whole flow, naming the iteration and inner index', async () => {
    const performClick = vi
      .fn<FlowDeps['performClick']>()
      .mockResolvedValueOnce({ ok: true, result: { clicked: '#row', tag: 'button' } })
      .mockResolvedValueOnce({ ok: false, error: 'Element not found: #row' });
    const deps = makeDeps({ performClick });

    const result = await runFlow(
      [{ repeat: { steps: [{ click: { selector: '#row' } }], max_iterations: 5 } }],
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.step_kind).toBe('repeat');
    expect(result.failed_step).toBe(0);
    expect(result.error).toContain('repeat: iteration 1, step 0 (click) failed');
    expect(result.error).toContain('Element not found: #row');
    expect(result.recovery_snapshot).toEqual({ title: 'recovered', interactive: [] });
  });

  test('each iteration starts with a FRESH implicit target', async () => {
    // find inside the body feeds the click inside the body, every time.
    const performClick = vi.fn<FlowDeps['performClick']>().mockResolvedValue({
      ok: true,
      result: { clicked: '#found', tag: 'button' },
    });
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#found' })) as FlowDeps['performFind'],
      performClick,
    });

    const result = await runFlow(
      [{ repeat: { steps: [{ find: { text: 'Delete' } }, { click: {} }], max_iterations: 3 } }],
      deps,
    );

    expect(result.ok).toBe(true);
    expect(performClick).toHaveBeenCalledTimes(3);
    for (const call of performClick.mock.calls) {
      expect(call[0]).toMatchObject({ selector: '#found' });
    }
  });

  test('an implicit target does NOT leak out of a repeat body', async () => {
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#inner' })) as FlowDeps['performFind'],
    });
    const result = await runFlow(
      [{ repeat: { steps: [{ find: { text: 'Row' } }], max_iterations: 1 } }, { click: {} }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failed_step).toBe(1);
    expect(result.error).toMatch(/no selector provided and no implicit target/);
  });

  test('an implicit target from BEFORE the repeat does not reach inside it', async () => {
    const deps = makeDeps({
      performFind: vi.fn(async () => okFind({ selector: '#outer' })) as FlowDeps['performFind'],
    });
    const result = await runFlow(
      [{ find: { text: 'Outer' } }, { repeat: { steps: [{ click: {} }], max_iterations: 1 } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.step_kind).toBe('repeat');
    expect(result.error).toContain('no selector provided and no implicit target');
  });

  test('rejects a nested repeat', async () => {
    const deps = makeDeps();
    const nested = {
      repeat: {
        steps: [{ repeat: { steps: [{ press: { key: 'a' } }], max_iterations: 2 } }],
        max_iterations: 2,
      },
    } as unknown as FlowStep;
    const result = await runFlow([nested], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('nesting is not supported');
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', undefined],
    ['zero', 0],
    ['non-integer', 2.5],
    ['over the 500 cap', 501],
  ])('rejects max_iterations %s and dispatches nothing', async (_label, max) => {
    const deps = makeDeps();
    const step = {
      repeat: { steps: [{ press: { key: 'a' } }], max_iterations: max },
    } as unknown as FlowStep;
    const result = await runFlow([step], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('repeat: max_iterations is required');
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test('delay_ms pauses between iterations', async () => {
    const deps = makeDeps();
    const started = Date.now();
    const result = await runFlow(
      [{ repeat: { steps: [{ press: { key: 'a' } }], max_iterations: 3, delay_ms: 25 } }],
      deps,
    );
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    // 3 iterations x 25ms; generous slack for timer coarseness.
    expect(elapsed).toBeGreaterThanOrEqual(55);
  });

  test('counts inner steps against the 20-step ceiling', async () => {
    const deps = makeDeps();
    const inner = Array.from({ length: 20 }, () => ({ press: { key: 'a' } }));
    const result = await runFlow([{ repeat: { steps: inner, max_iterations: 1 } }], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    // 1 repeat + 20 inner = 21.
    expect(result.error).toContain('at most 20 steps allowed, got 21');
    expect(deps.performPress).not.toHaveBeenCalled();
  });
});

describe('runFlow — dry_run', () => {
  test('dispatches nothing and projects each step', async () => {
    const deps = makeDeps();
    const result = await runFlow(
      [
        { click: { selector: '#a' } },
        { repeat: { steps: [{ press: { key: 'a' } }], max_iterations: 40, delay_ms: 250 } },
      ],
      deps,
      { dryRun: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.dry_run).toBe(true);
    expect(result.steps_completed).toBe(0);
    expect(result.results).toEqual([
      { step: 'click' },
      {
        step: 'repeat',
        max_iterations: 40,
        inner_steps: 1,
        delay_ms: 250,
        would_start: true,
      },
    ]);
    // The whole point: not a single action was dispatched.
    expect(deps.performClick).not.toHaveBeenCalled();
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test('reports would_start:false when while_found does not match right now', async () => {
    const deps = makeDeps({
      performWaitFor: vi.fn(async () => ({
        ok: true,
        result: { matched: false, elapsed_ms: 1, checks: 1, reason: 'timeout' },
      })) as FlowDeps['performWaitFor'],
    });
    const result = await runFlow(
      [
        {
          repeat: {
            steps: [{ press: { key: 'a' } }],
            max_iterations: 10,
            while_found: '.row',
          },
        },
      ],
      deps,
      { dryRun: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.results[0]).toMatchObject({ while_found: '.row', would_start: false });
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test('a dry run still rejects an invalid repeat', async () => {
    const deps = makeDeps();
    const step = { repeat: { steps: [], max_iterations: 2 } } as unknown as FlowStep;
    const result = await runFlow([step], deps, { dryRun: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('repeat: steps must be a non-empty array');
  });

  test('omitting the options object runs the flow for real (default is NOT a dry run)', async () => {
    const deps = makeDeps();
    const result = await runFlow([{ press: { key: 'a' } }], deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.dry_run).toBeUndefined();
    expect(deps.performPress).toHaveBeenCalledTimes(1);
  });
});

describe('runFlow — cancellation', () => {
  /** A cancel flag that flips itself to true after N observations, which is
   * how a real cancel behaves: the flag is polled once per step and goes
   * true at some point the flow does not control. */
  function cancelAfter(observations: number): () => boolean {
    let seen = 0;
    return () => {
      seen += 1;
      return seen > observations;
    };
  }

  test('stops dispatching mid-flow and returns ok:true with the results so far', async () => {
    const deps = makeDeps({ shouldCancel: cancelAfter(2) });
    const result = await runFlow(
      [
        { press: { key: 'a' } },
        { press: { key: 'b' } },
        { press: { key: 'c' } },
        { press: { key: 'd' } },
      ],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('cancelled');
    // Two steps were allowed through; the flag went true before the third.
    expect(result.steps_completed).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(deps.performPress).toHaveBeenCalledTimes(2);
  });

  test('no action is dispatched after the cancel flag is observed', async () => {
    const deps = makeDeps({ shouldCancel: () => true });
    const result = await runFlow(
      [{ find: { text: 'Delete' } }, { click: {} }, { type: { text: 'x' } }],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('cancelled');
    expect(result.steps_completed).toBe(0);
    // The whole promise of the kill switch: nothing reached the page.
    expect(deps.performFind).not.toHaveBeenCalled();
    expect(deps.performClick).not.toHaveBeenCalled();
    expect(deps.performType).not.toHaveBeenCalled();
    // …and no recovery snapshot either: a cancellation is not a failure.
    expect(deps.buildRecoverySnapshot).not.toHaveBeenCalled();
  });

  test('an uncancelled flow is byte-identical to the pre-cancellation shape', async () => {
    const deps = makeDeps({ shouldCancel: () => false });
    const result = await runFlow([{ press: { key: 'a' } }], deps);
    expect(result).toEqual({ ok: true, steps_completed: 1, results: [{ ok: true }] });
    expect(Object.hasOwn(result, 'stopped_by')).toBe(false);
  });

  test('stops a repeat at an iteration boundary and reports iterations_completed', async () => {
    const deps = makeDeps({ shouldCancel: cancelAfter(3) });
    const result = await runFlow(
      [{ repeat: { steps: [{ press: { key: 'a' } }], max_iterations: 50 } }],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('cancelled');
    // The repeat's own entry survives — partial work is never discarded.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      iterations_completed: 1,
      stopped_by: 'cancelled',
    });
    expect(deps.performPress).toHaveBeenCalledTimes(1);
  });

  test('keeps the results of an iteration cut short mid-way, apart from the completed ones', async () => {
    // Observations: 1 top-level step, 2 iteration top, 3 inner step 0,
    // 4 inner step 1 -> the flag lands between the two inner steps.
    const deps = makeDeps({ shouldCancel: cancelAfter(3) });
    const result = await runFlow(
      [
        {
          repeat: {
            steps: [{ press: { key: 'a' } }, { press: { key: 'b' } }],
            max_iterations: 10,
          },
        },
      ],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const entry = result.results[0] as {
      iterations_completed: number;
      stopped_by: string;
      iterations: unknown[][];
      partial_iteration?: unknown[];
    };
    expect(entry.stopped_by).toBe('cancelled');
    // Zero COMPLETE iterations…
    expect(entry.iterations_completed).toBe(0);
    expect(entry.iterations).toEqual([]);
    // …but the one step that really ran is still reported.
    expect(entry.partial_iteration).toEqual([{ ok: true }]);
    expect(deps.performPress).toHaveBeenCalledTimes(1);
  });

  test('a cancelled while_found probe reports cancelled, not condition', async () => {
    // The probe (a performWaitFor with timeout_ms: 0) comes back
    // matched:false with reason 'cancelled' — which must NOT be read as
    // "the list finally drained".
    const deps = makeDeps({
      shouldCancel: () => false,
      performWaitFor: vi.fn(async () => ({
        ok: true,
        result: { matched: false, elapsed_ms: 0, checks: 1, reason: 'cancelled' },
      })) as FlowDeps['performWaitFor'],
    });
    const result = await runFlow(
      [{ repeat: { steps: [{ press: { key: 'a' } }], max_iterations: 10, while_found: '.row' } }],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('cancelled');
    expect(result.results[0]).toMatchObject({ stopped_by: 'cancelled', iterations_completed: 0 });
  });

  test('a wait_for cut short by the cancel flag is a cancellation, not a timeout failure', async () => {
    const deps = makeDeps({
      shouldCancel: () => false,
      performWaitFor: vi.fn(async () => ({
        ok: true,
        // What a poll loop returns when the flag flipped mid-wait: it never
        // reached its 30s deadline, so calling this a timeout would be a
        // fabricated diagnosis.
        result: { matched: false, elapsed_ms: 120, checks: 2, reason: 'cancelled' },
      })) as FlowDeps['performWaitFor'],
    });
    const result = await runFlow(
      [{ press: { key: 'a' } }, { wait_for: { selector: '.done', timeout_ms: 30_000 } }],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('cancelled');
    // The press completed and is reported; the wait_for did not complete
    // and therefore has no entry.
    expect(result.steps_completed).toBe(1);
    expect(deps.buildRecoverySnapshot).not.toHaveBeenCalled();
  });

  test('a genuine wait_for timeout is still a failure, not a cancellation', async () => {
    const deps = makeDeps({
      shouldCancel: () => false,
      performWaitFor: vi.fn(async () => ({
        ok: true,
        result: { matched: false, elapsed_ms: 5_000, checks: 50, reason: 'timeout' },
      })) as FlowDeps['performWaitFor'],
    });
    const result = await runFlow([{ wait_for: { selector: '.done' } }], deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('condition not met within timeout');
  });

  test('a dry run ignores shouldCancel — there is nothing to stop', async () => {
    const deps = makeDeps({ shouldCancel: () => true });
    const result = await runFlow([{ click: { selector: '#a' } }], deps, { dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.dry_run).toBe(true);
    expect(result.stopped_by).toBeUndefined();
  });
});

describe('runFlow — progress reporting', () => {
  test('reports the step about to run, 1-based, before dispatching it', async () => {
    const seen: unknown[] = [];
    const deps = makeDeps({ onProgress: (p) => seen.push({ ...p }) });
    await runFlow([{ press: { key: 'a' } }, { press: { key: 'b' } }], deps);
    expect(seen).toEqual([
      { step: 1, steps: 2 },
      { step: 2, steps: 2 },
    ]);
  });

  test('reports the iteration inside a repeat, keeping the outer step coordinate', async () => {
    const seen: unknown[] = [];
    const deps = makeDeps({ onProgress: (p) => seen.push({ ...p }) });
    await runFlow(
      [
        { press: { key: 'a' } },
        { repeat: { steps: [{ press: { key: 'b' } }], max_iterations: 2 } },
      ],
      deps,
    );
    expect(seen).toEqual([
      { step: 1, steps: 2 },
      { step: 2, steps: 2 },
      { step: 2, steps: 2, iteration: 1, iterations: 2 },
      { step: 2, steps: 2, iteration: 2, iterations: 2 },
    ]);
  });

  test('a flow with no onProgress dep runs exactly as before', async () => {
    const deps = makeDeps();
    const result = await runFlow([{ press: { key: 'a' } }], deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.steps_completed).toBe(1);
  });
});
