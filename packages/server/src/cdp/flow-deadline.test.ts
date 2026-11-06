import { describe, expect, test, vi } from 'vitest';
import { runFlow, type FlowDeps } from './flow.js';

/** Deadline behaviour of the cdp-direct copy of the runner — must match
 * the extension's (`packages/extension/src/flow-deadline.test.ts`). */

function makeDeps(overrides: Partial<FlowDeps> = {}): { deps: FlowDeps } {
  let t = 0;
  const deps: FlowDeps = {
    performFind: vi.fn() as unknown as FlowDeps['performFind'],
    performClick: vi.fn(async () => {
      t += 40;
      return { ok: true as const, result: { clicked: '#a', tag: 'button' } };
    }) as FlowDeps['performClick'],
    performType: vi.fn() as unknown as FlowDeps['performType'],
    performPress: vi.fn(async () => {
      t += 60;
      return { ok: true as const, result: { key: 'a', modifiers: [] } };
    }) as FlowDeps['performPress'],
    performWaitFor: vi.fn() as unknown as FlowDeps['performWaitFor'],
    performDrag: vi.fn() as unknown as FlowDeps['performDrag'],
    buildRecoverySnapshot: vi.fn(async () => ({})),
    now: () => t,
    ...overrides,
  };
  return { deps };
}

describe('cdp runFlow — deadline', () => {
  test('stops at a step boundary with stopped_by timeout and the results so far', async () => {
    const { deps } = makeDeps({ deadlineAt: 100 });
    const result = await runFlow(
      [{ press: { key: 'a' } }, { press: { key: 'b' } }, { press: { key: 'c' } }],
      deps,
    );
    expect(result).toMatchObject({ ok: true, stopped_by: 'timeout', steps_completed: 2 });
  });

  test('a repeat reports the iterations it completed', async () => {
    const { deps } = makeDeps({ deadlineAt: 100 });
    const result = await runFlow(
      [{ repeat: { max_iterations: 10, steps: [{ click: { selector: '#a' } }] } }],
      deps,
    );
    expect(result).toMatchObject({ ok: true, stopped_by: 'timeout' });
    if (!result.ok) throw new Error('expected success');
    expect(result.results[0]).toMatchObject({ iterations_completed: 3, stopped_by: 'timeout' });
  });

  test('a human cancel wins over a passed deadline', async () => {
    const { deps } = makeDeps({ deadlineAt: -1, shouldCancel: () => true });
    const result = await runFlow([{ press: { key: 'a' } }], deps);
    expect(result).toMatchObject({ ok: true, stopped_by: 'cancelled' });
  });
});
