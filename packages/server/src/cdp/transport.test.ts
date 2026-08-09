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
    };
    expect(status.steps_completed).toBe(1);
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
