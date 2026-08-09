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
