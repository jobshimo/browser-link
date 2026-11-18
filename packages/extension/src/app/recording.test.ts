// Flow recording by demonstration (app/recording.ts, slice 20): start and its
// refusals, the navigation steps, the step cap, stop, discard, the save round
// trip and its stale-session guard, over fakes of the CDP send, the page
// evaluate, the tab events and the tab's socket.
import { describe, expect, test, vi } from 'vitest';
import {
  createManualClock,
  TabRegistry,
  TabSession,
  type FlowStep,
  type PageDriverHandle,
} from '@browser-link/core';
import { englishText } from '../worker-messages.js';
import { MAX_RECORDING_STEPS, DISCARDED_WHILE_SAVING } from '../recording.js';
import {
  debuggerIntake,
  deliverCdpEvent,
  newTabConnection,
  type TabConnection,
} from './tab-connection.js';
import { createRecording, type TabEvents, type TabUpdate } from './recording.js';

const TAB = 7;
const START_URL = 'https://shop.example/cart?x=1';

function harness({ enabled = true, tabUrl = START_URL, connect = true } = {}) {
  const clock = createManualClock(1_000);
  const tabs = new TabRegistry<TabConnection>();
  const calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const evaluated: string[] = [];
  const failures = { cdp: new Set<string>(), evaluate: false, tabGet: false };
  const updateListeners = new Set<(update: TabUpdate) => void>();
  const tabEvents: TabEvents = {
    get: () =>
      failures.tabGet ? Promise.reject(new Error('No tab')) : Promise.resolve({ url: tabUrl }),
    onUpdated: (listener) => {
      updateListeners.add(listener);
      return () => {
        updateListeners.delete(listener);
      };
    },
  };
  const flags = { enabled };
  const recording = createRecording({
    tabs,
    tabEvents,
    clock,
    enabled: () => flags.enabled,
    cdp: (_tabId, method, params) => {
      calls.push({ method, params });
      return failures.cdp.has(method)
        ? Promise.reject(new Error(`${method} failed`))
        : Promise.resolve({});
    },
    evaluate: (_tabId, expression) => {
      evaluated.push(expression);
      return failures.evaluate ? Promise.reject(new Error('CSP')) : Promise.resolve(undefined);
    },
  });
  const driver = { uninstall: vi.fn(async () => undefined) } as unknown as PageDriverHandle;
  const conn = newTabConnection(TAB, new TabSession({ clock, driver }), new Set());
  conn.debuggerListener = debuggerIntake(conn, {
    clock,
    onRecordingCapped: (id) => void recording.finish(id),
  });
  if (connect) tabs.commit(tabs.reserve(TAB)!, conn);
  const sent: unknown[] = [];
  const socket = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => undefined,
  };
  const register = (): void => {
    conn.ws = socket as unknown as TabConnection['ws'];
    conn.serverTabId = 'srv-1';
  };
  /** The page's recorder reports a step through the CDP binding. */
  const bindingCall = (payload: Record<string, unknown>): void => {
    const r = conn.recording!;
    deliverCdpEvent(conn, 'Runtime.bindingCalled', {
      name: r.bindingName,
      payload: JSON.stringify({ nonce: r.nonce, ...payload }),
    });
  };
  const navigate = (url: string, extra: Partial<TabUpdate> = {}): void => {
    for (const l of [...updateListeners]) l({ tabId: TAB, status: 'complete', url, ...extra });
  };
  return {
    clock,
    tabs,
    conn,
    recording,
    calls,
    evaluated,
    failures,
    updateListeners,
    flags,
    sent,
    register,
    bindingCall,
    navigate,
  };
}

const methods = (h: ReturnType<typeof harness>): string[] => h.calls.map((c) => c.method);
const clicks = (n: number): FlowStep[] =>
  Array.from({ length: n }, (_, i) => ({ click: { selector: `#b${String(i)}` } }));

describe('start', () => {
  test('refuses, in order: setting off, tab not connected, a recording exists, tab gone', async () => {
    const off = harness({ enabled: false });
    expect(await off.recording.start(TAB)).toMatchObject({
      ok: false,
      error: englishText({ code: 'recording-disabled' }),
    });
    expect(off.calls).toEqual([]);

    const none = harness({ connect: false });
    expect(await none.recording.start(TAB)).toMatchObject({
      ok: false,
      error: englishText({ code: 'tab-not-connected' }),
    });

    const twice = harness();
    expect(await twice.recording.start(TAB)).toEqual({ ok: true });
    expect(await twice.recording.start(TAB)).toMatchObject({
      ok: false,
      error: englishText({ code: 'recording-in-progress' }),
    });
    // Under review counts as in progress.
    await twice.recording.stop(TAB);
    expect(await twice.recording.start(TAB)).toMatchObject({
      error: englishText({ code: 'recording-in-progress' }),
    });

    const gone = harness();
    gone.failures.tabGet = true;
    expect(await gone.recording.start(TAB)).toMatchObject({
      ok: false,
      error: englishText({ code: 'tab-gone' }),
    });
    expect(gone.calls).toEqual([]);
    expect(gone.conn.recording).toBeUndefined();
  });

  test('adds the binding, injects the recorder and records a fresh session on the tab', async () => {
    const h = harness();
    expect(await h.recording.start(TAB)).toEqual({ ok: true });
    const r = h.conn.recording!;
    expect(h.calls).toEqual([{ method: 'Runtime.addBinding', params: { name: r.bindingName } }]);
    expect(h.evaluated).toHaveLength(1);
    expect(h.evaluated[0]).toContain(r.bindingName);
    expect(h.evaluated[0]).toContain(r.nonce);
    expect(r).toMatchObject({
      status: 'recording',
      steps: [],
      lastUrl: START_URL,
      capped: false,
      ambiguousStepIndices: [],
    });
    expect(h.updateListeners.size).toBe(1);

    // Every start rotates the identity.
    const other = harness();
    await other.recording.start(TAB);
    expect(other.conn.recording!.bindingName).not.toBe(r.bindingName);
    expect(other.conn.recording!.nonce).not.toBe(r.nonce);
  });

  test('a failed addBinding answers recording-start-failed with the detail and leaves nothing', async () => {
    const h = harness();
    h.failures.cdp.add('Runtime.addBinding');
    const res = await h.recording.start(TAB);
    expect(res).toMatchObject({ ok: false, code: 'recording-start-failed' });
    expect(res.error).toContain('Runtime.addBinding failed');
    expect(h.conn.recording).toBeUndefined();
    expect(h.updateListeners.size).toBe(0);
  });

  test('a failed injection removes the binding it added and leaves nothing (BL-FLOW-096)', async () => {
    const h = harness();
    h.failures.evaluate = true;
    const res = await h.recording.start(TAB);
    expect(res).toMatchObject({ ok: false, code: 'recording-start-failed' });
    expect(res.error).toContain('CSP');
    expect(methods(h)).toEqual(['Runtime.addBinding', 'Runtime.removeBinding']);
    expect(h.calls[1].params).toEqual(h.calls[0].params);
    expect(h.conn.recording).toBeUndefined();
    expect(h.updateListeners.size).toBe(0);
  });

  test('a failing rollback does not mask the injection error', async () => {
    const h = harness();
    h.failures.evaluate = true;
    h.failures.cdp.add('Runtime.removeBinding');
    const res = await h.recording.start(TAB);
    expect(res.error).toContain('CSP');
  });
});

describe('navigation while recording', () => {
  test('a completed load of a new URL adds a wait_for step and re-injects the same session', async () => {
    const h = harness();
    await h.recording.start(TAB);
    const before = h.evaluated.length;
    h.navigate('https://shop.example/done');
    await vi.waitFor(() => expect(h.evaluated.length).toBe(before + 1));
    const r = h.conn.recording!;
    expect(r.steps).toEqual([{ wait_for: { expression: "document.readyState === 'complete'" } }]);
    expect(r.lastUrl).toBe('https://shop.example/done');
    expect(h.evaluated[before]).toBe(h.evaluated[0]);
    expect(methods(h)).toEqual(['Runtime.addBinding']);
  });

  test('ignores another tab, a load still in progress, the same URL and an empty URL', async () => {
    const h = harness();
    await h.recording.start(TAB);
    const before = h.evaluated.length;
    h.navigate('https://other.example/', { tabId: 99 });
    h.navigate('https://shop.example/x', { status: 'loading' });
    h.navigate(START_URL);
    h.navigate('', {});
    h.navigate(undefined as unknown as string);
    await Promise.resolve();
    expect(h.conn.recording!.steps).toEqual([]);
    expect(h.evaluated.length).toBe(before);
  });

  test('a navigation that reaches the step cap stops the recording instead of re-injecting', async () => {
    const h = harness();
    await h.recording.start(TAB);
    for (let i = 0; i < MAX_RECORDING_STEPS; i++)
      h.bindingCall({ kind: 'click', selector: `#b${String(i)}` });
    expect(h.conn.recording!.steps).toHaveLength(MAX_RECORDING_STEPS);
    const injected = h.evaluated.length;
    h.navigate('https://shop.example/next');
    await vi.waitFor(() => expect(h.conn.recording!.status).toBe('reviewing'));
    expect(h.conn.recording).toMatchObject({ capped: true });
    expect(h.conn.recording!.steps).toHaveLength(MAX_RECORDING_STEPS);
    // The stop script ran; the recorder was not injected again.
    expect(h.evaluated).toHaveLength(injected + 1);
    expect(h.evaluated.at(-1)).not.toBe(h.evaluated[0]);
    expect(h.updateListeners.size).toBe(0);
  });
});

describe('the step cap on a recorded interaction', () => {
  test('the step after the cap sets capped and auto-stops: binding removed, recorder torn down, listener gone', async () => {
    const h = harness();
    await h.recording.start(TAB);
    for (let i = 0; i < MAX_RECORDING_STEPS; i++)
      h.bindingCall({ kind: 'click', selector: `#b${String(i)}` });
    expect(h.conn.recording).toMatchObject({ status: 'recording', capped: false });
    h.bindingCall({ kind: 'click', selector: '#over' });
    await vi.waitFor(() => expect(h.conn.recording!.status).toBe('reviewing'));
    expect(h.conn.recording!.capped).toBe(true);
    expect(h.conn.recording!.steps).toEqual(clicks(MAX_RECORDING_STEPS));
    expect(methods(h)).toEqual(['Runtime.addBinding', 'Runtime.removeBinding']);
    expect(h.calls[1].params).toEqual({ name: h.conn.recording!.bindingName });
    expect(h.evaluated.at(-1)).toContain(h.conn.recording!.stopFn);
    expect(h.updateListeners.size).toBe(0);
  });
});

describe('stop', () => {
  test('moves to review, keeps the steps, removes the binding, listener and in-page recorder', async () => {
    const h = harness();
    await h.recording.start(TAB);
    h.bindingCall({ kind: 'click', selector: '#a' });
    h.bindingCall({ kind: 'press', key: 'Enter' });
    const res = await h.recording.stop(TAB);
    expect(res).toEqual({
      ok: true,
      steps: [{ click: { selector: '#a' } }, { press: { key: 'Enter' } }],
      capped: false,
    });
    expect(h.conn.recording!.status).toBe('reviewing');
    expect(methods(h)).toEqual(['Runtime.addBinding', 'Runtime.removeBinding']);
    expect(h.evaluated.at(-1)).toContain(h.conn.recording!.stopFn);
    expect(h.updateListeners.size).toBe(0);
    // Reviewing: no further steps are accepted.
    h.bindingCall({ kind: 'click', selector: '#late' });
    expect(h.conn.recording!.steps).toHaveLength(2);
  });

  test('answers not-recording without an active recording, and a failing removeBinding does not stop it', async () => {
    const idle = harness();
    expect(await idle.recording.stop(TAB)).toMatchObject({
      ok: false,
      error: englishText({ code: 'not-recording' }),
    });
    await idle.recording.start(TAB);
    await idle.recording.stop(TAB);
    expect(await idle.recording.stop(TAB)).toMatchObject({ code: 'not-recording' });

    const h = harness();
    await h.recording.start(TAB);
    h.failures.cdp.add('Runtime.removeBinding');
    expect(await h.recording.stop(TAB)).toMatchObject({ ok: true });
    expect(h.conn.recording!.status).toBe('reviewing');
  });

  test('an ambiguous selector is remembered by step index', async () => {
    const h = harness();
    await h.recording.start(TAB);
    h.bindingCall({ kind: 'click', selector: '#a' });
    h.bindingCall({ kind: 'click', selector: 'div', ambiguous: true });
    await h.recording.stop(TAB);
    expect(h.recording.status(TAB)).toMatchObject({
      reviewing: true,
      ambiguousStepIndices: [1],
    });
  });
});

describe('discard and force stop', () => {
  test('discard of an active recording tears the recorder down in the page, then clears', async () => {
    const h = harness();
    await h.recording.start(TAB);
    const { stopFn } = h.conn.recording!;
    expect(await h.recording.discard(TAB)).toEqual({ ok: true });
    expect(h.conn.recording).toBeUndefined();
    expect(h.evaluated.at(-1)).toContain(stopFn);
    expect(methods(h)).toEqual(['Runtime.addBinding', 'Runtime.removeBinding']);
    expect(h.updateListeners.size).toBe(0);
    expect(h.recording.status(TAB)).toEqual({
      active: false,
      reviewing: false,
      stepCount: 0,
      capped: false,
    });
  });

  test('discard of a reviewed recording clears it without touching the page again', async () => {
    const h = harness();
    await h.recording.start(TAB);
    await h.recording.stop(TAB);
    const evaluated = h.evaluated.length;
    await h.recording.discard(TAB);
    expect(h.conn.recording).toBeUndefined();
    expect(h.evaluated).toHaveLength(evaluated);
  });

  test('discard with nothing recorded answers ok and does nothing', async () => {
    const h = harness();
    expect(await h.recording.discard(TAB)).toEqual({ ok: true });
    expect(h.calls).toEqual([]);
    expect(h.evaluated).toEqual([]);
  });

  test('discard settles a save still in flight as a failure (BL-FLOW-094 family)', async () => {
    const h = harness();
    await h.recording.start(TAB);
    h.bindingCall({ kind: 'click', selector: '#a' });
    await h.recording.stop(TAB);
    h.register();
    const saving = h.recording.save(TAB, 'Flow', undefined);
    expect(h.conn.pendingFlowSave).toBeDefined();
    await h.recording.discard(TAB);
    expect(await saving).toMatchObject({
      ok: false,
      error: englishText(DISCARDED_WHILE_SAVING),
    });
    expect(h.conn.pendingFlowSave).toBeUndefined();
    expect(h.conn.recording).toBeUndefined();
  });

  test('forceStopAndDiscard is the privacy path: an active recording is gone with its steps', async () => {
    const h = harness();
    await h.recording.start(TAB);
    h.bindingCall({ kind: 'click', selector: '#a' });
    await h.recording.forceStopAndDiscard(TAB);
    expect(h.conn.recording).toBeUndefined();
    expect(h.updateListeners.size).toBe(0);
    await h.recording.forceStopAndDiscard(TAB);
    await h.recording.forceStopAndDiscard(404);
  });
});

describe('teardown helpers', () => {
  test('removeNavListener stops only that tab and is idempotent', async () => {
    const h = harness();
    await h.recording.start(TAB);
    h.recording.removeNavListener(TAB);
    h.recording.removeNavListener(TAB);
    h.recording.removeNavListener(404);
    expect(h.updateListeners.size).toBe(0);
  });

  test('teardownRecorder runs the stop script and never throws', async () => {
    const h = harness();
    await h.recording.teardownRecorder(TAB, 'stopMe');
    expect(h.evaluated[0]).toContain('stopMe');
    h.failures.evaluate = true;
    await expect(h.recording.teardownRecorder(TAB, 'stopMe')).resolves.toBeUndefined();
  });
});

describe('status', () => {
  test('shows steps and ambiguity only while reviewing', async () => {
    const h = harness();
    await h.recording.start(TAB);
    h.bindingCall({ kind: 'click', selector: '#a' });
    expect(h.recording.status(TAB)).toEqual({
      active: true,
      reviewing: false,
      stepCount: 1,
      capped: false,
      steps: undefined,
      ambiguousStepIndices: undefined,
    });
    await h.recording.stop(TAB);
    expect(h.recording.status(TAB)).toEqual({
      active: false,
      reviewing: true,
      stepCount: 1,
      capped: false,
      steps: [{ click: { selector: '#a' } }],
      ambiguousStepIndices: [],
    });
  });
});

describe('save', () => {
  async function reviewed(h: ReturnType<typeof harness>, steps = 1): Promise<void> {
    await h.recording.start(TAB);
    for (let i = 0; i < steps; i++) h.bindingCall({ kind: 'click', selector: `#b${String(i)}` });
    await h.recording.stop(TAB);
  }

  test('refuses without a reviewed recording, without a server, with no name, with no steps', async () => {
    const h = harness();
    expect(await h.recording.save(TAB, 'n', undefined)).toMatchObject({
      code: 'no-reviewed-recording',
    });
    await h.recording.start(TAB);
    // Still recording: not reviewable yet.
    expect(await h.recording.save(TAB, 'n', undefined)).toMatchObject({
      code: 'no-reviewed-recording',
    });
    h.bindingCall({ kind: 'click', selector: '#a' });
    await h.recording.stop(TAB);
    expect(await h.recording.save(TAB, 'n', undefined)).toMatchObject({
      code: 'server-not-connected',
    });
    h.register();
    expect(await h.recording.save(TAB, '   ', undefined)).toMatchObject({ code: 'name-required' });

    const empty = harness();
    await reviewed(empty, 0);
    empty.register();
    expect(await empty.recording.save(TAB, 'n', undefined)).toMatchObject({ code: 'no-steps' });
    expect(empty.sent).toEqual([]);
  });

  test('sends flow.recorded with the origin, trimmed name and steps; success clears the recording', async () => {
    const h = harness();
    await reviewed(h, 2);
    h.register();
    const saving = h.recording.save(TAB, '  Checkout ', ' buys one thing ');
    expect(h.sent).toEqual([
      {
        kind: 'flow.recorded',
        payload: {
          tab_id: 'srv-1',
          origin: 'https://shop.example',
          name: 'Checkout',
          description: 'buys one thing',
          steps: clicks(2),
        },
      },
    ]);
    h.conn.pendingFlowSave!({ ok: true });
    expect(await saving).toEqual({ ok: true });
    expect(h.conn.recording).toBeUndefined();
    expect(h.conn.pendingFlowSave).toBeUndefined();
  });

  test('folds the ambiguous-selector note into the description, or stands in for a missing one', async () => {
    const h = harness();
    await h.recording.start(TAB);
    h.bindingCall({ kind: 'click', selector: 'div', ambiguous: true });
    await h.recording.stop(TAB);
    h.register();
    void h.recording.save(TAB, 'n', 'mine');
    const note =
      'Step 1: selector may match multiple elements (resolves first-match-wins) — verify before replaying.';
    expect((h.sent[0] as { payload: { description: string } }).payload.description).toBe(
      `mine\n\n${note}`,
    );
    h.conn.pendingFlowSave!({ ok: false, error: 'x' });
    void h.recording.save(TAB, 'n', undefined);
    expect((h.sent[1] as { payload: { description: string } }).payload.description).toBe(note);
  });

  test('a server failure keeps the steps so the user can retry; an unparsable origin is sent as is', async () => {
    const h = harness({ tabUrl: 'not a url' });
    await reviewed(h, 1);
    h.register();
    const saving = h.recording.save(TAB, 'n', undefined);
    expect((h.sent[0] as { payload: { origin: string } }).payload.origin).toBe('not a url');
    h.conn.pendingFlowSave!({ ok: false, error: 'too long' });
    expect(await saving).toEqual({ ok: false, error: 'too long' });
    expect(h.conn.recording).toMatchObject({ status: 'reviewing' });
    expect(h.conn.recording!.steps).toHaveLength(1);
  });

  test('no answer within 10 s settles server-timeout and keeps the recording', async () => {
    const h = harness();
    await reviewed(h, 1);
    h.register();
    const saving = h.recording.save(TAB, 'n', undefined);
    await h.clock.advance(9_999);
    expect(h.conn.pendingFlowSave).toBeDefined();
    await h.clock.advance(1);
    expect(await saving).toMatchObject({ ok: false, code: 'server-timeout' });
    expect(h.conn.recording).toMatchObject({ status: 'reviewing' });
  });
});
