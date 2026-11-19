import { describe, expect, test, vi } from 'vitest';
import { systemClock } from './adapters/system-clock.js';
import { runFlow, type FlowDeps } from '../generated/core/flow/flow-engine.js';

/* The one flow assertion that belongs to the cdp-direct wiring: the engine
 * itself (sequencing, threading, fail-fast) is tested once, in
 * `packages/core/src/flow/`, and compiled here from the generated mirror. */

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
    clock: systemClock,
    ...overrides,
  };
}

describe('runFlow on the cdp-direct wiring', () => {
  test('the cdp wiring of performDrag runs the drag step like any other step', async () => {
    // Mirrors transport.ts's flow-case binding for cdp-direct tabs, which
    // binds core's performDrag as the extension does: the step is run, not
    // refused, and a failing drag fails the flow AT its step with the
    // standalone tool's own error.
    const deps = fakeDeps();
    const ran = await runFlow(
      [{ press: { key: 'Enter' } }, { drag: { from_selector: '#a', to_selector: '#b' } }],
      deps,
    );
    expect(ran.ok).toBe(true);
    if (ran.ok) expect(ran.steps_completed).toBe(2);
    expect(deps.performDrag).toHaveBeenCalledTimes(1);

    const failing = fakeDeps({
      performDrag: vi.fn(async () => ({
        ok: false as const,
        error: 'drag: from_selector #a has no visible box',
      })),
    });
    const result = await runFlow(
      [{ press: { key: 'Enter' } }, { drag: { from_selector: '#a', to_selector: '#b' } }],
      failing,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failed_step).toBe(1);
      expect(result.step_kind).toBe('drag');
      expect(result.steps_completed).toBe(1);
      expect(result.error).toBe('drag: from_selector #a has no visible box');
    }
  });
});
