import { describe, expect, test, vi } from 'vitest';
import { MAX_FLOW_STEPS, runFlow, type FlowDeps, type FlowStep } from './flow.js';

/* Local execution coverage of the server's verbatim flow copy — sequencing,
 * implicit-target threading, fail-fast — with fully faked perform* deps (no
 * CDP client needed). */

function fakeDeps(overrides: Partial<FlowDeps> = {}): FlowDeps {
  return {
    performFind: vi.fn(async () => ({ ok: true, result: { matched: true, selector: '#found' } })),
    performClick: vi.fn(async () => ({ ok: true, result: { clicked: '#x', tag: 'button' } })),
    performType: vi.fn(async () => ({ ok: true, result: { typed: 2 } })),
    performPress: vi.fn(async () => ({ ok: true, result: { key: 'Enter', modifiers: [] } })),
    performWaitFor: vi.fn(async () => ({
      ok: true,
      result: { matched: true, elapsed_ms: 1, checks: 1 },
    })),
    performDrag: vi.fn(async () => ({
      ok: true,
      result: {
        from: { x: 1, y: 2, selector: '#a' },
        to: { x: 3, y: 4, selector: '#b' },
        duration_ms_actual: 50,
        drag_mode: 'pointer' as const,
        interception_attempted: false,
        intercept_received: false,
        events_fired: [],
      },
    })),
    buildRecoverySnapshot: vi.fn(async () => ({ interactive: [] })),
    ...overrides,
  };
}

describe('runFlow', () => {
  test('rejects an empty step array', async () => {
    const result = await runFlow([], fakeDeps());
    expect(result.ok).toBe(false);
  });

  test('rejects more than MAX_FLOW_STEPS steps', async () => {
    const steps = Array.from({ length: MAX_FLOW_STEPS + 1 }, () => ({
      press: { key: 'a' },
    })) as FlowStep[];
    const result = await runFlow(steps, fakeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(new RegExp(`${MAX_FLOW_STEPS}`));
  });

  test('rejects an unknown step shape', async () => {
    const result = await runFlow([{ mystery: {} } as unknown as FlowStep], fakeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step_kind).toBe('unknown');
  });

  test('threads a find selector as the implicit target for the next click', async () => {
    const deps = fakeDeps();
    const result = await runFlow([{ find: { text: 'Save' } }, { click: {} }], deps);
    expect(result.ok).toBe(true);
    expect(deps.performClick).toHaveBeenCalledWith(expect.objectContaining({ selector: '#found' }));
  });

  test('a click step surfaces hit_element when the click result carries it', async () => {
    const deps = fakeDeps({
      performClick: vi.fn(async () => ({
        ok: true,
        result: { clicked: '#x', tag: 'button', hit_element: 'div.overlay' },
      })),
    });
    const result = await runFlow(
      [{ click: { selector: '#x' } }, { press: { key: 'Enter' } }],
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toEqual([{ ok: true, hit_element: 'div.overlay' }, { ok: true }]);
    }
  });

  test('fails fast: a failing step stops the flow and returns a recovery snapshot', async () => {
    const deps = fakeDeps({
      performClick: vi.fn(async () => ({ ok: false, error: 'Element not found: #x' })),
    });
    const result = await runFlow(
      [{ click: { selector: '#x' } }, { press: { key: 'Enter' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failed_step).toBe(0);
      expect(result.error).toMatch(/Element not found/);
      expect(result.recovery_snapshot).toEqual({ interactive: [] });
    }
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test('a wait_for non-match stops the flow', async () => {
    const deps = fakeDeps({
      performWaitFor: vi.fn(async () => ({
        ok: true,
        result: { matched: false, elapsed_ms: 5000, checks: 50 },
      })),
    });
    const result = await runFlow([{ wait_for: { selector: '#late' } }], deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/condition not met/);
  });

  test('a drag step executes via the injected performDrag and compacts to { ok, drag_mode }', async () => {
    const deps = fakeDeps();
    const result = await runFlow([{ drag: { from_selector: '#a', to_x: 300, to_y: 40 } }], deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results).toEqual([{ ok: true, drag_mode: 'pointer' }]);
    expect(deps.performDrag).toHaveBeenCalledWith({ from_selector: '#a', to_x: 300, to_y: 40 });
  });

  test('a drag step does not consume the implicit target from a preceding find', async () => {
    const deps = fakeDeps();
    const result = await runFlow(
      [
        { find: { text: 'Save' } },
        { drag: { from_selector: '#a', to_selector: '#b' } },
        { click: {} },
      ],
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.performDrag).toHaveBeenCalledWith({ from_selector: '#a', to_selector: '#b' });
    expect(deps.performClick).toHaveBeenCalledWith(expect.objectContaining({ selector: '#found' }));
  });

  test('the cdp wiring style of performDrag (always ok:false) fails the flow with the unsupported error', async () => {
    // Mirrors transport.ts's flow-case binding for cdp-direct tabs, where
    // drag is out of v1 scope — the flow must fail fast AT the drag step
    // with the exact standalone-tool error, after earlier steps ran.
    const deps = fakeDeps({
      performDrag: vi.fn(async () => ({
        ok: false as const,
        error:
          'browser.drag is not supported over cdp-direct in v1. Use a tab connected through the Chrome extension instead.',
      })),
    });
    const result = await runFlow(
      [{ press: { key: 'Enter' } }, { drag: { from_selector: '#a', to_selector: '#b' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failed_step).toBe(1);
      expect(result.step_kind).toBe('drag');
      expect(result.steps_completed).toBe(1);
      expect(result.error).toMatch(/not supported over cdp-direct/);
      expect(result.error).toMatch(/Chrome extension/);
    }
  });
});

describe('runFlow — cancellation (verbatim copy)', () => {
  test('stops dispatching and returns ok:true with the results so far', async () => {
    let observations = 0;
    const deps = fakeDeps({
      shouldCancel: () => {
        observations += 1;
        return observations > 1;
      },
    });
    const result = await runFlow([{ press: { key: 'a' } }, { press: { key: 'b' } }], deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('cancelled');
    expect(result.steps_completed).toBe(1);
    expect(deps.performPress).toHaveBeenCalledTimes(1);
  });

  test('a repeat stops at an iteration boundary and reports what it completed', async () => {
    let observations = 0;
    const deps = fakeDeps({
      shouldCancel: () => {
        observations += 1;
        return observations > 3;
      },
    });
    const result = await runFlow(
      [{ repeat: { steps: [{ press: { key: 'a' } }], max_iterations: 20 } }],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('cancelled');
    expect(result.results[0]).toMatchObject({
      stopped_by: 'cancelled',
      iterations_completed: 1,
    });
  });

  test('a wait_for cut short by the flag is a cancellation, not a timeout failure', async () => {
    const deps = fakeDeps({
      performWaitFor: vi.fn(async () => ({
        ok: true as const,
        result: { matched: false, elapsed_ms: 90, checks: 1, reason: 'cancelled' },
      })),
    });
    const result = await runFlow([{ wait_for: { selector: '.done' } }], deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('cancelled');
    expect(deps.buildRecoverySnapshot).not.toHaveBeenCalled();
  });
});
