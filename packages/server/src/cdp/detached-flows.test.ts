import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_DETACHED_FLOW_MS,
  MAX_DETACHED_FLOW_RECORDS,
  cancelDetachedFlow,
  detachedFlowForTab,
  detachedFlowStatus,
  finishDetachedFlow,
  registerDetachedFlow,
  reportDetachedProgress,
  resetDetachedFlowsForTest,
  setCdpFlowEventSink,
  shouldStopDetachedFlow,
} from './detached-flows.js';
import type { FlowResult } from './flow.js';

/**
 * The cdp-direct half of detached execution. The agent-visible contract
 * here is the SAME one the extension's `flow-registry.ts` implements —
 * same status keys, same `'unknown'`, same one-per-tab rule, same
 * 30-minute ceiling — so these tests are deliberately shaped like their
 * counterparts over there. The implementations differ (no service worker
 * to survive, therefore no persistence); the contract must not.
 */

afterEach(() => {
  resetDetachedFlowsForTest();
});

describe('registration and the one-per-tab rule', () => {
  test('a registered flow is running, addressable, and carries its ceiling', () => {
    const flow = registerDetachedFlow({
      flowId: 'f1',
      tabId: 'cdp:T1',
      steps: 3,
      now: 1_000,
    });
    expect(flow.expiresAt).toBe(1_000 + MAX_DETACHED_FLOW_MS);
    expect(detachedFlowStatus('f1')).toMatchObject({
      state: 'running',
      detached: true,
      started_at: 1_000,
      steps: 3,
      steps_completed: 0,
      expires_at: 1_000 + MAX_DETACHED_FLOW_MS,
    });
  });

  test('the tab lookup NAMES the running flow so a rejection can point at it', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1 });
    expect(detachedFlowForTab('cdp:T1')?.flowId).toBe('f1');
    expect(detachedFlowForTab('cdp:T2')).toBeUndefined();
  });

  test('finishing frees the tab for the next detached flow', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1 });
    finishDetachedFlow('f1', { ok: true, steps_completed: 1, results: [] });
    expect(detachedFlowForTab('cdp:T1')).toBeUndefined();
  });
});

describe('progress, cancellation and the ceiling', () => {
  test('progress reports the step ABOUT to run, so completed is one behind', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 5 });
    reportDetachedProgress('f1', { step: 3, iteration: 12 });
    expect(detachedFlowStatus('f1')).toMatchObject({
      steps_completed: 2,
      iterations_completed: 11,
    });
  });

  test('cancel flips once and reports whether THIS call is what stopped it', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1 });
    expect(cancelDetachedFlow('f1')).toBe(true);
    expect(cancelDetachedFlow('f1')).toBe(false);
    expect(detachedFlowStatus('f1')).toMatchObject({ state: 'running', cancelling: true });
  });

  test('cancelling an unknown id is a no-op reported as unknown, never an error', () => {
    expect(cancelDetachedFlow('nope')).toBe(false);
    expect(detachedFlowStatus('nope')).toEqual({
      flow_id: 'nope',
      state: 'unknown',
      detached: false,
    });
  });

  test('the 30-minute ceiling stops the flow and is recorded as `expired`', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1, now: 0 });
    expect(shouldStopDetachedFlow('f1', MAX_DETACHED_FLOW_MS - 1)).toBe(false);
    expect(shouldStopDetachedFlow('f1', MAX_DETACHED_FLOW_MS)).toBe(true);

    // The runner only ever reports 'cancelled'; the registry is what knows
    // this one simply ran out of time.
    finishDetachedFlow(
      'f1',
      { ok: true, stopped_by: 'cancelled', steps_completed: 1, results: [{ ok: true }] },
      MAX_DETACHED_FLOW_MS,
    );
    expect(detachedFlowStatus('f1')).toMatchObject({
      state: 'expired',
      stopped_by: 'expired',
      steps_completed: 1,
    });
  });

  test('a forgotten id is told to stop rather than allowed to run on', () => {
    expect(shouldStopDetachedFlow('never-registered', 0)).toBe(true);
  });
});

describe('outcomes and the manifest', () => {
  test('a completed run keeps its manifest verbatim, addressable by id', () => {
    const manifest = [{ selector: '#row-1' }, { ok: true, settle: { settled: true } }];
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 2, now: 1_000 });
    finishDetachedFlow('f1', { ok: true, steps_completed: 2, results: manifest }, 4_000);

    expect(detachedFlowStatus('f1')).toEqual({
      flow_id: 'f1',
      state: 'completed',
      detached: true,
      started_at: 1_000,
      ended_at: 4_000,
      steps: 2,
      steps_completed: 2,
      manifest,
    });
  });

  test('a cancelled run keeps the partial manifest — the actions really happened', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 4 });
    cancelDetachedFlow('f1');
    finishDetachedFlow('f1', {
      ok: true,
      stopped_by: 'cancelled',
      steps_completed: 2,
      results: [{ ok: true }, { ok: true }],
    });
    expect(detachedFlowStatus('f1')).toMatchObject({
      state: 'cancelled',
      stopped_by: 'cancelled',
      steps_completed: 2,
      manifest: [{ ok: true }, { ok: true }],
    });
  });

  test('a failure carries its error message for the agent', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 2 });
    finishDetachedFlow('f1', {
      ok: false,
      failed_step: 1,
      step_kind: 'click',
      error: 'Element not found: #delete',
      steps_completed: 1,
      recovery_snapshot: null,
    });
    expect(detachedFlowStatus('f1')).toMatchObject({
      state: 'failed',
      steps_completed: 1,
      error: 'Element not found: #delete',
    });
  });

  test('a runner that threw is failed, with progress falling back to the last report', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 3 });
    reportDetachedProgress('f1', { step: 2 });
    finishDetachedFlow('f1', null);
    expect(detachedFlowStatus('f1')).toMatchObject({ state: 'failed', steps_completed: 1 });
  });

  test('repeat iterations are summed onto the finished status', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1 });
    finishDetachedFlow('f1', {
      ok: true,
      steps_completed: 1,
      results: [{ iterations_completed: 187, stopped_by: 'condition', iterations: [] }],
    });
    expect(detachedFlowStatus('f1')).toMatchObject({ iterations_completed: 187 });
  });

  test('only the newest runs keep their manifest — older ones age out', () => {
    for (let i = 0; i <= MAX_DETACHED_FLOW_RECORDS; i++) {
      registerDetachedFlow({ flowId: `f${i}`, tabId: `cdp:T${i}`, steps: 1, now: i });
      finishDetachedFlow(`f${i}`, { ok: true, steps_completed: 1, results: [] });
    }
    expect(detachedFlowStatus('f0').state).toBe('unknown');
    expect(detachedFlowStatus(`f${MAX_DETACHED_FLOW_RECORDS}`).state).toBe('completed');
  });
});

describe('the one-per-flow audit event', () => {
  test('exactly ONE event per flow, whatever the iteration count', () => {
    const sink = vi.fn();
    setCdpFlowEventSink(sink);
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1, now: 1_000 });
    // A 200-iteration repeat — the case that would blow BridgeEventLog's
    // 200-entry buffer if this were one event per iteration.
    const iterations = Array.from({ length: 200 }, () => [{ ok: true }]);
    finishDetachedFlow(
      'f1',
      {
        ok: true,
        steps_completed: 1,
        results: [{ iterations_completed: 200, stopped_by: 'max_iterations', iterations }],
      },
      4_000,
    );

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toEqual({
      tab_id: 'cdp:T1',
      flow_id: 'f1',
      state: 'completed',
      detached: true,
      steps: 1,
      steps_completed: 1,
      iterations_completed: 200,
      duration_ms: 3_000,
      manifest_available: true,
    });
  });

  test('the event is a SUMMARY — the manifest itself never goes into the ring buffer', () => {
    const sink = vi.fn();
    setCdpFlowEventSink(sink);
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1 });
    finishDetachedFlow('f1', {
      ok: true,
      steps_completed: 1,
      results: [{ selector: '#secret-row-42' }],
    });
    expect(JSON.stringify(sink.mock.calls[0][0])).not.toContain('secret-row-42');
  });

  test('the stop reason rides along when there was one', () => {
    const sink = vi.fn();
    setCdpFlowEventSink(sink);
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1 });
    cancelDetachedFlow('f1');
    finishDetachedFlow('f1', {
      ok: true,
      stopped_by: 'cancelled',
      steps_completed: 0,
      results: [],
    });
    expect(sink.mock.calls[0][0]).toMatchObject({ state: 'cancelled', stopped_by: 'cancelled' });
  });

  test('finishing an unknown id emits nothing at all', () => {
    const sink = vi.fn();
    setCdpFlowEventSink(sink);
    const result: FlowResult = { ok: true, steps_completed: 1, results: [] };
    finishDetachedFlow('never-registered', result);
    expect(sink).not.toHaveBeenCalled();
  });

  test('no sink wired is not an error — the flow still finishes and stays readable', () => {
    registerDetachedFlow({ flowId: 'f1', tabId: 'cdp:T1', steps: 1 });
    expect(() =>
      finishDetachedFlow('f1', { ok: true, steps_completed: 1, results: [] }),
    ).not.toThrow();
    expect(detachedFlowStatus('f1').state).toBe('completed');
  });
});
