import { createManualClock, type ManualClock } from '@browser-link/core';
import { describe, expect, test, vi } from 'vitest';
import { runFlow, type FlowDeps } from './flow.js';
import { summarizeFlow, type FlowRegistryEntry } from './flow-registry.js';

/**
 * The runner's own deadline: a foreground flow stops cooperatively at the
 * next step / iteration boundary once `deps.deadlineAt` has passed and
 * answers with what it has, instead of being cut off by the bridge timeout
 * with nothing to show for it.
 */

/** Core's fake `Clock`: time moves only when a test (or a fake action)
 * advances it. */
const makeClock = (): ManualClock => createManualClock(0);

/** Let `runFlow` run up to its next pause, then move the clock: the
 * pause's timer must exist before `advance` can fire it. */
async function advanceAfterPause(clock: ManualClock, ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await clock.advance(ms);
}

function makeDeps(
  clock: ManualClock,
  costPerActionMs: number,
  overrides: Partial<FlowDeps> = {},
): FlowDeps {
  const act = async () => {
    await clock.advance(costPerActionMs);
    return { ok: true as const, result: { key: 'a', modifiers: [] } };
  };
  return {
    performFind: vi.fn(async () => ({ ok: true as const, result: { matched: true } })),
    performClick: vi.fn(async () => {
      await clock.advance(costPerActionMs);
      return { ok: true as const, result: { clicked: '#a', tag: 'button' } };
    }) as FlowDeps['performClick'],
    performType: vi.fn(act) as unknown as FlowDeps['performType'],
    performPress: vi.fn(act) as FlowDeps['performPress'],
    performWaitFor: vi.fn(async () => ({
      ok: true as const,
      result: { matched: true, elapsed_ms: 0, checks: 1 },
    })) as FlowDeps['performWaitFor'],
    performDrag: vi.fn() as unknown as FlowDeps['performDrag'],
    buildRecoverySnapshot: vi.fn(async () => ({})),
    clock,
    ...overrides,
  };
}

describe('runFlow — deadline', () => {
  test('stops at the next step boundary with stopped_by timeout and the results so far', async () => {
    const clock = makeClock();
    const deps = makeDeps(clock, 60, { deadlineAt: 100 });
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
    expect(result.stopped_by).toBe('timeout');
    // t=0 and t=60 are inside the deadline; at t=120 the third is not run.
    expect(result.steps_completed).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(deps.performPress).toHaveBeenCalledTimes(2);
    expect(deps.buildRecoverySnapshot).not.toHaveBeenCalled();
  });

  test('a flow that finishes inside its deadline is byte-identical to before', async () => {
    const clock = makeClock();
    const deps = makeDeps(clock, 10, { deadlineAt: 1_000 });
    const result = await runFlow([{ press: { key: 'a' } }, { press: { key: 'b' } }], deps);
    expect(result).toEqual({
      ok: true,
      steps_completed: 2,
      results: [{ ok: true }, { ok: true }],
    });
  });

  test('a repeat reports the iterations it completed', async () => {
    const clock = makeClock();
    const deps = makeDeps(clock, 40, { deadlineAt: 100 });
    const result = await runFlow(
      [{ repeat: { max_iterations: 10, steps: [{ click: { selector: '#a' } }] } }],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('timeout');
    // iterations start at t=0, 40, 80; the one at t=120 is refused.
    expect(result.results[0]).toMatchObject({
      iterations_completed: 3,
      stopped_by: 'timeout',
    });
    expect(deps.performClick).toHaveBeenCalledTimes(3);
  });

  test('a deadline landing mid-iteration keeps the finished inner steps as partial_iteration', async () => {
    const clock = makeClock();
    const deps = makeDeps(clock, 35, { deadlineAt: 100 });
    const result = await runFlow(
      [
        {
          repeat: {
            max_iterations: 10,
            steps: [{ click: { selector: '#a' } }, { press: { key: 'b' } }],
          },
        },
      ],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.stopped_by).toBe('timeout');
    // iteration 0: t=0,35 -> 70. iteration 1: click at 70 -> 105, then the
    // press is refused.
    expect(result.results[0]).toMatchObject({
      iterations_completed: 1,
      stopped_by: 'timeout',
      partial_iteration: [expect.any(Object)],
    });
  });

  test('a human cancel wins over a passed deadline', async () => {
    const clock = makeClock();
    await clock.advance(500);
    const deps = makeDeps(clock, 0, { deadlineAt: 100, shouldCancel: () => true });
    const result = await runFlow([{ press: { key: 'a' } }], deps);
    expect(result).toMatchObject({ ok: true, stopped_by: 'cancelled', steps_completed: 0 });
  });

  test('a wait_for cut short once the deadline passed is a timeout, not a failure', async () => {
    const clock = makeClock();
    const deps = makeDeps(clock, 0, {
      deadlineAt: 100,
      performWaitFor: vi.fn(async () => {
        await clock.advance(200);
        return {
          ok: true as const,
          result: { matched: false, elapsed_ms: 200, checks: 2, reason: 'cancelled' as const },
        };
      }) as FlowDeps['performWaitFor'],
    });
    const result = await runFlow([{ wait_for: { selector: '#x' } }, { press: { key: 'a' } }], deps);
    expect(result).toMatchObject({ ok: true, stopped_by: 'timeout', steps_completed: 0 });
  });

  test('a sleep never outlives the deadline', async () => {
    const clock = makeClock();
    const deps = makeDeps(clock, 0, { deadlineAt: 1_000 });
    const pending = runFlow([{ sleep: { ms: 30_000 } }, { press: { key: 'a' } }], deps);
    await advanceAfterPause(clock, 1_000);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, stopped_by: 'timeout' });
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test('a repeat delay never outlives the deadline', async () => {
    const clock = makeClock();
    const deps = makeDeps(clock, 0, { deadlineAt: 1_000 });
    const pending = runFlow(
      [{ repeat: { max_iterations: 5, delay_ms: 20_000, steps: [{ press: { key: 'a' } }] } }],
      deps,
    );
    await advanceAfterPause(clock, 1_000);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, stopped_by: 'timeout' });
    expect(deps.performPress).toHaveBeenCalledTimes(1);
  });

  test('settle_timeout_ms reaches the action performers', async () => {
    const clock = makeClock();
    const deps = makeDeps(clock, 0);
    await runFlow(
      [
        { click: { selector: '#a', settle_timeout_ms: 7_000 } },
        { type: { selector: '#a', text: 'x', settle_timeout_ms: 6_000 } },
        { press: { key: 'a', settle_timeout_ms: 5_000 } },
      ],
      deps,
    );
    expect(deps.performClick).toHaveBeenCalledWith(
      expect.objectContaining({ settle_timeout_ms: 7_000 }),
    );
    expect(deps.performType).toHaveBeenCalledWith(
      expect.objectContaining({ settle_timeout_ms: 6_000 }),
    );
    expect(deps.performPress).toHaveBeenCalledWith(
      expect.objectContaining({ settle_timeout_ms: 5_000 }),
    );
  });
});

describe('summarizeFlow — timeout', () => {
  const entry = {
    flowId: 'flow_1',
    tabId: 1,
    steps: 2,
    detached: false,
    startedAt: 0,
    progress: { step: 1, steps: 2 },
    cancelled: false,
  } as unknown as FlowRegistryEntry;

  test('a deadline stop is reported as expired, with the steps it completed', () => {
    const summary = summarizeFlow(entry, {
      ok: true,
      stopped_by: 'timeout',
      steps_completed: 1,
      results: [{ iterations_completed: 4, stopped_by: 'timeout', iterations: [] }],
    });
    expect(summary).toMatchObject({
      outcome: 'expired',
      stepsCompleted: 1,
      iterationsCompleted: 4,
      stoppedBy: 'expired',
    });
  });
});
