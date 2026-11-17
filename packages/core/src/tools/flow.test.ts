// The flow, flow_status and flow_cancel entries (design 3.3, slice 18b): what
// the one body asks of the transport's `FlowControl` and `FlowCancel`, the
// launch result, the error texts, and the extension refusing flow_cancel.
import { describe, expect, it } from 'vitest';
import type { FlowControl, FlowLaunch, FlowStart, FlowStepDeps } from '../flow/flow-control.js';
import type { FlowProgress, FlowResult } from '../flow/flow-engine.js';
import { createManualClock, type ManualClock } from '../ports/contract/index.js';
import { TOOL_REGISTRY } from './catalog.js';
import { toolResponse, type ToolOutcome } from './failure.js';
import { dispatchTool } from './registry.js';
import type { Requirement, ToolDeps } from './requirement.js';

const FLOWS: ReadonlySet<Requirement> = new Set<Requirement>(['flows']);
const WITH_CANCEL: ReadonlySet<Requirement> = new Set<Requirement>(['flows', 'flow-cancel']);

const WAIT_STEP = { wait_for: { selector: '#a' } };

interface Fake {
  flows: FlowControl;
  log: string[];
  started: FlowStart[];
  stepOptions: { hidePasswordValues: boolean; stopWaiting?: () => boolean }[];
  finished: (FlowResult | null)[];
  progress: FlowProgress[];
  cancel: { value: boolean };
}

function fakeFlows(
  options: {
    detachedOnTab?: string;
    refuse?: string;
    onProgress?: boolean;
    waitFor?: () => Promise<unknown>;
    ownCancel?: () => boolean;
  } = {},
): Fake {
  const fake: Fake = {
    log: [],
    started: [],
    stepOptions: [],
    finished: [],
    progress: [],
    cancel: { value: false },
    flows: undefined as never,
  };
  const steps = (o: { hidePasswordValues: boolean; stopWaiting?: () => boolean }): FlowStepDeps => {
    fake.stepOptions.push(o);
    const unused = (): Promise<never> => Promise.reject(new Error('unused'));
    return {
      performFind: unused,
      performClick: unused,
      performType: unused,
      performPress: unused,
      performDrag: unused,
      performWaitFor: () =>
        (
          options.waitFor ?? (() => Promise.resolve({ ok: true, result: { matched: true } }))
        )() as never,
      buildRecoverySnapshot: () => Promise.resolve(null),
      clock: createManualClock(),
      ...(options.ownCancel ? { shouldCancel: options.ownCancel } : {}),
    };
  };
  fake.flows = {
    detachedOnTab: () => options.detachedOnTab,
    steps,
    start: (launch) => {
      fake.started.push(launch);
      if (options.refuse !== undefined) return Promise.resolve({ refused: options.refuse });
      const run: FlowLaunch = {
        shouldCancel: () => fake.cancel.value,
        startedAt: 100,
        expiresAt: 1_800_100,
        finish: (result) => {
          fake.finished.push(result);
        },
        ...(options.onProgress
          ? { onProgress: (p: FlowProgress) => void fake.progress.push(p) }
          : {}),
      };
      return Promise.resolve(run);
    },
    status: (flowId) => {
      fake.log.push(`status ${flowId}`);
      return Promise.resolve({ flow_id: flowId, state: 'running' });
    },
  };
  return fake;
}

function deps(fake: Fake, clock: ManualClock = createManualClock(1_000)): ToolDeps {
  return {
    clock,
    flows: fake.flows,
    'flow-cancel': {
      cancel: (id) => {
        fake.log.push(`cancel ${id}`);
      },
    },
  } as unknown as ToolDeps;
}

const call = (
  d: ToolDeps,
  tool: string,
  params: Record<string, unknown>,
  provided: ReadonlySet<Requirement> = FLOWS,
): Promise<ToolOutcome> => dispatchTool(TOOL_REGISTRY, provided, d, 'extension', tool, params);

describe('flow', () => {
  it('a dry run projects through the step bindings, without stopWaiting, and registers nothing', async () => {
    const fake = fakeFlows();
    const outcome = await call(deps(fake), 'flow', {
      steps: [WAIT_STEP],
      dry_run: true,
      detach: true,
    });
    expect(outcome.ok).toBe(true);
    expect(fake.started).toEqual([]);
    expect(fake.stepOptions).toEqual([{ hidePasswordValues: false }]);
  });

  it('a foreground run starts with the minted id and its deadline, and finishes with the result', async () => {
    const fake = fakeFlows({ onProgress: true });
    const outcome = await call(deps(fake), 'flow', {
      steps: [WAIT_STEP, 'junk'],
      flow_id: 'flow_1',
      deadline_ms: 500,
    });
    expect(fake.started).toEqual([
      { flowId: 'flow_1', steps: 1, detached: false, deadlineAt: 1_500 },
    ]);
    expect(outcome).toMatchObject({ ok: true, result: { ok: true } });
    expect(fake.finished).toEqual([(outcome as { result: FlowResult }).result]);
    expect(fake.progress).toEqual([{ step: 1, steps: 1 }]);
  });

  it('without a minted id or a finite deadline, start gets neither', async () => {
    const fake = fakeFlows();
    await call(deps(fake), 'flow', { steps: [WAIT_STEP], flow_id: '', deadline_ms: Infinity });
    expect(fake.started).toEqual([
      { flowId: undefined, steps: 1, detached: false, deadlineAt: undefined },
    ]);
  });

  it("stopWaiting trips on the launch's cancel and at the deadline", async () => {
    const clock = createManualClock(1_000);
    const fake = fakeFlows();
    await call(deps(fake, clock), 'flow', { steps: [WAIT_STEP], deadline_ms: 50 });
    const stopWaiting = fake.stepOptions[0].stopWaiting!;
    expect(stopWaiting()).toBe(false);
    fake.cancel.value = true;
    expect(stopWaiting()).toBe(true);
    fake.cancel.value = false;
    await clock.advance(50);
    expect(stopWaiting()).toBe(true);
  });

  it("the launch's cancel outranks the bindings' own", async () => {
    const fake = fakeFlows({ ownCancel: () => false });
    fake.cancel.value = true;
    const outcome = await call(deps(fake), 'flow', { steps: [WAIT_STEP] });
    expect(outcome).toMatchObject({ ok: true, result: { stopped_by: 'cancelled' } });
  });

  it('a run that throws still finishes, with null, and fails as thrown', async () => {
    const fake = fakeFlows({ waitFor: () => Promise.reject(new Error('tab closed')) });
    const outcome = await call(deps(fake), 'flow', { steps: [WAIT_STEP] });
    expect(fake.finished).toEqual([null]);
    expect(toolResponse('r', outcome)).toEqual({
      kind: 'tool.response',
      id: 'r',
      ok: false,
      error: 'tab closed',
    });
  });

  it('hides password values in the result when asked', async () => {
    const fake = fakeFlows();
    const outcome = await call(deps(fake), 'flow', {
      steps: [WAIT_STEP],
      hide_password_values: true,
    });
    expect(fake.stepOptions[0].hidePasswordValues).toBe(true);
    expect(outcome).toMatchObject({ ok: true, result: { values_hidden: expect.anything() } });
  });

  it('a detached launch answers at once and finishes later', async () => {
    let release!: () => void;
    const fake = fakeFlows({
      waitFor: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, result: { matched: true } });
        }),
    });
    const outcome = await call(deps(fake), 'flow', {
      steps: [WAIT_STEP],
      detach: true,
      deadline_ms: 10,
    });
    expect(outcome).toEqual({
      ok: true,
      result: { detached: true, started_at: 100, steps: 1, expires_at: 1_800_100 },
    });
    expect(Object.keys((outcome as { result: object }).result)).toEqual([
      'detached',
      'started_at',
      'steps',
      'expires_at',
    ]);
    expect(fake.started[0]).toEqual({
      flowId: undefined,
      steps: 1,
      detached: true,
      deadlineAt: undefined,
    });
    expect(fake.finished).toEqual([]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.finished).toHaveLength(1);
    expect(fake.finished[0]).toMatchObject({ ok: true });
  });

  it('a detached flow that throws finishes with null', async () => {
    const fake = fakeFlows({ waitFor: () => Promise.reject(new Error('gone')) });
    await call(deps(fake), 'flow', { steps: [WAIT_STEP], detach: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.finished).toEqual([null]);
  });

  it('refuses a second detached flow on the tab, naming the running one', async () => {
    const fake = fakeFlows({ detachedOnTab: 'flow_9' });
    const outcome = await call(deps(fake), 'flow', { steps: [WAIT_STEP], detach: true });
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: 'action',
        message:
          'flow: a detached flow is already running on this tab (flow_9). ' +
          'Wait for it, or stop it with browser.flow_cancel, before detaching another.',
      },
    });
    expect(fake.started).toEqual([]);
  });

  it("answers the transport's refusal and runs nothing", async () => {
    const fake = fakeFlows({ refuse: 'flow: could not persist' });
    const outcome = await call(deps(fake), 'flow', { steps: [WAIT_STEP], detach: true });
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'action', message: 'flow: could not persist' },
    });
    expect(fake.stepOptions).toEqual([]);
  });
});

describe('flow_status', () => {
  it('needs a flow id', async () => {
    const fake = fakeFlows();
    expect(await call(deps(fake), 'flow_status', { flow_id: 3 })).toEqual({
      ok: false,
      failure: { kind: 'action', message: 'flow_status: flow_id required' },
    });
    expect(fake.log).toEqual([]);
  });

  it("answers the transport's status", async () => {
    const fake = fakeFlows();
    expect(await call(deps(fake), 'flow_status', { flow_id: 'f' })).toEqual({
      ok: true,
      result: { flow_id: 'f', state: 'running' },
    });
  });
});

describe('flow_cancel', () => {
  it('needs a flow id', async () => {
    const fake = fakeFlows();
    expect(await call(deps(fake), 'flow_cancel', {}, WITH_CANCEL)).toEqual({
      ok: false,
      failure: { kind: 'action', message: 'flow_cancel: flow_id required' },
    });
    expect(fake.log).toEqual([]);
  });

  it('cancels, then answers the status', async () => {
    const fake = fakeFlows();
    const outcome = await call(deps(fake), 'flow_cancel', { flow_id: 'f' }, WITH_CANCEL);
    expect(fake.log).toEqual(['cancel f', 'status f']);
    expect(outcome).toEqual({ ok: true, result: { flow_id: 'f', state: 'running' } });
  });

  it('the extension lacks flow-cancel: refused as unsupported, nothing cancelled', async () => {
    const fake = fakeFlows();
    const outcome = await call(deps(fake), 'flow_cancel', { flow_id: 'f' });
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'unsupported', tool: 'flow_cancel', missing: ['flow-cancel'] },
    });
    expect(toolResponse('r', outcome)).toEqual({
      kind: 'tool.response',
      id: 'r',
      ok: false,
      error: 'Unsupported tool: flow_cancel needs flow-cancel',
    });
    expect(fake.log).toEqual([]);
  });
});
