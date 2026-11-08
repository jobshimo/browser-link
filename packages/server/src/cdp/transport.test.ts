import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import * as paths from '../map/paths.js';
import { saveConfig } from '../config.js';
import { clearGrant, saveGrant } from './grant.js';
import { CDP_DIRECT_DISABLED_ERROR } from './gate.js';
import { callCdpTool, resetConnectionsForTest, setIdleCleanupConfigForTest } from './transport.js';
import { resetDetachedFlowsForTest } from './detached-flows.js';
import {
  OBSERVER_BINDING,
  OBSERVER_GLOBAL,
  buildObserverChangesJs,
  buildObserverMarkJs,
} from './inpage/observer.js';
import { buildSettleJs } from './inpage/builders.js';
import { TOP_DOCUMENT_PROBE_JS } from './observer-host.js';

/* Fake single-target CDP-over-WS server: a real ephemeral WebSocketServer
 * (no real Chrome required) that answers whatever commands the test wires
 * up via `handlers`, defaulting to an empty ok result for anything else
 * (covers Page.enable, which every connection issues on open). */

let wss: WebSocketServer | null = null;
let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;
/** Cumulative count of client sockets the fake server has accepted since
 * the last `startFakeTarget` call — the connection-cache lifecycle tests
 * assert against this directly to prove how many WebSockets a sequence of
 * `callCdpTool` calls actually opened. */
let connectionCount = 0;

type Handler = (params: unknown) => unknown;

/** Sentinel a handler can return to make the fake target swallow the
 * command without ever answering — exercises per-command timeouts. */
const NO_REPLY = Symbol('no-reply');

/** A handler returning one of these makes the fake target answer the
 * command with a CDP error instead of a result. */
class CdpError {
  constructor(readonly message: string) {}
}

/** Default Target.getTargetInfo answer — a real page target, so
 * getConnection's connect-time re-validation passes. Tests that need a
 * different target type (e.g. to assert the rejection path) wire their own
 * `Target.getTargetInfo` handler, which overrides this. */
const DEFAULT_PAGE_TARGET_INFO = {
  targetInfo: { type: 'page', url: 'https://example.com/', title: '' },
};

function startFakeTarget(
  handlers: Record<string, Handler>,
): Promise<{ port: number; targetId: string }> {
  const targetId = 'FAKE-TARGET-1';
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { id: number; method: string; params: unknown };
        const handler = handlers[msg.method];
        const result = handler
          ? handler(msg.params)
          : msg.method === 'Target.getTargetInfo'
            ? DEFAULT_PAGE_TARGET_INFO
            : {};
        if (result === NO_REPLY) return;
        if (result instanceof CdpError) {
          ws.send(JSON.stringify({ id: msg.id, error: { message: result.message } }));
          return;
        }
        ws.send(JSON.stringify({ id: msg.id, result }));
      });
      // Stash the ws so tests can push events (e.g. Page.loadEventFired)
      // whenever they need to, keyed by targetId (single target here).
      (wss as unknown as { _testWs?: WebSocket })._testWs = ws;
    });
    wss.on('listening', () => {
      const address = wss?.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, targetId });
    });
  });
}

function pushEvent(method: string, params: unknown): void {
  const ws = (wss as unknown as { _testWs?: WebSocket })._testWs;
  ws?.send(JSON.stringify({ method, params }));
}

/** Simulate the tab/Chrome dropping the debugger connection (tab closed,
 * browser restarted, etc.) by closing the server-side end of the last
 * accepted socket. */
function closeTargetSocket(): void {
  const ws = (wss as unknown as { _testWs?: WebSocket })._testWs;
  ws?.close();
}

/** Bind a WebSocketServer on an OS-assigned port, then immediately close
 * it, to get a port number that is (with overwhelming probability) not
 * listening — used to make `CdpClient.connect()` fail fast with
 * ECONNREFUSED instead of waiting out its 5s connect timeout. */
function unusedPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    probe.on('listening', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-cdp-transport-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  connectionCount = 0;
});

afterEach(async () => {
  resetConnectionsForTest();
  // Detached-flow state is module-level and per-process by design, so one
  // test's background run would otherwise still hold the next test's tab
  // under the one-detached-flow-per-tab rule.
  resetDetachedFlowsForTest();
  getDataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
  if (wss) {
    await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = null;
  }
});

function grantAccess(port: number): void {
  saveConfig({ cdpDirectEnabled: true, cdpDirectPort: port });
  saveGrant(60);
}

describe('callCdpTool — permission gate', () => {
  test('rejects with the exact disabled-error text when cdp-direct is off', async () => {
    await expect(callCdpTool('cdp:whatever', 'ping', {})).rejects.toThrow(
      CDP_DIRECT_DISABLED_ERROR,
    );
  });

  test('rejects on a malformed cdp tab_id even when the gate passes', async () => {
    const { port } = await startFakeTarget({});
    grantAccess(port);
    await expect(callCdpTool('not-a-cdp-id', 'ping', {})).rejects.toThrow(/malformed cdp tab id/i);
  });

  test('refuses to connect to a non-page target (re-validated at connect, not just discovery)', async () => {
    const { port, targetId } = await startFakeTarget({
      'Target.getTargetInfo': () => ({
        targetInfo: { type: 'other', url: 'chrome://inspect/', title: 'Inspect' },
      }),
    });
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'ping', {})).rejects.toThrow(
      /is not a drivable page/i,
    );
  });

  test('refuses a devtools target even when its type says page', async () => {
    const { port, targetId } = await startFakeTarget({
      'Target.getTargetInfo': () => ({
        targetInfo: {
          type: 'page',
          url: 'devtools://devtools/bundled/inspector.html',
          title: 'DevTools',
        },
      }),
    });
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'ping', {})).rejects.toThrow(
      /is not a drivable page/i,
    );
  });
});

describe('callCdpTool — tool dispatch', () => {
  test('ping resolves with title/url from Target.getTargetInfo', async () => {
    const { port, targetId } = await startFakeTarget({
      'Target.getTargetInfo': () => ({
        targetInfo: { type: 'page', title: 'Example', url: 'https://example.com/' },
      }),
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'ping', {});
    expect(result).toEqual({ title: 'Example', url: 'https://example.com/' });
  });

  test('evaluate resolves with the Runtime.evaluate result value', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => ({
        result: { value: `echo:${(params as { expression: string }).expression}` },
      }),
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'evaluate', { expression: '1+1' });
    expect(result).toBe('echo:1+1');
  });

  test('snapshot forwards since into the evaluated snapshot expression', async () => {
    const expressions: string[] = [];
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        expressions.push((params as { expression: string }).expression);
        return { result: { value: { interactive: [] } } };
      },
    });
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'snapshot', { since: 's3' });
    await callCdpTool(`cdp:${targetId}`, 'snapshot', { since: 42 });
    expect(expressions[0]).toContain('"since":"s3"');
    expect(expressions[1]).toContain('"since":null');
  });
  test('evaluate threads the dispatcher budget into the Runtime.evaluate per-command timeout', async () => {
    // The fake target swallows Runtime.evaluate, so only the per-command
    // timeout can settle the call — a reject naming the CALLER's budget
    // (not 15000ms) proves the 4th argument replaced client.ts's default.
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => NO_REPLY,
    });
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'evaluate', { expression: 'longLoop()' }, 150),
    ).rejects.toThrow('cdp-direct: command "Runtime.evaluate" timed out after 150ms');
  });

  test('evaluate rejects with the exception message on a thrown expression', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: { text: 'Uncaught', exception: { description: 'boom' } },
      }),
    });
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'evaluate', { expression: 'throw 1' }),
    ).rejects.toThrow('boom');
  });

  test('navigate waits for Page.loadEventFired before resolving', async () => {
    const { port, targetId } = await startFakeTarget({
      'Page.navigate': () => {
        setTimeout(() => pushEvent('Page.loadEventFired', {}), 10);
        return {};
      },
      'Target.getTargetInfo': () => ({
        targetInfo: { type: 'page', title: 'Loaded', url: 'https://example.com/next' },
      }),
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'navigate', {
      url: 'https://example.com/next',
    });
    expect(result).toEqual({ title: 'Loaded', url: 'https://example.com/next' });
  });

  test('navigate with wait_for_load:false skips the load wait', async () => {
    const { port, targetId } = await startFakeTarget({
      'Target.getTargetInfo': () => ({
        targetInfo: { type: 'page', title: 'Fast', url: 'https://example.com/fast' },
      }),
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'navigate', {
      url: 'https://example.com/fast',
      wait_for_load: false,
    });
    expect(result).toEqual({ title: 'Fast', url: 'https://example.com/fast' });
  });

  test('an out-of-v1-scope tool (drag) rejects naming the extension as fallback', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'drag', {})).rejects.toThrow(
      /not supported over cdp-direct/i,
    );
  });

  test('a flow containing a drag step fails AT that step with the same unsupported-drag error', async () => {
    // Runtime.evaluate serves the failure path's recovery snapshot here —
    // the drag step itself never reaches the page: the flow's performDrag
    // binding rejects it locally as out of cdp-direct's v1 scope.
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({ result: { value: { interactive: [] } } }),
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'flow', {
      steps: [{ drag: { from_selector: '#card', to_selector: '#slot' } }],
    });
    expect(result).toMatchObject({
      ok: false,
      failed_step: 0,
      step_kind: 'drag',
      steps_completed: 0,
      recovery_snapshot: { interactive: [] },
    });
    const error = (result as { error: string }).error;
    expect(error).toMatch(/browser\.drag is not supported over cdp-direct/);
    expect(error).toMatch(/Chrome extension/);
  });

  test('click rejects with "Element not found" when resolution fails', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({ result: { value: { ok: false, reason: 'not-found' } } }),
    });
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'click', { selector: '#missing' })).rejects.toThrow(
      /Element not found: #missing/,
    );
  });

  test('press rejects on an unrecognized key', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'press', { key: 'this-is-not-a-real-key-name' }),
    ).rejects.toThrow(/unrecognized key/i);
  });

  /* `expect`: the page is faked at the Runtime.evaluate boundary. Every
   * expression (baseline, post-action probe, recovery snapshot) returns `probe()`. */
  function expectPage(probe: () => Record<string, unknown>) {
    return { 'Runtime.evaluate': () => ({ result: { value: probe() } }) };
  }

  test('a condition that already held before the action rejects without waiting', async () => {
    const { port, targetId } = await startFakeTarget(
      expectPage(() => ({ url: 'u', selector_appears: true })),
    );
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'press', {
        key: 'a',
        settle_ms: 0,
        expect: { selector_appears: '[role=dialog]', timeout_ms: 5000 },
      }),
    ).rejects.toThrow(/selector_appears "\[role=dialog\]" was already present before the action/);
  });

  test('press with an unmet expect rejects with "expectation not met" and the window', async () => {
    const { port, targetId } = await startFakeTarget(
      expectPage(() => ({ url: 'https://example.com/a' })),
    );
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'press', {
        key: 'a',
        settle_ms: 0,
        expect: { url_changed: true, timeout_ms: 150 },
      }),
    ).rejects.toThrow(/^expectation not met: url_changed after \d+ms/);
  });

  test('click with a met expect succeeds and reports expect.met + elapsed_ms', async () => {
    let probes = 0;
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params: unknown) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes("reason: 'invalid-selector'")) {
          return { result: { value: { ok: true, x: 5, y: 6, tag: 'a' } } };
        }
        probes += 1;
        return { result: { value: { url: 'u', selector_appears: probes > 1 } } };
      },
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', {
      selector: '#next',
      settle_ms: 0,
      expect: { selector_appears: '#done', timeout_ms: 2000 },
    });
    expect(result).toMatchObject({
      clicked: '#next',
      expect: { met: true, elapsed_ms: expect.any(Number) },
    });
  });

  test('type without expect is unchanged (no expect key in the result)', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'type', { text: 'hi', settle_ms: 0 });
    expect(result).toEqual({ typed: 2 });
  });

  test('a flow step with an unmet expect fails fast at that step', async () => {
    const { port, targetId } = await startFakeTarget(
      expectPage(() => ({ url: 'https://example.com/a' })),
    );
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'flow', {
      steps: [
        { press: { key: 'a', settle_ms: 0, expect: { url_changed: true, timeout_ms: 150 } } },
        { press: { key: 'b', settle_ms: 0 } },
      ],
    });
    expect(result).toMatchObject({ ok: false, failed_step: 0, step_kind: 'press' });
    expect((result as { error: string }).error).toMatch(/expectation not met: url_changed/);
  });
});

/*
 * Connection-cache lifecycle: `getConnection` in transport.ts pools one
 * WebSocket per CDP targetId. These tests exercise that pool directly
 * through the public `callCdpTool` entry point, counting how many sockets
 * the fake server actually accepts — the pool is an internal cache with no
 * other externally observable surface.
 */
describe('callCdpTool — connection cache lifecycle', () => {
  test('two sequential calls to the same target reuse one cached connection', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    expect(connectionCount).toBe(1);
  });

  test('two overlapping calls to a not-yet-cached target open exactly one connection', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    // Both calls miss the cache at the same tick — without single-flighting
    // the dial, each would open its own socket and the loser would never
    // make it into the cache to be swept (the leak this test guards).
    const [a, b] = await Promise.all([
      callCdpTool(`cdp:${targetId}`, 'ping', {}),
      callCdpTool(`cdp:${targetId}`, 'ping', {}),
    ]);
    expect(connectionCount).toBe(1);
    expect(a).toEqual(b);
  });

  test('a failed connection attempt does not poison the cache — the next call retries and succeeds', async () => {
    const deadPort = await unusedPort();
    grantAccess(deadPort);
    await expect(callCdpTool('cdp:FAKE-TARGET-1', 'ping', {})).rejects.toThrow();

    // Same targetId, now pointed at a real endpoint — must dial fresh
    // rather than replay the earlier rejection.
    const { port, targetId } = await startFakeTarget({});
    saveConfig({ cdpDirectEnabled: true, cdpDirectPort: port });
    const result = await callCdpTool(`cdp:${targetId}`, 'ping', {});
    expect(result).toEqual({ title: '', url: 'https://example.com/' });
    expect(connectionCount).toBe(1);
  });

  test('re-dials after the fake server closes the target socket', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    expect(connectionCount).toBe(1);

    closeTargetSocket();
    // Let the client-side socket observe the close before the next call —
    // real loopback close propagation, not simulated.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    expect(connectionCount).toBe(2);
  });

  test('an idle connection is closed and evicted after the idle window', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    setIdleCleanupConfigForTest(30, 20);

    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    expect(connectionCount).toBe(1);

    // Wait out the (shortened) idle window plus a couple of sweep ticks.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The idle sweep must have closed and evicted the pooled connection —
    // the next call dials fresh instead of reusing a stale cache entry.
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    expect(connectionCount).toBe(2);
  });
});

/*
 * The cdp-direct kill switch. There is no extension here and therefore no
 * popup Stop button, so `browser-link cdp revoke` is the ONLY lever the
 * user has — and before flow cancellation existed, revoking mid-flow did
 * nothing to the flow already running. These tests pin the new behaviour:
 * the flow's per-step gate re-check stops it within one step, cleanly,
 * keeping the steps that already ran.
 */
describe('callCdpTool — flow stops when the cdp-direct grant is revoked mid-flow', () => {
  test('revoking between steps ends the flow with stopped_by: cancelled and partial results', async () => {
    let dispatched = 0;
    const { port, targetId } = await startFakeTarget({
      'Input.dispatchKeyEvent': () => {
        dispatched += 1;
        // The user runs `browser-link cdp revoke` while step 1 is in
        // flight. Nothing interrupts the command already sent; the flow
        // must decline to dispatch the NEXT one.
        if (dispatched === 1) clearGrant();
        return {};
      },
    });
    grantAccess(port);

    const result = await callCdpTool(`cdp:${targetId}`, 'flow', {
      // settle_ms: 0 keeps each step to a single Input.* dispatch, so the
      // count below is unambiguous.
      steps: [
        { press: { key: 'a', settle_ms: 0 } },
        { press: { key: 'b', settle_ms: 0 } },
        { press: { key: 'c', settle_ms: 0 } },
      ],
    });

    expect(result).toMatchObject({ ok: true, stopped_by: 'cancelled', steps_completed: 1 });
    // A key press is several CDP events (keyDown/char/keyUp) — the point is
    // that steps 2 and 3 contributed none of them.
    const afterFirstStep = dispatched;
    expect(afterFirstStep).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched).toBe(afterFirstStep);
  });

  test('a live grant leaves the flow completely unaffected', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);

    const result = await callCdpTool(`cdp:${targetId}`, 'flow', {
      steps: [{ press: { key: 'a', settle_ms: 0 } }, { press: { key: 'b', settle_ms: 0 } }],
    });

    expect(result).toMatchObject({ ok: true, steps_completed: 2 });
    expect(Object.hasOwn(result as object, 'stopped_by')).toBe(false);
  });
});

/*
 * The wait_for poll loop's cancellation check, exercised FOR REAL.
 *
 * Every other cancellation test in the repo drives `runFlow` with a mocked
 * `performWaitFor`, which proves the step executor's handling but never
 * runs the actual `while` loop in `performWaitFor` — the one place the
 * advertised "worst case one step" bound is either true or a lie for a
 * step that can legitimately park for 30 seconds. These tests use the real
 * loop, a real (fake-target) CDP socket and a real clock.
 */
describe('callCdpTool — the REAL wait_for poll loop honours cancellation', () => {
  test('a 20s wait cut short mid-poll returns within one poll interval, as cancelled', async () => {
    let checks = 0;
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => {
        checks += 1;
        // Flip the flag on the third poll — well inside the 20s budget,
        // so a loop that ignored it would park for the full timeout.
        if (checks === 3) clearGrant();
        return { result: { value: false } };
      },
    });
    grantAccess(port);

    const POLL_MS = 100;
    const startedAt = Date.now();
    const result = (await callCdpTool(`cdp:${targetId}`, 'flow', {
      steps: [
        {
          wait_for: { expression: 'window.__never', timeout_ms: 20_000, poll_interval_ms: POLL_MS },
        },
      ],
    })) as { ok: boolean; stopped_by?: string; steps_completed: number };
    const elapsed = Date.now() - startedAt;

    // A cancellation, not a fabricated timeout: the condition never got
    // its budget, so calling it a timeout would invent a diagnosis.
    expect(result).toMatchObject({ ok: true, stopped_by: 'cancelled', steps_completed: 0 });
    // Generous, but two orders of magnitude below the 20s it would have
    // taken had the loop only checked at its own deadline. The bound being
    // tested is "one poll interval", not the exact scheduler latency.
    expect(elapsed).toBeLessThan(3_000);
    // And it really did stop polling — a loop that kept going would have
    // logged hundreds more checks over 20 seconds.
    const atStop = checks;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    expect(checks).toBe(atStop);
  });

  test('an uncancelled wait still runs to its own timeout and reports one', async () => {
    // The control case: without a cancellation the same loop behaves
    // exactly as before, so the test above is measuring the flag and not
    // some unrelated early exit.
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({ result: { value: false } }),
    });
    grantAccess(port);

    const result = (await callCdpTool(`cdp:${targetId}`, 'flow', {
      steps: [{ wait_for: { expression: 'window.__never', timeout_ms: 250 } }],
    })) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/condition not met within timeout/);
  });

  test('browser.flow_cancel stops a DETACHED flow parked in a long wait_for', async () => {
    let checks = 0;
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => {
        checks += 1;
        return { result: { value: false } };
      },
    });
    grantAccess(port);
    const tabId = `cdp:${targetId}`;

    const ack = (await callCdpTool(tabId, 'flow', {
      flow_id: 'flow_wait',
      detach: true,
      steps: [
        { wait_for: { expression: 'window.__never', timeout_ms: 20_000, poll_interval_ms: 50 } },
      ],
    })) as { detached: boolean };
    expect(ack.detached).toBe(true);

    // Let the loop get going, then reach for the kill switch.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(checks).toBeGreaterThan(0);
    const startedAt = Date.now();
    await callCdpTool(tabId, 'flow_cancel', { flow_id: 'flow_wait' });

    // Poll the status rather than sleeping a fixed amount: the assertion
    // is about the BOUND, and the loop settles on its own schedule.
    let state = '';
    while (Date.now() - startedAt < 3_000) {
      const status = (await callCdpTool(tabId, 'flow_status', { flow_id: 'flow_wait' })) as {
        state: string;
      };
      state = status.state;
      if (state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state).toBe('cancelled');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});

/*
 * Detached execution over cdp-direct. Same contract as the extension path
 * (see `flow-registry.test.ts` and `browser-dispatch.test.ts`), exercised
 * end to end here because the runner is in-process: a real fake CDP
 * target, a real `runFlow`, a real registry.
 */
describe('callCdpTool — detached execution', () => {
  /** Wait until a detached flow leaves `running`, or give up. */
  async function settleFlow(tabId: string, flowId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    let status = (await callCdpTool(tabId, 'flow_status', { flow_id: flowId })) as Record<
      string,
      unknown
    >;
    while (status.state === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await callCdpTool(tabId, 'flow_status', { flow_id: flowId })) as Record<
        string,
        unknown
      >;
    }
    return status;
  }

  test('detach returns an ack immediately and the manifest arrives via flow_status', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    const tabId = `cdp:${targetId}`;

    const ack = (await callCdpTool(tabId, 'flow', {
      flow_id: 'flow_1',
      detach: true,
      steps: [{ press: { key: 'a', settle_ms: 0 } }, { press: { key: 'b', settle_ms: 0 } }],
    })) as { detached: boolean; steps: number; expires_at: number; started_at: number };

    expect(ack.detached).toBe(true);
    expect(ack.steps).toBe(2);
    expect(ack.expires_at).toBe(ack.started_at + 30 * 60_000);

    const status = await settleFlow(tabId, 'flow_1');
    expect(status).toMatchObject({ state: 'completed', steps_completed: 2 });
    // The manifest IS the answer to "what did that actually do?".
    expect(status.manifest).toEqual([{ ok: true }, { ok: true }]);
  });

  test('a second detached flow on the same tab is rejected, naming the running one', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({ result: { value: false } }),
    });
    grantAccess(port);
    const tabId = `cdp:${targetId}`;

    await callCdpTool(tabId, 'flow', {
      flow_id: 'flow_first',
      detach: true,
      steps: [{ wait_for: { expression: 'false', timeout_ms: 5_000, poll_interval_ms: 50 } }],
    });

    await expect(
      callCdpTool(tabId, 'flow', {
        flow_id: 'flow_second',
        detach: true,
        steps: [{ press: { key: 'a', settle_ms: 0 } }],
      }),
    ).rejects.toThrow(/already running on this tab \(flow_first\)/);

    await callCdpTool(tabId, 'flow_cancel', { flow_id: 'flow_first' });
    await settleFlow(tabId, 'flow_first');
    // …and once it is done, the tab is free again.
    await expect(
      callCdpTool(tabId, 'flow', {
        flow_id: 'flow_third',
        detach: true,
        steps: [{ press: { key: 'a', settle_ms: 0 } }],
      }),
    ).resolves.toMatchObject({ detached: true });
  });

  test('a cancelled detached flow keeps the partial manifest', async () => {
    let dispatched = 0;
    const { port, targetId } = await startFakeTarget({
      'Input.dispatchKeyEvent': () => {
        dispatched += 1;
        return {};
      },
      'Runtime.evaluate': () => ({ result: { value: false } }),
    });
    grantAccess(port);
    const tabId = `cdp:${targetId}`;

    await callCdpTool(tabId, 'flow', {
      flow_id: 'flow_partial',
      detach: true,
      steps: [
        { press: { key: 'a', settle_ms: 0 } },
        { wait_for: { expression: 'false', timeout_ms: 5_000, poll_interval_ms: 20 } },
        { press: { key: 'z', settle_ms: 0 } },
      ],
    });
    // Let the first press land, then stop it inside the wait.
    const deadline = Date.now() + 2_000;
    while (dispatched === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const afterFirstStep = dispatched;
    await callCdpTool(tabId, 'flow_cancel', { flow_id: 'flow_partial' });

    const status = await settleFlow(tabId, 'flow_partial');
    expect(status).toMatchObject({
      state: 'cancelled',
      stopped_by: 'cancelled',
      steps_completed: 1,
      manifest: [{ ok: true }],
    });
    // The third step never ran — that is what "stops within one step" buys.
    expect(dispatched).toBe(afterFirstStep);
  });

  test('flow_cancel reads the state back rather than claiming an instant stop', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({ result: { value: false } }),
    });
    grantAccess(port);
    const tabId = `cdp:${targetId}`;

    await callCdpTool(tabId, 'flow', {
      flow_id: 'flow_ack',
      detach: true,
      steps: [{ wait_for: { expression: 'false', timeout_ms: 5_000, poll_interval_ms: 500 } }],
    });
    const answer = (await callCdpTool(tabId, 'flow_cancel', { flow_id: 'flow_ack' })) as {
      state: string;
      cancelling?: boolean;
    };
    // Cooperative cancellation has an up-to-one-step gap, and the payload
    // says so instead of pretending otherwise.
    expect(answer.state).toBe('running');
    expect(answer.cancelling).toBe(true);
    await settleFlow(tabId, 'flow_ack');
  });

  test('flow_status on an id nobody knows is `unknown`, not an error', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'flow_status', { flow_id: 'flow_nope' }),
    ).resolves.toMatchObject({ state: 'unknown' });
  });

  test('both lifecycle tools require a flow_id', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'flow_status', {})).rejects.toThrow(
      'flow_status: flow_id required',
    );
    await expect(callCdpTool(`cdp:${targetId}`, 'flow_cancel', {})).rejects.toThrow(
      'flow_cancel: flow_id required',
    );
  });

  test('revoking the grant still stops a detached flow — the only lever here', async () => {
    // There is no popup on this transport, so `browser-link cdp revoke`
    // has to reach a flow nobody is waiting on, not just a foreground one.
    let dispatched = 0;
    const { port, targetId } = await startFakeTarget({
      'Input.dispatchKeyEvent': () => {
        dispatched += 1;
        if (dispatched === 1) clearGrant();
        return {};
      },
    });
    grantAccess(port);
    const tabId = `cdp:${targetId}`;

    await callCdpTool(tabId, 'flow', {
      flow_id: 'flow_revoked',
      detach: true,
      steps: [
        { press: { key: 'a', settle_ms: 0 } },
        { press: { key: 'b', settle_ms: 0 } },
        { press: { key: 'c', settle_ms: 0 } },
      ],
    });

    // The status read needs the grant back — revoking is what stopped the
    // flow, and the gate guards every call on this transport.
    const deadline = Date.now() + 3_000;
    let state = 'running';
    while (state === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      saveGrant(60);
      const status = (await callCdpTool(tabId, 'flow_status', { flow_id: 'flow_revoked' })) as {
        state: string;
      };
      state = status.state;
      clearGrant();
    }
    saveGrant(60);
    expect(state).toBe('cancelled');
    const status = (await callCdpTool(tabId, 'flow_status', { flow_id: 'flow_revoked' })) as {
      steps_completed: number;
      stopped_by?: string;
    };
    expect(status.steps_completed).toBe(1);
    // And it says WHICH lever stopped it: a revoked grant is not the same
    // fact as `browser.flow_cancel`, and an agent that cannot tell them
    // apart will retry into a gate that is still shut.
    expect(status.stopped_by).toBe('grant-revoked');
  });

  test('a dry run is never detached, whatever the flags say', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    const result = (await callCdpTool(`cdp:${targetId}`, 'flow', {
      flow_id: 'flow_dry',
      detach: true,
      dry_run: true,
      steps: [{ press: { key: 'a' } }],
    })) as { dry_run?: boolean; detached?: boolean };

    expect(result.dry_run).toBe(true);
    expect(result.detached).toBeUndefined();
    expect(
      (
        (await callCdpTool(`cdp:${targetId}`, 'flow_status', { flow_id: 'flow_dry' })) as {
          state: string;
        }
      ).state,
    ).toBe('unknown');
  });
});

/*
 * The page observer on cdp-direct (spec v4 §5.1, §5.4): installed once per
 * connection, an action mark taken before dispatch, and the changes since
 * the mark folded into the settle result — the same shape the extension
 * returns. The page is faked at the CDP boundary: `Runtime.evaluate`
 * answers by expression, so each test names exactly which evaluation it
 * expects and records every command it saw.
 */
describe('callCdpTool — page observer', () => {
  interface Seen {
    method: string;
    params: Record<string, unknown>;
  }

  const MARK = { ok: true, mark: 3, doc_id: 'doc-1', url: 'https://example.com/' };
  const CHANGES = {
    ok: true,
    doc_id: 'doc-1',
    since: 3,
    records: 4,
    targets: 2,
    kinds: { childList: 3, attributes: 1, characterData: 0 },
    roots: { document: true, shadow: false, frame: false },
    descriptors: [{ tag: 'div', id: 'status', path: 'body>div#status' }],
    overflow: 0,
    url_changed: 'https://example.com/#done',
  };
  /** What the settle wait alone reports: quiet, and blind to the sync change. */
  const QUIET = { settled: true, duration_ms: 150, mutation_count: 0, focus_moved: true };
  const DEFAULT_SETTLE_JS = buildSettleJs({ settle_ms: 150, settle_timeout_ms: 2000 });

  /** A fake page whose observer answers `mark` / `changes` as given. */
  function observerPage(
    seen: Seen[],
    answers: { mark?: unknown; changes?: unknown; extra?: Record<string, Handler> } = {},
  ): Record<string, Handler> {
    const record =
      (method: string, reply: (params: Record<string, unknown>) => unknown): Handler =>
      (params) => {
        const p = (params ?? {}) as Record<string, unknown>;
        seen.push({ method, params: p });
        return reply(p);
      };
    return {
      'Runtime.enable': record('Runtime.enable', () => ({})),
      'Runtime.addBinding': record('Runtime.addBinding', () => ({})),
      'Page.addScriptToEvaluateOnNewDocument': record(
        'Page.addScriptToEvaluateOnNewDocument',
        () => ({ identifier: 'script-1' }),
      ),
      'Page.removeScriptToEvaluateOnNewDocument': record(
        'Page.removeScriptToEvaluateOnNewDocument',
        () => ({}),
      ),
      'Runtime.evaluate': record('Runtime.evaluate', (p) => {
        const expression = p.expression as string;
        if (expression.includes("reason: 'invalid-selector'")) {
          return { result: { value: { ok: true, x: 5, y: 6, tag: 'button' } } };
        }
        if (expression === buildObserverMarkJs())
          return { result: { value: answers.mark ?? MARK } };
        if (expression === buildObserverChangesJs(3, 'doc-1')) {
          return { result: { value: answers.changes ?? CHANGES } };
        }
        if (expression === DEFAULT_SETTLE_JS) return { result: { value: QUIET } };
        return { result: { value: true } };
      }),
      ...answers.extra,
    };
  }

  function evaluations(seen: Seen[]): string[] {
    return seen
      .filter((s) => s.method === 'Runtime.evaluate')
      .map((s) => s.params.expression as string);
  }

  test('installs the binding and the new-document script once per connection', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(observerPage(seen));
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    await callCdpTool(`cdp:${targetId}`, 'ping', {});

    expect(seen.filter((s) => s.method === 'Runtime.enable')).toHaveLength(1);
    const bindings = seen.filter((s) => s.method === 'Runtime.addBinding');
    expect(bindings).toEqual([
      { method: 'Runtime.addBinding', params: { name: OBSERVER_BINDING } },
    ]);
    const scripts = seen.filter((s) => s.method === 'Page.addScriptToEvaluateOnNewDocument');
    expect(scripts).toHaveLength(1);
    expect(scripts[0].params.runImmediately).toBe(true);
    expect(scripts[0].params.source).toContain(OBSERVER_GLOBAL);
  });

  test('a failed install leaves the connection usable and settle reports observer-unavailable', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(
      observerPage(seen, {
        extra: { 'Runtime.addBinding': () => new CdpError('binding refused') },
      }),
    );
    grantAccess(port);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(callCdpTool(`cdp:${targetId}`, 'ping', {})).resolves.toEqual({
        title: '',
        url: 'https://example.com/',
      });
      const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go' });
      expect(result).toEqual({
        clicked: '#go',
        tag: 'button',
        settle: { ...QUIET, changes: null, observer: 'observer-unavailable' },
      });
      // No mark is attempted against an observer that was never installed.
      expect(evaluations(seen)).not.toContain(buildObserverMarkJs());
      expect(connectionCount).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('click reports the changes since a mark taken before the dispatch', async () => {
    const seen: Seen[] = [];
    const order: string[] = [];
    const page = observerPage(seen);
    const { port, targetId } = await startFakeTarget({
      ...page,
      'Input.dispatchMouseEvent': (params) => {
        order.push(`input:${(params as { type: string }).type}`);
        return {};
      },
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression === buildObserverMarkJs()) order.push('mark');
        return page['Runtime.evaluate'](params);
      },
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go' });

    expect(result).toEqual({
      clicked: '#go',
      tag: 'button',
      settle: {
        settled: true,
        duration_ms: 150,
        // Recomputed from the observer's records; url/focus baselined at the mark.
        mutation_count: 4,
        url_changed: 'https://example.com/#done',
        changes: {
          records: 4,
          targets: 2,
          kinds: { childList: 3, attributes: 1, characterData: 0 },
          roots: { document: true, shadow: false, frame: false },
          descriptors: [{ tag: 'div', id: 'status', path: 'body>div#status' }],
          overflow: 0,
        },
      },
    });
    expect(order).toEqual([
      'mark',
      'input:mouseMoved',
      'input:mousePressed',
      'input:mouseReleased',
    ]);
    // Observer plumbing never hands the page a user gesture.
    const mark = seen.find((s) => s.params.expression === buildObserverMarkJs());
    expect(mark).toBeDefined();
    expect(mark?.params.userGesture).toBeUndefined();
  });

  test('a mark the observer refuses yields changes: null and keeps the settle fields', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(
      observerPage(seen, { mark: { ok: false, reason: 'observer-unavailable' } }),
    );
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go' });
    expect(result).toEqual({
      clicked: '#go',
      tag: 'button',
      settle: { ...QUIET, changes: null, observer: 'observer-unavailable' },
    });
    expect(evaluations(seen).some((e) => e.includes('g.changes('))).toBe(false);
  });

  test('a changes read for another document reports doc-changed', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(
      observerPage(seen, { changes: { ok: false, reason: 'doc-changed' } }),
    );
    grantAccess(port);
    const result = (await callCdpTool(`cdp:${targetId}`, 'press', { key: 'Enter' })) as {
      settle: Record<string, unknown>;
    };
    expect(result.settle).toEqual({ ...QUIET, changes: null, observer: 'doc-changed' });
  });

  test('type and press carry the same changes object as click', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(observerPage(seen));
    grantAccess(port);
    const typed = (await callCdpTool(`cdp:${targetId}`, 'type', { text: 'hi' })) as {
      settle: Record<string, unknown>;
    };
    const pressed = (await callCdpTool(`cdp:${targetId}`, 'press', { key: 'a' })) as {
      settle: Record<string, unknown>;
    };
    for (const settle of [typed.settle, pressed.settle]) {
      expect(settle).toMatchObject({ mutation_count: 4, changes: { records: 4, targets: 2 } });
    }
  });

  test('settle_ms: 0 takes no mark and returns no settle (unchanged)', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(observerPage(seen));
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', {
      selector: '#go',
      settle_ms: 0,
    });
    expect(result).toEqual({ clicked: '#go', tag: 'button' });
    expect(evaluations(seen)).not.toContain(buildObserverMarkJs());
  });

  test('a doc_start from the binding is checked against the top document', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(observerPage(seen));
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    const docStart = JSON.stringify({
      type: 'doc_start',
      doc_id: 'doc-2',
      url: 'https://example.com/next',
      version: 1,
      coverage: 'full',
    });
    pushEvent('Runtime.bindingCalled', { name: 'someoneElsesBinding', payload: docStart });
    pushEvent('Runtime.bindingCalled', { name: OBSERVER_BINDING, payload: 'not json' });
    pushEvent('Runtime.bindingCalled', { name: OBSERVER_BINDING, payload: docStart });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Exactly one probe: the foreign binding and the malformed payload are
    // dropped before any evaluation.
    expect(evaluations(seen).filter((e) => e === TOP_DOCUMENT_PROBE_JS)).toHaveLength(1);
  });

  test('the idle sweep removes the observer script and tears the observer down', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(observerPage(seen));
    grantAccess(port);
    setIdleCleanupConfigForTest(30, 20);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen.filter((s) => s.method === 'Page.removeScriptToEvaluateOnNewDocument')).toEqual([
      {
        method: 'Page.removeScriptToEvaluateOnNewDocument',
        params: { identifier: 'script-1' },
      },
    ]);
    expect(evaluations(seen).some((e) => e.includes('g.teardown()'))).toBe(true);
  });
});

describe('callCdpTool — wait_for', () => {
  function recordingPage(expressions: string[]): Record<string, Handler> {
    return {
      'Runtime.evaluate': (params) => {
        expressions.push((params as { expression: string }).expression);
        return { result: { value: true } };
      },
    };
  }

  test('selector mode resolves through the deep query (open shadow roots, same-origin iframes)', async () => {
    const expressions: string[] = [];
    const { port, targetId } = await startFakeTarget(recordingPage(expressions));
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'wait_for', {
      selector: '#late',
      condition: 'attached',
    });
    expect(result).toMatchObject({ matched: true, checks: 1 });
    const probe = expressions.find((e) => e.includes('"#late"'));
    expect(probe).toContain('function deepQueryFirst');
    expect(probe).toContain('deepQueryFirst(opts.selector)');
    expect(probe).not.toContain('document.querySelector("#late")');
  });

  test('expression mode still evaluates Boolean(<expression>) (unchanged)', async () => {
    const expressions: string[] = [];
    const { port, targetId } = await startFakeTarget(recordingPage(expressions));
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'wait_for', {
      expression: 'window.ready',
    });
    expect(result).toMatchObject({ matched: true, checks: 1 });
    expect(expressions).toContain('Boolean(window.ready)');
  });

  test('network_url mode is still refused on cdp-direct (unchanged)', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'wait_for', { network_url: '/api' }),
    ).rejects.toThrow(/network_url mode is not supported over cdp-direct/);
  });
});

describe('callCdpTool — ref as a target (spec v4 §6.3)', () => {
  /** Answers every `Runtime.evaluate` whose source carries the ref as data
   * (`"ref":"e7"`) with `answer`, and anything else (settle, observer
   * probes) with `true`. Records the ref-carrying expressions. */
  function refPage(answer: unknown, seen: string[]): Record<string, Handler> {
    return {
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"ref":"e7"')) {
          seen.push(expression);
          return { result: { value: answer } };
        }
        return { result: { value: true } };
      },
    };
  }
  const STALE = { ok: false, reason: 'ref-stale', ref: 'e7', doc_id: 'doc-1' };
  const UNAVAILABLE = { ok: false, reason: 'observer-unavailable' };

  test('click by ref reaches the built JS and reports ref and reresolved', async () => {
    const seen: string[] = [];
    const { port, targetId } = await startFakeTarget(
      refPage({ ok: true, x: 5, y: 6, tag: 'button', reresolved: true }, seen),
    );
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { ref: 'e7', settle_ms: 0 });
    expect(result).toEqual({ clicked: 'e7', tag: 'button', ref: 'e7', reresolved: true });
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('function resolveTarget');
  });

  test('click by a stale ref rejects with the ref-stale error naming the doc_id', async () => {
    const { port, targetId } = await startFakeTarget(refPage(STALE, []));
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'click', { ref: 'e7' })).rejects.toThrow(
      'ref-stale: e7 not found in document doc-1',
    );
  });

  test('type by ref without the observer rejects with observer-unavailable', async () => {
    const { port, targetId } = await startFakeTarget(refPage(UNAVAILABLE, []));
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'type', { ref: 'e7', text: 'hi' })).rejects.toThrow(
      'observer-unavailable: ref e7 cannot be resolved without the page observer',
    );
  });

  test('type by ref types and reports the ref (no selector key)', async () => {
    const { port, targetId } = await startFakeTarget(refPage({ ok: true }, []));
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'type', {
      ref: 'e7',
      text: 'hi',
      settle_ms: 0,
    });
    expect(result).toEqual({ typed: 2, ref: 'e7' });
  });

  test('press by ref focuses through the ref and reports it', async () => {
    const seen: string[] = [];
    const { port, targetId } = await startFakeTarget(refPage({ ok: true }, seen));
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'press', {
      key: 'Enter',
      ref: 'e7',
      settle_ms: 0,
    });
    expect(result).toEqual({ key: 'Enter', modifiers: [], ref: 'e7' });
    expect(seen.length).toBe(1);
  });

  test('press by a stale ref rejects with ref-stale', async () => {
    const { port, targetId } = await startFakeTarget(refPage(STALE, []));
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'press', { key: 'Enter', ref: 'e7' }),
    ).rejects.toThrow('ref-stale: e7 not found in document doc-1');
  });

  test('find by ref returns the match; a stale ref rejects', async () => {
    const match = { matched: true, selector: '#b', ref: 'e7', tag: 'button', text: 'Beta' };
    const ok = await startFakeTarget(refPage(match, []));
    grantAccess(ok.port);
    expect(await callCdpTool(`cdp:${ok.targetId}`, 'find', { ref: 'e7' })).toEqual(match);
    resetConnectionsForTest();
    wss?.close();
    const stale = await startFakeTarget(
      refPage({ matched: false, reason: 'ref-stale', ref: 'e7', doc_id: 'doc-1' }, []),
    );
    grantAccess(stale.port);
    await expect(callCdpTool(`cdp:${stale.targetId}`, 'find', { ref: 'e7' })).rejects.toThrow(
      'ref-stale: e7 not found in document doc-1',
    );
  });

  test('wait_for by ref polls the ref probe; without the observer it rejects', async () => {
    const seen: string[] = [];
    const ok = await startFakeTarget(refPage(true, seen));
    grantAccess(ok.port);
    const result = await callCdpTool(`cdp:${ok.targetId}`, 'wait_for', {
      ref: 'e7',
      condition: 'detached',
    });
    expect(result).toMatchObject({ matched: true, checks: 1 });
    expect(seen[0]).toContain('"condition":"detached"');
    resetConnectionsForTest();
    wss?.close();
    const none = await startFakeTarget(refPage(UNAVAILABLE, []));
    grantAccess(none.port);
    await expect(
      callCdpTool(`cdp:${none.targetId}`, 'wait_for', { ref: 'e7', timeout_ms: 1000 }),
    ).rejects.toThrow('observer-unavailable: ref e7 cannot be resolved without the page observer');
  });

  test('click by selector is unchanged (no ref or reresolved key)', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"selector":"#go"')) {
          return { result: { value: { ok: true, x: 1, y: 2, tag: 'a' } } };
        }
        return { result: { value: true } };
      },
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 });
    expect(result).toEqual({ clicked: '#go', tag: 'a' });
  });
});

describe('callCdpTool — find by semantic key (spec v4 §6.3, S3)', () => {
  test('find by key reaches the built JS with the key as data and returns the result', async () => {
    const seen: string[] = [];
    const match = {
      matched: true,
      selector: '#b',
      ref: 'e3',
      tag: 'button',
      text: 'Beta',
      semantic_key: { role: 'button', name: 'Beta', path: [{ tag: 'body', index: 1 }] },
    };
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"key":{"role":"button","name":"Beta"')) {
          seen.push(expression);
          return { result: { value: match } };
        }
        return { result: { value: true } };
      },
    });
    grantAccess(port);
    const key = { role: 'button', name: 'Beta', path: [{ tag: 'body', index: 1 }] };
    expect(await callCdpTool(`cdp:${targetId}`, 'find', { key })).toEqual(match);
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('"path":[{"tag":"body","index":1}]');
    expect(seen[0]).toContain('function semanticKeyOf');
  });
});
