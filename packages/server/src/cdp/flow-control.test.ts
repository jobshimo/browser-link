import { afterEach, describe, expect, test, vi } from 'vitest';
import { cdpFlowCancel, createCdpFlowControl } from './flow-control.js';
import { resetDetachedFlowsForTest } from './detached-flows.js';
import type { FlowLaunch } from '../generated/core/flow/flow-control.js';

afterEach(() => {
  resetDetachedFlowsForTest();
});

function build(gate: { allowed: boolean } = { allowed: true }) {
  const release = vi.fn();
  const hold = vi.fn(() => release);
  const control = createCdpFlowControl({
    tabId: 'cdp:T1',
    clock: { now: () => 5_000 },
    steps: () => {
      throw new Error('not used');
    },
    gateAllows: () => gate.allowed,
    hold,
  });
  return { control, hold, release, gate };
}

async function launch(control: ReturnType<typeof build>['control'], detached: boolean) {
  const started = await control.start({ flowId: 'f1', steps: 3, detached, deadlineAt: undefined });
  if ('refused' in started) throw new Error('refused');
  return started as FlowLaunch;
}

describe('a foreground flow on cdp-direct', () => {
  test("is running with live progress while it runs, and is not the tab's detached flow", async () => {
    const { control, hold } = build();
    const launched = await launch(control, false);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(control.detachedOnTab()).toBeUndefined();
    launched.onProgress?.({ step: 3 });
    expect(await control.status('f1')).toMatchObject({
      flow_id: 'f1',
      state: 'running',
      detached: false,
      started_at: expect.any(Number),
      steps: 3,
      steps_completed: 2,
    });
  });

  test('flow_cancel stops it: the next check says stop and the status says cancelling', async () => {
    const { control } = build();
    const launched = await launch(control, false);
    expect(launched.shouldCancel()).toBe(false);
    cdpFlowCancel.cancel('f1');
    expect(launched.shouldCancel()).toBe(true);
    expect(await control.status('f1')).toMatchObject({ state: 'running', cancelling: true });
  });

  test('a revoked grant still stops it, reported through the registry', async () => {
    const { control, gate } = build();
    const launched = await launch(control, false);
    gate.allowed = false;
    expect(launched.shouldCancel()).toBe(true);
    expect(await control.status('f1')).toMatchObject({ state: 'running', cancelling: true });
  });

  test('once it ends the id is unknown and the hold is released', async () => {
    const { control, release } = build();
    const launched = await launch(control, false);
    launched.finish({ ok: true, steps_completed: 3, results: [] });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await control.status('f1')).toEqual({
      flow_id: 'f1',
      state: 'unknown',
      detached: false,
    });
  });

  test('a detached flow keeps its record and its ceiling', async () => {
    const { control } = build();
    const launched = await launch(control, true);
    expect(control.detachedOnTab()).toBe('f1');
    launched.finish({ ok: true, steps_completed: 3, results: [] });
    expect(await control.status('f1')).toMatchObject({ state: 'completed', detached: true });
  });
});
