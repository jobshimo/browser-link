// The invariants of `FlowRun` and `FlowRegistry` (design section 4; slice
// 17), on a manual clock.
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../ports/contract/fakes.js';
import { MAX_DETACHED_FLOW_MS } from '../support/flow-limits.js';
import { createFlowRegistry } from './flow-registry.js';
import { flowRunShouldStop, stopFlowRun, type FlowRun } from './flow-run.js';

function run(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    flowId: 'f1',
    tabId: 7,
    title: '',
    startedAt: 1_000,
    steps: 2,
    cancelled: false,
    progress: { step: 0, steps: 2 },
    detached: false,
    ...overrides,
  };
}

describe('FlowRun', () => {
  it('shouldStop turns true at expiresAt, recorded as expired, and not a moment before', () => {
    const detached = run({ detached: true, expiresAt: 5_000 });
    expect(flowRunShouldStop(detached, 4_999)).toBe(false);
    expect(detached.cancelled).toBe(false);
    expect(flowRunShouldStop(detached, 5_000)).toBe(true);
    expect(detached.stopReason).toBe('expired');
  });

  it('shouldStop turns true on cancel; a run without expiresAt never expires', () => {
    const foreground = run();
    expect(flowRunShouldStop(foreground, Number.MAX_SAFE_INTEGER)).toBe(false);
    stopFlowRun(foreground, 'cancelled');
    expect(flowRunShouldStop(foreground, 0)).toBe(true);
  });

  it('cancel is idempotent: the first reason wins and only the first call flips', () => {
    const r = run({ detached: true, expiresAt: 5_000 });
    expect(stopFlowRun(r, 'cancelled')).toBe(true);
    expect(stopFlowRun(r, 'expired')).toBe(false);
    expect(flowRunShouldStop(r, 9_000)).toBe(true);
    expect(r.stopReason).toBe('cancelled');
  });
});

describe('FlowRegistry', () => {
  it('a run is finished exactly once: finish returns it once, then nothing', () => {
    const registry = createFlowRegistry(createManualClock(1_000));
    const registered = registry.register({ flowId: 'f1', tabId: 7, steps: 2 });
    expect(registry.finish('f1')).toBe(registered);
    expect(registry.finish('f1')).toBeUndefined();
    expect(registry.get('f1')).toBeUndefined();
    // A forgotten id is never "still allowed to run".
    expect(registry.shouldStop('f1', 1_000)).toBe(true);
  });

  it('starts a run at the clock time, with expiresAt only when detached', () => {
    const registry = createFlowRegistry(createManualClock(4_200));
    const detached = registry.register({
      flowId: 'd',
      tabId: 7,
      steps: 1,
      detached: true,
      expiresAt: 4_200 + MAX_DETACHED_FLOW_MS,
    });
    const foreground = registry.register({ flowId: 'f', tabId: 8, steps: 1, expiresAt: 9 });
    expect(detached.startedAt).toBe(4_200);
    expect(detached.expiresAt).toBe(4_200 + MAX_DETACHED_FLOW_MS);
    expect(foreground.expiresAt).toBeUndefined();
  });

  it('one detached flow per tab: detachedForTab names it until it finishes', () => {
    const registry = createFlowRegistry(createManualClock());
    registry.register({ flowId: 'fg', tabId: 7, steps: 1 });
    expect(registry.detachedForTab(7)).toBeUndefined();
    registry.register({ flowId: 'd1', tabId: 7, steps: 1, detached: true, expiresAt: 10 });
    expect(registry.detachedForTab(7)?.flowId).toBe('d1');
    expect(registry.detachedForTab(8)).toBeUndefined();
    registry.finish('d1');
    expect(registry.detachedForTab(7)).toBeUndefined();
  });

  it('cancel of an unknown or finished id is a no-op answering false', () => {
    const registry = createFlowRegistry(createManualClock());
    expect(registry.cancel('nope')).toBe(false);
    registry.register({ flowId: 'f1', tabId: 7, steps: 1 });
    registry.finish('f1');
    expect(registry.cancel('f1')).toBe(false);
    expect(registry.cancelForTab(7)).toBe(0);
  });

  it('holds the idle clock until each run’s own bound, and forgets a deadline at finish', () => {
    const registry = createFlowRegistry(createManualClock(1_000));
    registry.register({ flowId: 'fg', tabId: 7, steps: 1, foregroundDeadlineAt: 31_000 });
    registry.register({ flowId: 'no-deadline', tabId: 8, steps: 1 });
    registry.register({
      flowId: 'd',
      tabId: 9,
      steps: 1,
      detached: true,
      expiresAt: 50_000,
      foregroundDeadlineAt: 2_000,
    });
    expect(registry.idleHolds()).toEqual([
      { tabId: 7, holdUntil: 31_000 },
      { tabId: 8, holdUntil: 1_000 + MAX_DETACHED_FLOW_MS },
      { tabId: 9, holdUntil: 50_000 },
    ]);
    registry.finish('fg');
    expect(registry.idleHolds().map((h) => h.tabId)).toEqual([8, 9]);
    // The same flow id registered again carries no stale deadline.
    registry.register({ flowId: 'fg', tabId: 7, steps: 1 });
    expect(registry.idleHolds().at(-1)).toEqual({
      tabId: 7,
      holdUntil: 1_000 + MAX_DETACHED_FLOW_MS,
    });
  });
});
