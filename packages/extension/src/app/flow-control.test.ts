// The extension's FlowControl (app/flow-control.ts, slice 18b): the launch
// over the flow registry and history, the refusal of an unpersisted detached
// launch, the retirement of a finished flow, and the status read.
import {
  createFlowHistory,
  createFlowRegistry,
  createManualClock,
  createMemoryDetachedFlowStore,
  createMemoryFlowHistoryStore,
  type FlowLaunch,
  type ToolDeps,
} from '@browser-link/core';
import { describe, expect, it } from 'vitest';
import { createExtensionFlowControl, LAUNCH_NOT_PERSISTED } from './flow-control.js';

function harness(title: Promise<string | undefined> = Promise.resolve('Shop')) {
  const clock = createManualClock(1_000);
  const registry = createFlowRegistry(clock);
  const detached = createMemoryDetachedFlowStore();
  const history = createFlowHistory({
    history: createMemoryFlowHistoryStore(),
    detached,
    clock,
    publish: () => true,
    onRecordLost: () => undefined,
  });
  const ended: [number, number][] = [];
  const flows = createExtensionFlowControl({
    tabId: 7,
    registry,
    history,
    clock,
    tabTitle: () => title,
    stepDeps: () => ({}) as ToolDeps,
    waitDeps: () => ({}) as ToolDeps,
    driver: () => {
      throw new Error('unused');
    },
    flowEnded: (tabId, endedAt) => {
      ended.push([tabId, endedAt]);
    },
  });
  return { clock, registry, detached, history, flows, ended };
}

const launched = (value: FlowLaunch | { refused: string }): FlowLaunch => {
  if ('refused' in value) throw new Error(value.refused);
  return value;
};

describe('extension FlowControl', () => {
  it('registers a foreground run with its deadline and the tab title', async () => {
    const h = harness();
    const run = launched(
      await h.flows.start({ flowId: 'f1', steps: 2, detached: false, deadlineAt: 5_000 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const entry = h.registry.get('f1')!;
    expect(entry).toMatchObject({ tabId: 7, steps: 2, detached: false, title: 'Shop' });
    expect(entry.expiresAt).toBeUndefined();
    expect(run.startedAt).toBe(1_000);
    expect(run.expiresAt).toBeUndefined();
    expect(h.flows.detachedOnTab()).toBeUndefined();
    run.onProgress?.({ step: 2, steps: 2 });
    expect(h.registry.get('f1')!.progress).toEqual({ step: 2, steps: 2 });
    expect(await h.flows.status('f1')).toMatchObject({ flow_id: 'f1', state: 'running' });
  });

  it('mints a flow_ id when the server sent none, and a title failure is ignored', async () => {
    const h = harness(Promise.reject(new Error('No tab with id: 7')));
    launched(
      await h.flows.start({ flowId: undefined, steps: 1, detached: false, deadlineAt: undefined }),
    );
    const [running] = h.registry.listRunning(1_000);
    expect(running.flowId).toMatch(/^flow_[0-9a-f-]{36}$/);
  });

  it('a detached launch persists its record first, expires after the ceiling, and is the tab detached flow', async () => {
    const h = harness();
    const run = launched(
      await h.flows.start({ flowId: 'd1', steps: 3, detached: true, deadlineAt: undefined }),
    );
    expect(run.expiresAt).toBe(1_000 + 30 * 60_000);
    expect(h.flows.detachedOnTab()).toBe('d1');
    expect((await h.detached.list()).map((r) => r.flowId)).toEqual(['d1']);
    expect(run.shouldCancel()).toBe(false);
    h.registry.cancel('d1');
    expect(run.shouldCancel()).toBe(true);
  });

  it('refuses a detached launch whose record will not store, and unregisters it', async () => {
    const h = harness();
    h.detached.refuse = () => true;
    expect(
      await h.flows.start({ flowId: 'd2', steps: 1, detached: true, deadlineAt: undefined }),
    ).toEqual({ refused: LAUNCH_NOT_PERSISTED });
    expect(h.registry.get('d2')).toBeUndefined();
  });

  it('finish retires the run, restarts the idle window from its end and records it once', async () => {
    const h = harness();
    const run = launched(
      await h.flows.start({ flowId: 'f3', steps: 1, detached: false, deadlineAt: undefined }),
    );
    await h.clock.advance(250);
    run.finish(null);
    run.finish(null);
    expect(h.registry.get('f3')).toBeUndefined();
    expect(h.ended).toEqual([[7, 1_250]]);
  });

  it('an id neither the registry nor the records know is unknown', async () => {
    const h = harness();
    expect(await h.flows.status('nope')).toEqual({
      flow_id: 'nope',
      state: 'unknown',
      detached: false,
    });
  });
});
