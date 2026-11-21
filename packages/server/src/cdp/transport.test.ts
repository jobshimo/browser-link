import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import * as paths from '../map/paths.js';
import { saveConfig } from '../config.js';
import { clearGrant, saveGrant } from './grant.js';
import { CDP_DIRECT_DISABLED_ERROR, checkCdpDirectGate } from './gate.js';
import {
  callCdpTool,
  PageEnableTimeoutError,
  pageEnableTimeoutMessage,
  resetConnectionsForTest,
  setCdpBridgeEventSink,
  setIdleCleanupConfigForTest,
  setPageEnableTimeoutForTest,
  sweepIdleConnectionsForTest,
  cachedConnectionCountForTest,
  withCdpFootprint,
} from './transport.js';
import {
  cancelDetachedFlow,
  detachedFlowStatus,
  resetDetachedFlowsForTest,
} from './detached-flows.js';
import {
  OBSERVER_BINDING,
  OBSERVER_GLOBAL,
  buildObserverChangesJs,
  buildObserverMarkJs,
} from '../generated/core/inpage/observer.js';
import {
  PASSWORD_VALUES_HIDDEN_NOTE,
  UNOBSERVED_FRAMES_HINT,
  CLICK_MOVE_TRIES,
  HIT_CHECK_DIALOG_NOTE,
  HIT_CHECK_TIMEOUT_MS,
  buildClickHitCheckJs,
  buildClickMoveCheckJs,
  buildFocusedFieldJs,
  buildProgrammaticClickJs,
  buildSettleJs,
} from '../generated/core/inpage/builders.js';
import {
  PROGRAMMATIC_CLICK_NOTE,
  noBoxClickMessage,
  notFocusedMessage,
} from '../generated/core/flow/flow-engine.js';
import { TOP_DOCUMENT_PROBE_JS } from '../generated/core/support/observer-host.js';
import { OBSERVER_EVAL_TIMEOUT_MS } from '../generated/core/session/page-driver.js';
import { closeActivityDb } from '../activity/db.js';
import { SENSITIVE_PAYLOAD_MARKER, UNIDENTIFIED_FIELD_MARKER } from '../activity/extract.js';
import { query, record } from '../activity/queries.js';
import { handleBrowserTool, type BrowserToolDeps } from '../tools/browser-dispatch.js';

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

/** A handler returning one of these makes the fake target answer the
 * command with `result` only after `ms`: a renderer slow to answer one
 * command while events and other answers keep flowing. */
class Delayed {
  constructor(
    readonly ms: number,
    readonly result: unknown,
  ) {}
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
        if (result instanceof Delayed) {
          setTimeout(() => {
            ws.send(JSON.stringify({ id: msg.id, result: result.result }));
          }, result.ms);
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
    expect(Object.keys(result as object)).toEqual(['title', 'url']);
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

  test('snapshot and find forward offset (D6) and answer the truncated report unchanged', async () => {
    const expressions: string[] = [];
    const cutSnapshot = {
      interactive: [],
      truncated: { interactive: 3, next_offset: { interactive: 123 }, hint: 'h' },
    };
    const cutFind = {
      matched: false,
      reason: 'multiple-matches',
      candidates: [],
      truncated: { candidates: 2, next_offset: { candidates: 10 }, hint: 'h' },
    };
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        expressions.push(expression);
        return {
          result: { value: expression.includes('candidateOffset') ? cutFind : cutSnapshot },
        };
      },
    });
    grantAccess(port);
    expect(
      await callCdpTool(`cdp:${targetId}`, 'snapshot', {
        offset: { interactive: 120, headings: 30, text: 4000 },
      }),
    ).toEqual(cutSnapshot);
    expect(expressions[0]).toContain('"offset":{"interactive":120,"headings":30,"text":4000}');
    await callCdpTool(`cdp:${targetId}`, 'snapshot', {});
    expect(expressions[1]).toContain('"offset":{"interactive":0,"headings":0,"text":0}');
    expect(
      await callCdpTool(`cdp:${targetId}`, 'find', { text: 'Save', offset: { candidates: 5 } }),
    ).toEqual(cutFind);
    expect(expressions[2]).toContain('"candidateOffset":5');
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

  test('navigate resolves when the load event arrives before Page.navigate answers', async () => {
    const { port, targetId } = await startFakeTarget({
      'Page.navigate': () => {
        pushEvent('Page.loadEventFired', {});
        return {};
      },
      'Target.getTargetInfo': () => ({
        targetInfo: { type: 'page', title: 'Fast', url: 'https://example.com/fast' },
      }),
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'navigate', {
      url: 'https://example.com/fast',
    });
    expect(result).toEqual({ title: 'Fast', url: 'https://example.com/fast' });
  }, 5_000);

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

  test('hide-password-values (D12): snapshot, find and a flow ask the page to hide; off asks nothing', async () => {
    const expressions: string[] = [];
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        expressions.push(expression);
        return {
          result: {
            value: expression.includes('candidateOffset')
              ? { matched: false, reason: 'not-found' }
              : { interactive: [] },
          },
        };
      },
    });
    grantAccess(port);
    const HIDE = '"hideValues":true';
    await callCdpTool(`cdp:${targetId}`, 'snapshot', { hide_password_values: true });
    await callCdpTool(`cdp:${targetId}`, 'find', { text: 'Pw', hide_password_values: true });
    expect(expressions[0]).toContain(HIDE);
    expect(expressions[0]).toContain('values_hidden');
    expect(expressions[1]).toContain(HIDE);
    const flow = await callCdpTool(`cdp:${targetId}`, 'flow', {
      steps: [{ find: { text: 'Pw' } }],
      hide_password_values: true,
    });
    // The find step and the failure's recovery snapshot both hid values.
    expect(expressions.slice(2).every((e) => e.includes(HIDE))).toBe(true);
    expect(expressions.length).toBe(4);
    expect(flow).toMatchObject({ ok: false, values_hidden: PASSWORD_VALUES_HIDDEN_NOTE });
    const before = expressions.length;
    const plain = await callCdpTool(`cdp:${targetId}`, 'flow', {
      steps: [{ find: { text: 'Pw' } }],
    });
    await callCdpTool(`cdp:${targetId}`, 'snapshot', {});
    expect(
      expressions.slice(before).some((e) => e.includes(HIDE) || e.includes('values_hidden')),
    ).toBe(false);
    expect('values_hidden' in (plain as object)).toBe(false);
  });

  const DRAG_PROBE = {
    result: {
      value: {
        from: { x: 10, y: 20, in_viewport: true },
        to: { x: 110, y: 20, in_viewport: true },
        draggable: false,
      },
    },
  };

  test('drag runs on a cdp: tab: a pointer drag sends press, moves and release', async () => {
    const mouse: string[] = [];
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => DRAG_PROBE,
      'Input.dispatchMouseEvent': (params) => {
        mouse.push((params as { type: string }).type);
        return {};
      },
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'drag', {
      from_selector: '#card',
      to_selector: '#slot',
      duration_ms: 0,
    });
    expect(result).toMatchObject({
      drag_mode: 'pointer',
      from: { x: 10, y: 20 },
      to: { x: 110, y: 20 },
    });
    expect(mouse).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseReleased']);
  });

  test('a flow containing a drag step runs it through the same pointer drag', async () => {
    const mouse: string[] = [];
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => DRAG_PROBE,
      'Input.dispatchMouseEvent': (params) => {
        mouse.push((params as { type: string }).type);
        return {};
      },
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'flow', {
      steps: [{ drag: { from_selector: '#card', to_selector: '#slot', duration_ms: 0 } }],
    });
    expect(result).toMatchObject({
      ok: true,
      steps_completed: 1,
      results: [{ ok: true, drag_mode: 'pointer' }],
    });
    expect(mouse).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseReleased']);
  });

  test('a flow drag step that cannot resolve its endpoints fails AT that step with the drag error', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({ result: { value: { err: 'from_selector #card not found' } } }),
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
    });
    expect((result as { error: string }).error).toBe('drag: from_selector #card not found');
  });

  test('a non-string argument reaches a cdp: tab and is read as String(x), as on an extension tab (P2)', async () => {
    const expressions: string[] = [];
    const navigated: string[] = [];
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        expressions.push((params as { expression: string }).expression);
        return { result: { value: { ok: false, reason: 'not-found' } } };
      },
      'Page.navigate': (params) => {
        navigated.push((params as { url: string }).url);
        return {};
      },
    });
    grantAccess(port);
    const tab = `cdp:${targetId}`;
    await callCdpTool(tab, 'evaluate', { expression: 5 });
    expect(expressions.at(-1)).toBe('5');
    await expect(callCdpTool(tab, 'click', { selector: 42 })).rejects.toThrow(
      'Element not found: 42',
    );
    await expect(callCdpTool(tab, 'type', { selector: 42, text: 7 })).rejects.toThrow(
      'Element not found: 42',
    );
    await callCdpTool(tab, 'navigate', { url: 9, wait_for_load: false });
    expect(navigated).toEqual(['9']);
    const before = expressions.length;
    await callCdpTool(tab, 'find', { text: 3 });
    expect(expressions.slice(before).some((e) => e.includes('3'))).toBe(true);
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

  test('click and type say part of the page was not walked when the depth guard fired', async () => {
    const note = 'Part of the page was not walked.';
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({
        result: { value: { ok: false, reason: 'not-found', not_walked: note } },
      }),
    });
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'click', { selector: '#deep' })).rejects.toThrow(
      `Element not found: #deep (${note})`,
    );
    await expect(
      callCdpTool(`cdp:${targetId}`, 'type', { selector: '#deep', text: 'x' }),
    ).rejects.toThrow(`Element not found: #deep (${note})`);
  });

  test('click rejects with the retargeted error when the hit lands on an ancestor', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({
        result: { value: { ok: false, reason: 'retargeted', hit_element: 'div.scroller' } },
      }),
    });
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'click', { selector: '#clipped-btn' }),
    ).rejects.toThrow(
      'Click would land on div.scroller, not on #clipped-btn: scroll or expand its container, ' +
        'or target the element that receives clicks; force: true clicks there anyway',
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
        if (expression === buildClickMoveCheckJs()) {
          return { result: { value: { armed: true, moved: true } } };
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
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({ result: { value: { ok: true, sensitive_field: false } } }),
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'type', {
      selector: '#q',
      text: 'hi',
      settle_ms: 0,
    });
    expect(result).toMatchObject({ typed: 2 });
    expect(result).not.toHaveProperty('expect');
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
 * Owner decision D1: the cdp connection sweep stays internal, but it may not
 * cut a running flow, and a flow's steps count as activity. Only `Date` is
 * faked, so the sweep is stepped through minutes while the fake target's
 * sockets and the flow's poll loop run on real (millisecond) timers. Each
 * check reads `connectionCount` through a ping AFTER the sweep it judges: a
 * ping refreshes the clock, so it cannot hide what the sweep already did.
 */
describe('callCdpTool — a running flow holds its connection (owner decision D1)', () => {
  const MIN = 60_000;
  const T0 = 1_700_000_000_000;
  /** What the fake page answers to `Runtime.evaluate`: the flow's wait_for
   * waits while it is 'false' and is stuck inside its step while 'hang'. */
  let page: 'false' | 'true' | 'hang';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    page = 'false';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connect(): Promise<string> {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () =>
        page === 'hang' ? NO_REPLY : { result: { value: page === 'true' } },
    });
    grantAccess(port);
    const tabId = `cdp:${targetId}`;
    await callCdpTool(tabId, 'ping', {});
    return tabId;
  }

  const waitStep = { wait_for: { expression: 'ready', timeout_ms: 30_000, poll_interval_ms: 10 } };

  async function untilEnded(flowId: string): Promise<string> {
    const deadline = performance.now() + 5_000;
    let state = detachedFlowStatus(flowId).state;
    while (state === 'running' && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = detachedFlowStatus(flowId).state;
    }
    return state;
  }

  test('the sweep keeps the connection of a running detached flow past the idle window', async () => {
    const tabId = await connect();
    await callCdpTool(tabId, 'flow', { flow_id: 'f1', detach: true, steps: [waitStep] });
    vi.setSystemTime(T0 + 20 * MIN);
    sweepIdleConnectionsForTest(Date.now());
    await callCdpTool(tabId, 'ping', {});
    expect(connectionCount).toBe(1);
    expect(detachedFlowStatus('f1').state).toBe('running');
  });

  test('after a detached flow ends the idle window counts from its last step', async () => {
    const tabId = await connect();
    await callCdpTool(tabId, 'flow', { flow_id: 'f1', detach: true, steps: [waitStep] });
    vi.setSystemTime(T0 + 20 * MIN);
    page = 'true';
    expect(await untilEnded('f1')).not.toBe('running');
    vi.setSystemTime(T0 + 25 * MIN);
    sweepIdleConnectionsForTest(Date.now());
    await callCdpTool(tabId, 'ping', {});
    expect(connectionCount).toBe(1);
  });

  test('a cancelled detached flow restarts the window from when it stopped', async () => {
    const tabId = await connect();
    // A loop of short real pauses: unlike a wait_for, it has no per-step
    // timeout for the fake clock's jump to trip.
    await callCdpTool(tabId, 'flow', {
      flow_id: 'f1',
      detach: true,
      steps: [{ repeat: { max_iterations: 500, steps: [{ sleep: { ms: 10 } }] } }],
    });
    vi.setSystemTime(T0 + 20 * MIN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(detachedFlowStatus('f1').state).toBe('running');
    // In-process cancel, not `flow_cancel`: that tool call would refresh
    // the connection's clock by itself.
    cancelDetachedFlow('f1');
    expect(await untilEnded('f1')).toBe('cancelled');
    vi.setSystemTime(T0 + 25 * MIN);
    sweepIdleConnectionsForTest(Date.now());
    await callCdpTool(tabId, 'ping', {});
    expect(connectionCount).toBe(1);
  });

  test.each([
    ['keeps', 35 * MIN, 1],
    ['closes', 35 * MIN + 1, 2],
  ])(
    'a detached flow stuck inside a step holds the connection no longer than its 30-minute ceiling: the sweep %s it at the ceiling plus the idle window',
    async (_, at, dials) => {
      const tabId = await connect();
      page = 'hang';
      await callCdpTool(tabId, 'flow', { flow_id: 'f1', detach: true, steps: [waitStep] });
      // Let the flow send the command it will never get an answer to.
      await new Promise((resolve) => setTimeout(resolve, 30));
      vi.setSystemTime(T0 + at);
      sweepIdleConnectionsForTest(Date.now());
      expect(detachedFlowStatus('f1').state).toBe('running');
      await callCdpTool(tabId, 'ping', {});
      expect(connectionCount).toBe(dials);
    },
  );

  test('a foreground flow holds the connection while it runs and restarts the window from its end', async () => {
    const tabId = await connect();
    const running = callCdpTool(tabId, 'flow', {
      flow_id: 'f1',
      deadline_ms: 30 * MIN,
      steps: [waitStep, { press: { key: 'a', settle_ms: 0 } }],
    });
    // Let the flow reach its wait before the clock moves.
    await new Promise((resolve) => setTimeout(resolve, 30));
    vi.setSystemTime(T0 + 6 * MIN);
    sweepIdleConnectionsForTest(Date.now());
    page = 'true';
    const result = (await running) as { ok: boolean };
    expect(result.ok).toBe(true);
    vi.setSystemTime(T0 + 10 * MIN);
    sweepIdleConnectionsForTest(Date.now());
    await callCdpTool(tabId, 'ping', {});
    expect(connectionCount).toBe(1);
  });

  test('with no flow the sweep closes a connection idle for more than five minutes, as before', async () => {
    const tabId = await connect();
    vi.setSystemTime(T0 + 5 * MIN);
    sweepIdleConnectionsForTest(Date.now());
    await callCdpTool(tabId, 'ping', {});
    expect(connectionCount).toBe(1);
    vi.setSystemTime(T0 + 10 * MIN + 1);
    sweepIdleConnectionsForTest(Date.now());
    await callCdpTool(tabId, 'ping', {});
    expect(connectionCount).toBe(2);
  });
});

/*
 * Gate A (parity P5): a connection whose capture buffers hold an entry is
 * swept after 30 minutes without a tool call on its tab (the extension's
 * default idle TTL) instead of 5; one with empty buffers keeps the 5-minute
 * sweep; a pending JavaScript dialog keeps the connection until it is
 * answered; a running flow still holds it. Only `Date` is faked, as in the
 * D1 tests above, and each check reads `connectionCount` through a ping AFTER
 * the sweep it judges.
 */
describe('callCdpTool — the idle sweep keeps captured state (gate A)', () => {
  const MIN = 60_000;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const arrive = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  async function connect(): Promise<string> {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': () => ({ result: { value: false } }),
    });
    grantAccess(port);
    const tabId = `cdp:${targetId}`;
    await callCdpTool(tabId, 'ping', {});
    return tabId;
  }

  function logOne(text: string): void {
    pushEvent('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: text }],
      timestamp: Date.now(),
    });
  }

  /** Sweep at `minutes` (plus `ms`) after the dial, then count sockets
   * through a ping. The grant is renewed first (it lasts an hour), so the
   * ping after a long idle is not refused by the gate. */
  async function sweepAt(minutes: number, tabId: string, ms = 0): Promise<number> {
    vi.setSystemTime(T0 + minutes * MIN + ms);
    sweepIdleConnectionsForTest(Date.now());
    saveGrant(60);
    await callCdpTool(tabId, 'ping', {});
    return connectionCount;
  }

  test('buffers holding an entry survive a 5-minute idle and are swept after 30', async () => {
    const tabId = await connect();
    logOne('kept');
    await arrive();
    expect(await sweepAt(10, tabId)).toBe(1);
    // The ping at minute 10 is the last call: 30 minutes from it.
    expect(await sweepAt(40, tabId)).toBe(1);
    expect(await sweepAt(70, tabId, 1)).toBe(2);
  });

  test('empty buffers keep the 5-minute sweep', async () => {
    const tabId = await connect();
    expect(await sweepAt(5, tabId)).toBe(1);
    expect(await sweepAt(10, tabId, 1)).toBe(2);
  });

  test('a network entry alone counts as held state', async () => {
    const tabId = await connect();
    pushEvent('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/a', method: 'GET' },
    });
    await arrive();
    expect(await sweepAt(10, tabId)).toBe(1);
  });

  test('a pending dialog keeps the connection past 30 minutes until it is answered', async () => {
    const tabId = await connect();
    pushEvent('Page.javascriptDialogOpening', { type: 'alert', message: 'm', url: '' });
    await arrive();
    expect(await sweepAt(120, tabId)).toBe(1);
    expect(await sweepAt(240, tabId)).toBe(1);
    pushEvent('Page.javascriptDialogClosed', { result: true, userInput: '' });
    await arrive();
    // Answered, with empty buffers: the 5-minute sweep applies again.
    expect(await sweepAt(245, tabId, 1)).toBe(2);
  });

  test('a pending dialog does not keep a connection whose tab is gone', async () => {
    await connect();
    pushEvent('Page.javascriptDialogOpening', { type: 'alert', message: 'm', url: '' });
    await arrive();
    closeTargetSocket();
    await arrive();
    expect(cachedConnectionCountForTest()).toBe(1);
    vi.setSystemTime(T0 + 6 * MIN);
    sweepIdleConnectionsForTest(Date.now());
    expect(cachedConnectionCountForTest()).toBe(0);
  });

  test('a tool call on the tab restarts the 30-minute clock', async () => {
    const tabId = await connect();
    logOne('kept');
    await arrive();
    vi.setSystemTime(T0 + 25 * MIN);
    await callCdpTool(tabId, 'ping', {});
    // 50 minutes after the dial, 25 after the call.
    expect(await sweepAt(50, tabId)).toBe(1);
  });

  test('console and network events alone do not restart the clock', async () => {
    const tabId = await connect();
    logOne('first');
    await arrive();
    vi.setSystemTime(T0 + 29 * MIN);
    logOne('late');
    pushEvent('Network.requestWillBeSent', {
      requestId: 'r2',
      request: { url: 'https://example.com/late', method: 'GET' },
    });
    await arrive();
    expect(await sweepAt(30, tabId, 1)).toBe(2);
  });

  test('a running flow still holds a connection whose buffers hold entries', async () => {
    const tabId = await connect();
    logOne('kept');
    await arrive();
    await callCdpTool(tabId, 'flow', {
      flow_id: 'gate-a',
      detach: true,
      steps: [{ wait_for: { expression: 'ready', timeout_ms: 30_000, poll_interval_ms: 10 } }],
    });
    // The flow's hold is bounded at 30 minutes (the detached ceiling); past
    // it the hold counts as activity at that bound, so at minute 55 the
    // 30-minute window runs from minute 30, not from the dial.
    for (const minutes of [20, 55]) {
      vi.setSystemTime(T0 + minutes * MIN);
      sweepIdleConnectionsForTest(Date.now());
    }
    expect(detachedFlowStatus('gate-a').state).toBe('running');
    await callCdpTool(tabId, 'ping', {});
    expect(connectionCount).toBe(1);
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
        // The press was seen on the target.
        // The move was seen on the target.
        if (expression === buildClickMoveCheckJs()) {
          return { result: { value: { armed: true, moved: true } } };
        }
        if (expression === buildClickHitCheckJs()) {
          return { result: { value: { armed: true, landed: true } } };
        }
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

  /** A page whose settle wait answers `settle` instead of QUIET. */
  function settlePage(seen: Seen[], settle: unknown, changes?: unknown): Record<string, Handler> {
    const page = observerPage(seen, changes === undefined ? {} : { changes });
    return {
      ...page,
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression === DEFAULT_SETTLE_JS) return { result: { value: settle } };
        return page['Runtime.evaluate'](params);
      },
    };
  }

  test('records the settle wait saw inside same-origin frames are added to the observer count (D5)', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(
      settlePage(seen, { ...QUIET, mutation_count: 3, frame_mutation_count: 2 }),
    );
    grantAccess(port);
    const result = (await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go' })) as {
      settle: Record<string, unknown>;
    };
    expect(result.settle).toEqual({
      settled: true,
      duration_ms: 150,
      // 4 observer records (top document and its shadow roots) + 2 in frames.
      mutation_count: 6,
      url_changed: 'https://example.com/#done',
      changes: {
        records: 4,
        targets: 2,
        kinds: { childList: 3, attributes: 1, characterData: 0 },
        roots: { document: true, shadow: false, frame: false },
        descriptors: [{ tag: 'div', id: 'status', path: 'body>div#status' }],
        overflow: 0,
      },
    });
  });

  test('without the observer the settle count already holds frames and the internal field is dropped (D5)', async () => {
    const seen: Seen[] = [];
    const { port, targetId } = await startFakeTarget(
      settlePage(
        seen,
        { ...QUIET, mutation_count: 3, frame_mutation_count: 2 },
        { ok: false, reason: 'doc-changed' },
      ),
    );
    grantAccess(port);
    const result = (await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go' })) as {
      settle: Record<string, unknown>;
    };
    expect(result.settle).toEqual({
      ...QUIET,
      mutation_count: 3,
      changes: null,
      observer: 'doc-changed',
    });
  });

  test('the unobserved marker of the settle wait reaches the click result (D5)', async () => {
    const seen: Seen[] = [];
    const unobserved = { cross_origin_frames: 1, hint: UNOBSERVED_FRAMES_HINT };
    const { port, targetId } = await startFakeTarget(
      settlePage(seen, { settled: true, duration_ms: 150, mutation_count: 0, unobserved }),
    );
    grantAccess(port);
    const result = (await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go' })) as {
      settle: Record<string, unknown>;
    };
    expect(result.settle).toEqual({
      settled: true,
      duration_ms: 150,
      mutation_count: 4,
      unobserved,
      url_changed: 'https://example.com/#done',
      changes: {
        records: 4,
        targets: 2,
        kinds: { childList: 3, attributes: 1, characterData: 0 },
        roots: { document: true, shadow: false, frame: false },
        descriptors: [{ tag: 'div', id: 'status', path: 'body>div#status' }],
        overflow: 0,
      },
    });
  });

  test('a force click on a target with no box calls its own click() after the mark, with no mouse events, and settles like a pointer click (D4)', async () => {
    const seen: Seen[] = [];
    const order: string[] = [];
    let noBox = false;
    const page = observerPage(seen);
    const programmatic = buildProgrammaticClickJs({ selector: '#go' });
    const { port, targetId } = await startFakeTarget({
      ...page,
      'Input.dispatchMouseEvent': (params) => {
        order.push(`input:${(params as { type: string }).type}`);
        return {};
      },
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression === programmatic) {
          order.push('programmatic');
          return { result: { value: { ok: true } } };
        }
        if (noBox && expression.includes("reason: 'invalid-selector'")) {
          return { result: { value: { ok: true, no_box: true, tag: 'button' } } };
        }
        if (expression === buildObserverMarkJs()) order.push('mark');
        return page['Runtime.evaluate'](params);
      },
    });
    grantAccess(port);
    const pointer = (await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go' })) as {
      settle: unknown;
    };
    order.length = 0;
    noBox = true;
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', force: true });
    expect(result).toEqual({
      clicked: '#go',
      tag: 'button',
      programmatic_click: PROGRAMMATIC_CLICK_NOTE,
      settle: pointer.settle,
    });
    expect(order).toEqual(['mark', 'programmatic']);
  });

  test('a target with no box without force fails with the no-box message and nothing is clicked (D4)', async () => {
    const order: string[] = [];
    const { port, targetId } = await startFakeTarget({
      'Input.dispatchMouseEvent': (params) => {
        order.push(`input:${(params as { type: string }).type}`);
        return {};
      },
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression === buildProgrammaticClickJs({ selector: '#hidden' })) {
          order.push('programmatic');
        }
        return { result: { value: { ok: false, reason: 'no-box' } } };
      },
    });
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'click', { selector: '#hidden' })).rejects.toThrow(
      noBoxClickMessage('#hidden'),
    );
    expect(noBoxClickMessage('#hidden')).toBe(
      'Element #hidden has no visible box (not rendered, visibility-hidden, or an option of a select), ' +
        'so there is no point to click: make it visible first (open its menu, dialog or section), ' +
        "or pass force: true to call the element's own click() with no pointer",
    );
    expect(order).toEqual([]);
  });

  test.each([
    ['disabled', /is disabled, so its own click\(\) does nothing and nothing was clicked/],
    ['option', /is an <option> \(or <optgroup>\): clicking an option does nothing/],
  ])(
    'a force click whose programmatic click cannot do anything (%s) fails with a clear message and no mouse events',
    async (why, message) => {
      const order: string[] = [];
      const programmatic = buildProgrammaticClickJs({ selector: '#hidden' });
      const { port, targetId } = await startFakeTarget({
        'Input.dispatchMouseEvent': (params) => {
          order.push(`input:${(params as { type: string }).type}`);
          return {};
        },
        'Runtime.evaluate': (params) => {
          const expression = (params as { expression: string }).expression;
          if (expression === programmatic) {
            order.push('programmatic');
            return { result: { value: { ok: false, reason: 'not-clickable', why } } };
          }
          if (expression.includes("reason: 'invalid-selector'")) {
            return { result: { value: { ok: true, no_box: true, tag: 'button' } } };
          }
          return { result: { value: true } };
        },
      });
      grantAccess(port);
      await expect(
        callCdpTool(`cdp:${targetId}`, 'click', { selector: '#hidden', force: true }),
      ).rejects.toThrow(message);
      expect(order).toEqual(['programmatic']);
    },
  );

  test('expect is checked around a programmatic click exactly as around a pointer click (D4)', async () => {
    let clicked = false;
    const mouse: string[] = [];
    const programmatic = buildProgrammaticClickJs({ ref: 'k3x9ab:e7' });
    const { port, targetId } = await startFakeTarget({
      'Input.dispatchMouseEvent': (params) => {
        mouse.push((params as { type: string }).type);
        return {};
      },
      'Runtime.evaluate': (params: unknown) => {
        const expression = (params as { expression: string }).expression;
        if (expression === programmatic) {
          clicked = true;
          return { result: { value: { ok: true } } };
        }
        if (expression.includes('function resolveTarget')) {
          return {
            result: { value: { ok: true, no_box: true, tag: 'a', reresolved: true } },
          };
        }
        return { result: { value: { url: 'u', selector_appears: clicked } } };
      },
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', {
      ref: 'k3x9ab:e7',
      force: true,
      settle_ms: 0,
      expect: { selector_appears: '#done', timeout_ms: 2000 },
    });
    expect(result).toEqual({
      clicked: 'k3x9ab:e7',
      tag: 'a',
      ref: 'k3x9ab:e7',
      reresolved: true,
      programmatic_click: PROGRAMMATIC_CLICK_NOTE,
      expect: { met: true, elapsed_ms: expect.any(Number) },
    });
    expect(mouse).toEqual([]);
  });

  describe('type and press act only on an element that took focus', () => {
    function refusingPage(sent: string[]): Record<string, Handler> {
      const record =
        (method: string): Handler =>
        () => {
          sent.push(method);
          return {};
        };
      return {
        'Input.insertText': record('Input.insertText'),
        'Input.dispatchKeyEvent': record('Input.dispatchKeyEvent'),
        'Runtime.evaluate': () => ({
          result: { value: { ok: false, reason: 'not-focused', why: 'it is disabled' } },
        }),
      };
    }

    test('type by selector and by ref types nothing and says why', async () => {
      const sent: string[] = [];
      const { port, targetId } = await startFakeTarget(refusingPage(sent));
      grantAccess(port);
      await expect(
        callCdpTool(`cdp:${targetId}`, 'type', { selector: '#off', text: 'secret' }),
      ).rejects.toThrow(notFocusedMessage('#off', 'it is disabled', 'typed'));
      await expect(
        callCdpTool(`cdp:${targetId}`, 'type', { ref: 'k3x9ab:e7', text: 'secret' }),
      ).rejects.toThrow(notFocusedMessage('k3x9ab:e7', 'it is disabled', 'typed'));
      expect(notFocusedMessage('#off', 'it is disabled', 'typed')).toBe(
        'Element #off did not take focus (it is disabled), so nothing was typed: ' +
          'the input would have gone to whatever had focus before; target the field itself',
      );
      expect(sent).toEqual([]);
    });

    test('press by selector and by ref sends no key and says why', async () => {
      const sent: string[] = [];
      const { port, targetId } = await startFakeTarget(refusingPage(sent));
      grantAccess(port);
      await expect(
        callCdpTool(`cdp:${targetId}`, 'press', { selector: '#off', key: 'Enter' }),
      ).rejects.toThrow(notFocusedMessage('#off', 'it is disabled', 'pressed'));
      await expect(
        callCdpTool(`cdp:${targetId}`, 'press', { ref: 'k3x9ab:e7', key: 'Enter' }),
      ).rejects.toThrow(notFocusedMessage('k3x9ab:e7', 'it is disabled', 'pressed'));
      expect(sent).toEqual([]);
    });

    test('press by selector that took focus still sends the key', async () => {
      const sent: string[] = [];
      const { port, targetId } = await startFakeTarget({
        ...refusingPage(sent),
        'Runtime.evaluate': () => ({ result: { value: true } }),
      });
      grantAccess(port);
      await callCdpTool(`cdp:${targetId}`, 'press', {
        selector: '#in',
        key: 'Enter',
        settle_ms: 0,
      });
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent)).toEqual(new Set(['Input.dispatchKeyEvent']));
    });
  });

  test('a programmatic click whose target is gone by then fails as not found (D4)', async () => {
    const programmatic = buildProgrammaticClickJs({ selector: '#go' });
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params: unknown) => {
        const expression = (params as { expression: string }).expression;
        if (expression === programmatic) {
          return { result: { value: { ok: false, reason: 'not-found' } } };
        }
        if (expression.includes('function resolveTarget')) {
          return { result: { value: { ok: true, no_box: true, tag: 'button' } } };
        }
        return { result: { value: true } };
      },
    });
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', force: true, settle_ms: 0 }),
    ).rejects.toThrow('Element not found: #go');
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

  describe('build and view_sig of a connected tab (parity P6, G12)', () => {
    const DOC_INFO = (docId: string, build: string, viewSig: string): string =>
      JSON.stringify({
        type: 'doc_info',
        doc_id: docId,
        url: 'https://example.com/',
        build,
        view_sig: viewSig,
        title: 'Example',
      });

    /** A fake page whose top-document probe answers `doc-1`. */
    function topDocumentPage(): Record<string, Handler> {
      const base = observerPage([]);
      const evaluate = base['Runtime.evaluate'] as Handler;
      return {
        ...base,
        'Runtime.evaluate': (params) =>
          (params as { expression?: string }).expression === TOP_DOCUMENT_PROBE_JS
            ? { result: { value: { doc_id: 'doc-1' } } }
            : evaluate(params),
      };
    }

    const listed = (targetId: string) => [
      {
        tab_id: `cdp:${targetId}`,
        url: 'https://example.com/',
        title: 'Example',
        transport: 'cdp' as const,
      },
    ];

    async function connectAndReport(): Promise<string> {
      const { port, targetId } = await startFakeTarget(topDocumentPage());
      grantAccess(port);
      await callCdpTool(`cdp:${targetId}`, 'ping', {});
      pushEvent('Runtime.bindingCalled', {
        name: OBSERVER_BINDING,
        payload: DOC_INFO('doc-1', '3f9a2b1c', '00aa11bb'),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return targetId;
    }

    test('a connected tab lists the build and view_sig of its top document', async () => {
      const targetId = await connectAndReport();
      expect(withCdpFootprint(listed(targetId))).toEqual([
        { ...listed(targetId)[0], build: '3f9a2b1c', view_sig: '00aa11bb' },
      ]);
    });

    test('a tab whose connection closed lists neither, even before the cache drops it', async () => {
      const targetId = await connectAndReport();
      closeTargetSocket();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(withCdpFootprint(listed(targetId))).toEqual(listed(targetId));
    });

    test('a connected tab that has not reported yet, or whose document restarted, lists neither', async () => {
      const { port, targetId } = await startFakeTarget(topDocumentPage());
      grantAccess(port);
      await callCdpTool(`cdp:${targetId}`, 'ping', {});
      expect(withCdpFootprint(listed(targetId))).toEqual(listed(targetId));
      pushEvent('Runtime.bindingCalled', {
        name: OBSERVER_BINDING,
        payload: DOC_INFO('doc-1', '3f9a2b1c', '00aa11bb'),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A new top document: the old identity must not outlive it.
      pushEvent('Runtime.bindingCalled', {
        name: OBSERVER_BINDING,
        payload: JSON.stringify({
          type: 'doc_start',
          doc_id: 'doc-1',
          url: 'https://example.com/next',
          version: 1,
          coverage: 'full',
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(withCdpFootprint(listed(targetId))).toEqual(listed(targetId));
    });

    test('an unconnected tab lists neither and listing opens no connection', async () => {
      const { port, targetId } = await startFakeTarget(topDocumentPage());
      grantAccess(port);
      expect(withCdpFootprint(listed(targetId))).toEqual(listed(targetId));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connectionCount).toBe(0);
      expect(cachedConnectionCountForTest()).toBe(0);
    });

    test('the learner records the build and view_sig of a connected cdp tab', async () => {
      const targetId = await connectAndReport();
      const recordOutcome = vi.fn();
      await handleBrowserTool(
        'browser.ping',
        { tab_id: `cdp:${targetId}` },
        {
          listTabs: () => [],
          listCdpTabs: async () => withCdpFootprint(listed(targetId)),
          callBrowserTool: async () => {
            throw new Error('the extension transport must not be used for a cdp: tab');
          },
          callCdpTool,
          cdpGate: () => checkCdpDirectGate(),
          recordOutcome,
        },
        { agent_id: 'agent-p6', pid: 9, binary: 'node' },
      );
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ build: '3f9a2b1c', viewSig: '00aa11bb' }),
      );
    });

    // A real navigation, in Chrome's wire order: the new document's
    // doc_start, then its doc_info (pushed from its load handler), then
    // Page.loadEventFired. Each observer message is applied only after its
    // top-document probe answers, and the renderer answers that probe
    // later than Target.getTargetInfo (the browser answers that one).
    // The navigate must not return before the landed document's identity
    // is applied, or what the call reads next depends on that race.
    const LANDED = 'https://example.com/landed';
    function navigatingPage(probe: (doc: { doc_id: string }) => unknown): Record<string, Handler> {
      const base = topDocumentPage();
      return {
        ...base,
        'Runtime.evaluate': (params) =>
          (params as { expression?: string }).expression === TOP_DOCUMENT_PROBE_JS
            ? probe({ doc_id: 'doc-2' })
            : (base['Runtime.evaluate'] as Handler)(params),
        'Page.navigate': () => {
          pushEvent('Runtime.bindingCalled', {
            name: OBSERVER_BINDING,
            payload: JSON.stringify({
              type: 'doc_start',
              doc_id: 'doc-2',
              url: LANDED,
              version: 1,
              coverage: 'full',
            }),
          });
          pushEvent('Runtime.bindingCalled', {
            name: OBSERVER_BINDING,
            payload: JSON.stringify({
              type: 'doc_info',
              doc_id: 'doc-2',
              url: LANDED,
              build: '5e5e5e5e',
              view_sig: '7a7a7a7a',
              title: 'Landed',
            }),
          });
          pushEvent('Page.loadEventFired', {});
          return {};
        },
        'Target.getTargetInfo': () => ({
          targetInfo: { type: 'page', title: 'Landed', url: LANDED },
        }),
      };
    }
    const slowProbe = (doc: { doc_id: string }): Delayed =>
      new Delayed(150, { result: { value: doc } });
    const landedTab = (targetId: string) => [
      { tab_id: `cdp:${targetId}`, url: LANDED, title: 'Landed', transport: 'cdp' as const },
    ];

    test('a navigate returns only after the landed document reported its build and view_sig', async () => {
      const { port, targetId } = await startFakeTarget(navigatingPage(slowProbe));
      grantAccess(port);
      await callCdpTool(`cdp:${targetId}`, 'navigate', { url: LANDED });
      expect(withCdpFootprint(landedTab(targetId))).toEqual([
        { ...landedTab(targetId)[0], build: '5e5e5e5e', view_sig: '7a7a7a7a' },
      ]);
    });

    test('the knowledge of a cdp navigate is looked up with the build it landed on', async () => {
      const { port, targetId } = await startFakeTarget(navigatingPage(slowProbe));
      grantAccess(port);
      const getKnowledge = vi.fn(() => null);
      const recordOutcome = vi.fn();
      await handleBrowserTool(
        'browser.navigate',
        { tab_id: `cdp:${targetId}`, url: LANDED },
        {
          listTabs: () => [],
          listCdpTabs: async () => withCdpFootprint(landedTab(targetId)),
          callBrowserTool: async () => {
            throw new Error('the extension transport must not be used for a cdp: tab');
          },
          callCdpTool,
          cdpGate: () => checkCdpDirectGate(),
          getKnowledge,
          recordOutcome,
        },
        { agent_id: 'agent-p6', pid: 9, binary: 'node' },
      );
      expect(getKnowledge).toHaveBeenCalledWith({
        origin: 'https://example.com',
        pathname: '/landed',
        build: '5e5e5e5e',
      });
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'browser.navigate',
          build: '5e5e5e5e',
          viewSig: '7a7a7a7a',
        }),
      );
    });

    test('a navigate whose top-document probe never answers returns after the probe timeout, without an identity', async () => {
      const { port, targetId } = await startFakeTarget(navigatingPage(() => NO_REPLY));
      grantAccess(port);
      const started = Date.now();
      const result = await callCdpTool(`cdp:${targetId}`, 'navigate', { url: LANDED });
      // The probe gives up after OBSERVER_EVAL_TIMEOUT_MS (2 s).
      expect(Date.now() - started).toBeLessThan(OBSERVER_EVAL_TIMEOUT_MS + 2_000);
      expect(result).toEqual({ title: 'Landed', url: LANDED });
      expect(withCdpFootprint(landedTab(targetId))).toEqual(landedTab(targetId));
    }, 10_000);
  });

  // Parity P3: the dial feeds the connection's pending dialog through core's
  // dialog intake, the click races it, and dialog_respond answers it.
  describe('JavaScript dialogs (parity P3)', () => {
    const OPENING = {
      type: 'alert',
      message: 'e2e alert',
      url: 'https://example.com/',
      hasBrowserHandler: true,
      defaultPrompt: '',
    };
    let sinkEvents: { kind: string; data: Record<string, unknown> }[];

    beforeEach(() => {
      sinkEvents = [];
      setCdpBridgeEventSink((kind, data) => sinkEvents.push({ kind, data }));
    });
    afterEach(() => {
      setCdpBridgeEventSink(null);
    });

    /** A page whose press opens an alert: the opening event, and the press
     * never answered (the page is paused). */
    function alertPage(seen: Seen[], handled: unknown[]): Record<string, Handler> {
      return observerPage(seen, {
        extra: {
          'Input.dispatchMouseEvent': (params) => {
            if ((params as { type: string }).type !== 'mousePressed') return {};
            pushEvent('Page.javascriptDialogOpening', OPENING);
            return NO_REPLY;
          },
          'Page.handleJavaScriptDialog': (params) => {
            handled.push(params);
            pushEvent('Page.javascriptDialogClosed', { result: true, userInput: '' });
            return {};
          },
        },
      });
    }

    test('a click whose press opens a dialog answers at once with the dialog note, as on an extension tab', async () => {
      const seen: Seen[] = [];
      const { port, targetId } = await startFakeTarget(alertPage(seen, []));
      grantAccess(port);
      const started = Date.now();
      const result = await callCdpTool(`cdp:${targetId}`, 'click', {
        selector: '#go',
        settle_ms: 0,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result).toEqual({
        clicked: '#go',
        tag: 'button',
        hit_check: 'not_verifiable',
        hit_check_note: HIT_CHECK_DIALOG_NOTE,
      });
    });

    test('the opening and the close go to the bridge event log for the cdp: tab, and dialog_respond answers the dialog', async () => {
      const seen: Seen[] = [];
      const handled: unknown[] = [];
      const { port, targetId } = await startFakeTarget(alertPage(seen, handled));
      grantAccess(port);
      const tabId = `cdp:${targetId}`;
      await callCdpTool(tabId, 'click', { selector: '#go', settle_ms: 0 });
      expect(sinkEvents).toEqual([
        {
          kind: 'dialog-opening',
          data: {
            type: 'alert',
            message: 'e2e alert',
            default_prompt: '',
            url: 'https://example.com/',
            tab_id: tabId,
          },
        },
      ]);
      await callCdpTool(tabId, 'dialog_respond', { accept: true, prompt_text: 'x' });
      expect(handled).toEqual([{ accept: true, promptText: 'x' }]);
      await vi.waitFor(() => {
        expect(sinkEvents[1]).toEqual({
          kind: 'dialog-closed',
          data: { accept: true, user_input: '', tab_id: tabId },
        });
      });
    });

    test('a dial whose Page.enable gets no answer fails with the named error, closes its socket and caches nothing', async () => {
      let enables = 0;
      const { port, targetId } = await startFakeTarget({
        'Page.enable': () => {
          enables++;
          return enables === 1 ? NO_REPLY : {};
        },
      });
      grantAccess(port);
      setPageEnableTimeoutForTest(100);
      const failure = callCdpTool(`cdp:${targetId}`, 'evaluate', { expression: '1' });
      await expect(failure).rejects.toBeInstanceOf(PageEnableTimeoutError);
      await expect(failure).rejects.toThrow(pageEnableTimeoutMessage(100));
      expect(pageEnableTimeoutMessage(15_000)).toBe(
        'cdp-direct: the page did not answer Page.enable within 15 s; a JavaScript dialog opened while cdp-direct had no connection may be blocking it, or the page is unresponsive; close any dialog in the browser and retry.',
      );
      const firstSocket = (wss as unknown as { _testWs?: WebSocket })._testWs;
      await vi.waitFor(() => {
        expect(firstSocket?.readyState).toBe(WebSocket.CLOSED);
      });
      // The next call dials afresh and works.
      await expect(callCdpTool(`cdp:${targetId}`, 'ping', {})).resolves.toMatchObject({
        url: 'https://example.com/',
      });
      expect(connectionCount).toBe(2);
    });

    test('a Page.enable that fails with a CDP error keeps that error and closes the socket', async () => {
      const { port, targetId } = await startFakeTarget({
        'Page.enable': () => new CdpError('Page.enable refused'),
      });
      grantAccess(port);
      await expect(callCdpTool(`cdp:${targetId}`, 'ping', {})).rejects.toThrow(
        'Page.enable refused',
      );
      const socket = (wss as unknown as { _testWs?: WebSocket })._testWs;
      await vi.waitFor(() => {
        expect(socket?.readyState).toBe(WebSocket.CLOSED);
      });
    });
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

  test('network_url mode matches a request the connection saw finish (parity P5, G8)', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    pushEvent('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/api/items', method: 'GET' },
    });
    pushEvent('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 10 });
    const result = await callCdpTool(`cdp:${targetId}`, 'wait_for', {
      network_url: '/api/items',
      timeout_ms: 2000,
    });
    expect(result).toMatchObject({ matched: true });
  });
});

/*
 * Parity P5 (G5-G8): the dial enables Log and Network and subscribes core's
 * capture intake into one `CaptureBuffers` per connection, BEFORE the
 * observer's Runtime.enable and before Log.enable, whose answers Chrome
 * follows with a replay of the page's earlier console and log entries
 * (lab X2). The buffers are raw: headers and post data as Chrome reports
 * them.
 */
describe('callCdpTool — console and network capture (parity P5)', () => {
  /** A console call the page made before any connection: Chrome replays it
   * after every Runtime.enable, with the same timestamp each time (X2). */
  const REPLAYED = {
    type: 'warning',
    args: [{ type: 'string', value: 'replayed' }],
    timestamp: 1795139718499.537,
  };
  const LOGGED = {
    entry: {
      source: 'network',
      level: 'error',
      text: 'Failed to load resource',
      timestamp: 1795139718505.98,
      url: 'https://example.com/missing',
    },
  };

  /** A page that records the order of its commands and replays one console
   * call after Runtime.enable and one log entry after Log.enable, each
   * pushed before the command's answer. */
  function replayingPage(order: string[]): Record<string, Handler> {
    const recordAs =
      (method: string, replay?: () => void): Handler =>
      () => {
        order.push(method);
        replay?.();
        return method === 'Target.getTargetInfo' ? DEFAULT_PAGE_TARGET_INFO : {};
      };
    return {
      'Target.getTargetInfo': recordAs('Target.getTargetInfo'),
      'Page.enable': recordAs('Page.enable'),
      'Log.enable': recordAs('Log.enable', () => {
        pushEvent('Log.entryAdded', LOGGED);
      }),
      'Network.enable': recordAs('Network.enable'),
      'Runtime.enable': recordAs('Runtime.enable', () => {
        pushEvent('Runtime.consoleAPICalled', REPLAYED);
      }),
    };
  }

  const REPLAYED_ENTRY = {
    timestamp: 1795139718499.537,
    level: 'warn',
    text: 'replayed',
    source: 'console',
  };
  const LOGGED_ENTRY = {
    timestamp: 1795139718505.98,
    level: 'error',
    text: 'Failed to load resource',
    source: 'log',
    url: 'https://example.com/missing',
  };

  test('the dial enables Page, Log and Network before the observer enables Runtime', async () => {
    const order: string[] = [];
    const { port, targetId } = await startFakeTarget(replayingPage(order));
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    // The dial's commands; the ping's own Target.getTargetInfo follows.
    expect(order.slice(0, 5)).toEqual([
      'Target.getTargetInfo',
      'Page.enable',
      'Log.enable',
      'Network.enable',
      'Runtime.enable',
    ]);
  });

  test('the replay that follows Log.enable and Runtime.enable is captured: the intake is subscribed first', async () => {
    const order: string[] = [];
    const { port, targetId } = await startFakeTarget(replayingPage(order));
    grantAccess(port);
    const entries = await callCdpTool(`cdp:${targetId}`, 'console', {});
    expect(entries).toEqual([
      expect.objectContaining(LOGGED_ENTRY),
      expect.objectContaining(REPLAYED_ENTRY),
    ]);
  });

  test('browser.console reads the connection buffer and filters by level', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    pushEvent('Runtime.consoleAPICalled', {
      type: 'log',
      args: [
        { type: 'string', value: 'hello' },
        { type: 'number', value: 1 },
      ],
      timestamp: 10,
    });
    pushEvent('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'boom' }],
      timestamp: 11,
    });
    await vi.waitFor(async () => {
      expect(await callCdpTool(`cdp:${targetId}`, 'console', {})).toHaveLength(2);
    });
    expect(await callCdpTool(`cdp:${targetId}`, 'console', {})).toEqual([
      { timestamp: 10, level: 'log', text: 'hello 1', source: 'console' },
      { timestamp: 11, level: 'error', text: 'boom', source: 'console' },
    ]);
    expect(await callCdpTool(`cdp:${targetId}`, 'console', { level: 'error' })).toEqual([
      { timestamp: 11, level: 'error', text: 'boom', source: 'console' },
    ]);
  });

  test('browser.network reads the connection buffer raw: headers and post data unredacted', async () => {
    const { port, targetId } = await startFakeTarget({});
    grantAccess(port);
    await callCdpTool(`cdp:${targetId}`, 'ping', {});
    pushEvent('Network.requestWillBeSent', {
      requestId: 'r7',
      type: 'Fetch',
      request: {
        url: 'https://example.com/api/login',
        method: 'POST',
        headers: { Authorization: 'Bearer secret-token' },
        postData: 'user=a&password=b',
      },
    });
    pushEvent('Network.responseReceived', {
      requestId: 'r7',
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: { 'Set-Cookie': 'sid=abc' },
      },
    });
    pushEvent('Network.loadingFinished', { requestId: 'r7', encodedDataLength: 42 });
    pushEvent('Network.requestWillBeSent', {
      requestId: 'r8',
      request: { url: 'https://example.com/other.css', method: 'GET' },
    });
    await vi.waitFor(async () => {
      expect(await callCdpTool(`cdp:${targetId}`, 'network', {})).toHaveLength(2);
    });
    const filtered = await callCdpTool(`cdp:${targetId}`, 'network', { url_filter: 'API/LOGIN' });
    expect(filtered).toEqual([
      expect.objectContaining({
        request_id: 'r7',
        url: 'https://example.com/api/login',
        method: 'POST',
        resource_type: 'Fetch',
        request_headers: { Authorization: 'Bearer secret-token' },
        request_post_data: 'user=a&password=b',
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        response_headers: { 'Set-Cookie': 'sid=abc' },
        encoded_data_length: 42,
        finished_at: expect.any(Number) as number,
      }),
    ]);
  });

  test('browser.network_body reads the body over the same connection (G7)', async () => {
    const asked: unknown[] = [];
    const { port, targetId } = await startFakeTarget({
      'Network.getResponseBody': (params) => {
        asked.push(params);
        return { body: '{"ok":true}', base64Encoded: false };
      },
    });
    grantAccess(port);
    const body = await callCdpTool(`cdp:${targetId}`, 'network_body', { request_id: 'r7' });
    expect(body).toEqual({ body: '{"ok":true}', base64Encoded: false });
    expect(asked).toEqual([{ requestId: 'r7' }]);
  });

  test('a redial does not duplicate the replayed console history', async () => {
    const order: string[] = [];
    const { port, targetId } = await startFakeTarget(replayingPage(order));
    grantAccess(port);
    const first = await callCdpTool(`cdp:${targetId}`, 'console', {});
    expect(first).toHaveLength(2);

    closeTargetSocket();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await callCdpTool(`cdp:${targetId}`, 'console', {});
    expect(connectionCount).toBe(2);
    expect(second).toEqual(first);
  });

  test('a Network.enable that fails fails the dial and closes the socket', async () => {
    const { port, targetId } = await startFakeTarget({
      'Network.enable': () => new CdpError('Network.enable refused'),
    });
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'ping', {})).rejects.toThrow(
      'Network.enable refused',
    );
    const socket = (wss as unknown as { _testWs?: WebSocket })._testWs;
    await vi.waitFor(() => {
      expect(socket?.readyState).toBe(WebSocket.CLOSED);
    });
  });
});

describe('callCdpTool — ref as a target (spec v4 §6.3)', () => {
  /** Answers every `Runtime.evaluate` whose source carries the ref as data
   * (`"ref":"k3x9ab:e7"`) with `answer`, and anything else (settle, observer
   * probes) with `true`. Records the ref-carrying expressions. */
  function refPage(answer: unknown, seen: string[]): Record<string, Handler> {
    return {
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"ref":"k3x9ab:e7"')) {
          seen.push(expression);
          return { result: { value: answer } };
        }
        // The move was seen on the target.
        if (expression === buildClickMoveCheckJs()) {
          return { result: { value: { armed: true, moved: true } } };
        }
        if (expression === buildClickHitCheckJs()) {
          return { result: { value: { armed: true, landed: true } } };
        }
        return { result: { value: true } };
      },
    };
  }
  const STALE = { ok: false, reason: 'ref-stale', ref: 'k3x9ab:e7', doc_id: 'doc-1' };
  const UNAVAILABLE = { ok: false, reason: 'observer-unavailable' };

  test('click by ref reaches the built JS and reports ref and reresolved', async () => {
    const seen: string[] = [];
    const { port, targetId } = await startFakeTarget(
      refPage({ ok: true, x: 5, y: 6, tag: 'button', reresolved: true }, seen),
    );
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', {
      ref: 'k3x9ab:e7',
      settle_ms: 0,
    });
    expect(result).toEqual({
      clicked: 'k3x9ab:e7',
      tag: 'button',
      ref: 'k3x9ab:e7',
      reresolved: true,
    });
    // The resolve, then the aim (after the scroll) re-resolve the same ref.
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain('function resolveTarget');
    expect(seen[1]).toContain('function resolveTarget');
    expect(seen[1]).toContain('requestAnimationFrame');
  });

  test('click by a stale ref rejects with the ref-stale error naming the doc_id', async () => {
    const { port, targetId } = await startFakeTarget(refPage(STALE, []));
    grantAccess(port);
    await expect(callCdpTool(`cdp:${targetId}`, 'click', { ref: 'k3x9ab:e7' })).rejects.toThrow(
      'ref-stale: k3x9ab:e7 not found in document doc-1: the element is gone, take a new snapshot',
    );
  });

  test('type by ref without the observer rejects with observer-unavailable', async () => {
    const { port, targetId } = await startFakeTarget(refPage(UNAVAILABLE, []));
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'type', { ref: 'k3x9ab:e7', text: 'hi' }),
    ).rejects.toThrow(
      'observer-unavailable: ref k3x9ab:e7 cannot be resolved without the page observer',
    );
  });

  test('type by ref types and reports the ref (no selector key)', async () => {
    const { port, targetId } = await startFakeTarget(refPage({ ok: true }, []));
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'type', {
      ref: 'k3x9ab:e7',
      text: 'hi',
      settle_ms: 0,
    });
    expect(result).toEqual({ typed: 2, ref: 'k3x9ab:e7' });
  });

  test('press by ref focuses through the ref and reports it', async () => {
    const seen: string[] = [];
    const { port, targetId } = await startFakeTarget(refPage({ ok: true }, seen));
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'press', {
      key: 'Enter',
      ref: 'k3x9ab:e7',
      settle_ms: 0,
    });
    expect(result).toEqual({ key: 'Enter', modifiers: [], ref: 'k3x9ab:e7' });
    expect(seen.length).toBe(1);
  });

  test('press by a stale ref rejects with ref-stale', async () => {
    const { port, targetId } = await startFakeTarget(refPage(STALE, []));
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'press', { key: 'Enter', ref: 'k3x9ab:e7' }),
    ).rejects.toThrow(
      'ref-stale: k3x9ab:e7 not found in document doc-1: the element is gone, take a new snapshot',
    );
  });

  test('find by ref returns the match; a stale ref rejects', async () => {
    const match = { matched: true, selector: '#b', ref: 'k3x9ab:e7', tag: 'button', text: 'Beta' };
    const ok = await startFakeTarget(refPage(match, []));
    grantAccess(ok.port);
    expect(await callCdpTool(`cdp:${ok.targetId}`, 'find', { ref: 'k3x9ab:e7' })).toEqual(match);
    resetConnectionsForTest();
    wss?.close();
    const stale = await startFakeTarget(
      refPage({ matched: false, reason: 'ref-stale', ref: 'k3x9ab:e7', doc_id: 'doc-1' }, []),
    );
    grantAccess(stale.port);
    await expect(
      callCdpTool(`cdp:${stale.targetId}`, 'find', { ref: 'k3x9ab:e7' }),
    ).rejects.toThrow(
      'ref-stale: k3x9ab:e7 not found in document doc-1: the element is gone, take a new snapshot',
    );
  });

  test('wait_for by ref polls the ref probe; without the observer it rejects', async () => {
    const seen: string[] = [];
    const ok = await startFakeTarget(refPage(true, seen));
    grantAccess(ok.port);
    const result = await callCdpTool(`cdp:${ok.targetId}`, 'wait_for', {
      ref: 'k3x9ab:e7',
      condition: 'detached',
    });
    expect(result).toMatchObject({ matched: true, checks: 1 });
    expect(seen[0]).toContain('"condition":"detached"');
    resetConnectionsForTest();
    wss?.close();
    const none = await startFakeTarget(refPage(UNAVAILABLE, []));
    grantAccess(none.port);
    await expect(
      callCdpTool(`cdp:${none.targetId}`, 'wait_for', { ref: 'k3x9ab:e7', timeout_ms: 1000 }),
    ).rejects.toThrow(
      'observer-unavailable: ref k3x9ab:e7 cannot be resolved without the page observer',
    );
  });

  /** Answers the ref probe with `answers` in order (the last one repeats). */
  function sequencePage(answers: unknown[], seen: string[]): Record<string, Handler> {
    return {
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"ref":"k3x9ab:e7"')) {
          const value = answers[Math.min(seen.length, answers.length - 1)];
          seen.push(expression);
          return { result: { value } };
        }
        return { result: { value: true } };
      },
    };
  }
  const GONE_MESSAGE =
    'ref-stale: k3x9ab:e7 not found in document doc-1: the element is gone, take a new snapshot';

  test('wait_for visible/attached by a ref of another document fails at once with the ref-stale message', async () => {
    for (const condition of ['visible', 'attached']) {
      const seen: string[] = [];
      const page = await startFakeTarget(sequencePage([{ ...STALE, doc_changed: true }], seen));
      grantAccess(page.port);
      await expect(
        callCdpTool(`cdp:${page.targetId}`, 'wait_for', {
          ref: 'k3x9ab:e7',
          condition,
          timeout_ms: 5_000,
        }),
      ).rejects.toThrow(GONE_MESSAGE);
      expect(seen).toHaveLength(1);
      resetConnectionsForTest();
      wss?.close();
    }
  });

  test('wait_for by a ref whose node is only detached keeps polling, then times out with the usual result plus ref_gone', async () => {
    const seen: string[] = [];
    const page = await startFakeTarget(sequencePage([{ ...STALE, doc_changed: false }], seen));
    grantAccess(page.port);
    const result = await callCdpTool(`cdp:${page.targetId}`, 'wait_for', {
      ref: 'k3x9ab:e7',
      condition: 'visible',
      timeout_ms: 300,
      poll_interval_ms: 50,
    });
    expect(result).toEqual({
      matched: false,
      elapsed_ms: expect.any(Number),
      checks: expect.any(Number),
      reason: 'timeout',
      ref_gone: 'k3x9ab:e7 not found in document doc-1: the element is gone, take a new snapshot',
    });
    expect(seen.length).toBeGreaterThan(1);
  });

  test('a wait_for step in a flow on a gone ref fails as before, the failure text carrying the sentence', async () => {
    const page = await startFakeTarget(sequencePage([{ ...STALE, doc_changed: false }], []));
    grantAccess(page.port);
    const result = (await callCdpTool(`cdp:${page.targetId}`, 'flow', {
      steps: [{ wait_for: { ref: 'k3x9ab:e7', condition: 'attached', timeout_ms: 200 } }],
    })) as { ok: boolean; error: string; failed_step: number };
    expect(result).toMatchObject({ ok: false, failed_step: 0 });
    expect(result.error).toMatch(
      /^wait_for: condition not met within timeout \(\d+ms, \d+ checks\) — /,
    );
    expect(result.error).toContain(
      'k3x9ab:e7 not found in document doc-1: the element is gone, take a new snapshot',
    );
  });

  test('wait_for by a ref that is re-rendered while waiting matches (the polling is what makes it legitimate)', async () => {
    const seen: string[] = [];
    const page = await startFakeTarget(
      sequencePage(
        [{ ...STALE, doc_changed: false }, { ...STALE, doc_changed: false }, true],
        seen,
      ),
    );
    grantAccess(page.port);
    const result = await callCdpTool(`cdp:${page.targetId}`, 'wait_for', {
      ref: 'k3x9ab:e7',
      condition: 'attached',
      timeout_ms: 5_000,
      poll_interval_ms: 50,
    });
    expect(result).toMatchObject({ matched: true, checks: 3 });
  });

  test('wait_for hidden/detached on a gone ref stays true', async () => {
    const page = await startFakeTarget(sequencePage([true], []));
    grantAccess(page.port);
    const result = await callCdpTool(`cdp:${page.targetId}`, 'wait_for', {
      ref: 'k3x9ab:e7',
      condition: 'hidden',
    });
    expect(result).toMatchObject({ matched: true, checks: 1 });
  });

  test('click by selector is unchanged (no ref or reresolved key)', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"selector":"#go"')) {
          return { result: { value: { ok: true, x: 1, y: 2, tag: 'a' } } };
        }
        // The move was seen on the target.
        if (expression === buildClickMoveCheckJs()) {
          return { result: { value: { armed: true, moved: true } } };
        }
        if (expression === buildClickHitCheckJs()) {
          return { result: { value: { armed: true, landed: true } } };
        }
        return { result: { value: true } };
      },
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 });
    expect(result).toEqual({ clicked: '#go', tag: 'a' });
  });

  test('a page whose landing check answers nothing usable: the click says it was not verified', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"selector":"#go"')) {
          return { result: { value: { ok: true, x: 1, y: 2, tag: 'a' } } };
        }
        // The move was seen on the target.
        if (expression === buildClickMoveCheckJs()) {
          return { result: { value: { armed: true, moved: true } } };
        }
        if (expression === buildClickHitCheckJs()) return { result: { value: { armed: false } } };
        return { result: { value: true } };
      },
    });
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 });
    expect(result).toEqual({
      clicked: '#go',
      tag: 'a',
      hit_check: 'not_verifiable',
      hit_check_note:
        'the document was replaced during the click (it navigated), so where the click landed was not verified',
    });
  });

  test('a press seen nowhere fails the click with the miss message', async () => {
    const { port, targetId } = await startFakeTarget({
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"selector":"#go"')) {
          return { result: { value: { ok: true, x: 1, y: 2, tag: 'a' } } };
        }
        // The move was seen on the target.
        if (expression === buildClickMoveCheckJs()) {
          return { result: { value: { armed: true, moved: true } } };
        }
        if (expression === buildClickHitCheckJs()) {
          return { result: { value: { armed: true, landed: false } } };
        }
        return { result: { value: true } };
      },
    });
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 }),
    ).rejects.toThrow(/^Click on #go did not reach it: .*stopImmediatePropagation/);
  });
});

describe('callCdpTool — the press is sent only after the move was seen on the target', () => {
  /** A page whose move check answers `moves` in turn (the last one repeats);
   * `log` gets each mouse event type and each move check, in order. */
  function movePage(
    log: string[],
    moves: unknown[],
    aim: Record<string, unknown> = { ok: true, x: 1, y: 2, tag: 'a' },
  ): Record<string, Handler> {
    let checks = 0;
    return {
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression.includes('"selector":"#go"')) return { result: { value: aim } };
        if (expression === buildClickMoveCheckJs()) {
          log.push('move-check');
          const answer = moves[Math.min(checks, moves.length - 1)];
          checks++;
          return { result: { value: answer } };
        }
        if (expression === buildClickHitCheckJs()) {
          return { result: { value: { armed: true, landed: true } } };
        }
        return { result: { value: true } };
      },
      'Input.dispatchMouseEvent': (params) => {
        log.push((params as { type: string }).type);
        return {};
      },
    };
  }

  test('a first move not seen on the target is sent again; the press follows the confirmed move', async () => {
    const log: string[] = [];
    const { port, targetId } = await startFakeTarget(
      movePage(log, [
        { armed: true, moved: false },
        { armed: true, moved: true },
      ]),
    );
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 });
    expect(result).toEqual({ clicked: '#go', tag: 'a' });
    expect(log).toEqual([
      'mouseMoved',
      'move-check',
      'mouseMoved',
      'move-check',
      'mousePressed',
      'mouseReleased',
    ]);
  });

  test('a move never seen on the target fails the click and sends no press', async () => {
    const log: string[] = [];
    const { port, targetId } = await startFakeTarget(
      movePage(log, [{ armed: true, moved: false }]),
    );
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 }),
    ).rejects.toThrow(/^Click on #go did not reach it: .*no press was sent/);
    expect(log).not.toContain('mousePressed');
    expect(log).not.toContain('mouseReleased');
    expect(log.filter((e) => e === 'mouseMoved')).toHaveLength(CLICK_MOVE_TRIES);
  });

  test('a forced click on a covered target: the move seen on the cover counts, the press is sent', async () => {
    const log: string[] = [];
    const { port, targetId } = await startFakeTarget(
      movePage(log, [{ armed: true, moved: true }], {
        ok: true,
        x: 1,
        y: 2,
        tag: 'a',
        hit_element: 'div#cover',
      }),
    );
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', {
      selector: '#go',
      force: true,
      settle_ms: 0,
    });
    expect(result).toEqual({ clicked: '#go', tag: 'a', hit_element: 'div#cover' });
    expect(log).toEqual(['mouseMoved', 'move-check', 'mousePressed', 'mouseReleased']);
  });

  test.each([
    [
      'throws',
      { exceptionDetails: { text: 'boom' } },
      /did not reach it: .*the page did not answer the move check.*no press was sent/,
    ],
    [
      'answers nothing usable',
      { result: { value: true } },
      /did not reach it: .*the page did not answer the move check.*no press was sent/,
    ],
    [
      'answers that the watch is gone',
      { result: { value: { armed: false } } },
      /did not reach it: .*document was replaced.*no press was sent/,
    ],
  ])('a move check that %s fails the click closed: no press', async (_name, reply, error) => {
    const log: string[] = [];
    const page = movePage(log, []);
    const evaluate = page['Runtime.evaluate'];
    page['Runtime.evaluate'] = (params) => {
      if ((params as { expression: string }).expression === buildClickMoveCheckJs()) {
        log.push('move-check');
        return reply;
      }
      return evaluate(params);
    };
    const { port, targetId } = await startFakeTarget(page);
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 }),
    ).rejects.toThrow(error);
    expect(log).toEqual(['mouseMoved', 'move-check']);
  });

  test('a move check that never answers fails the click closed within the move budget: no press', async () => {
    const log: string[] = [];
    const page = movePage(log, []);
    const evaluate = page['Runtime.evaluate'];
    page['Runtime.evaluate'] = (params) => {
      if ((params as { expression: string }).expression === buildClickMoveCheckJs()) {
        log.push('move-check');
        return NO_REPLY;
      }
      return evaluate(params);
    };
    const { port, targetId } = await startFakeTarget(page);
    grantAccess(port);
    const started = Date.now();
    await expect(
      callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 }),
    ).rejects.toThrow(
      /did not reach it: .*the page did not answer the move check.*no press was sent/,
    );
    expect(Date.now() - started).toBeLessThan(HIT_CHECK_TIMEOUT_MS + 1000);
    expect(log).toEqual(['mouseMoved', 'move-check']);
  });

  test('a frame element cannot have its move confirmed: the click is sent as before, not verified', async () => {
    const log: string[] = [];
    const { port, targetId } = await startFakeTarget(
      movePage(log, [{ armed: true, moved: false }], {
        ok: true,
        x: 1,
        y: 2,
        tag: 'iframe',
        hit_check: 'not_verifiable',
      }),
    );
    grantAccess(port);
    const result = await callCdpTool(`cdp:${targetId}`, 'click', { selector: '#go', settle_ms: 0 });
    expect(result).toMatchObject({ clicked: '#go', tag: 'iframe', hit_check: 'not_verifiable' });
    expect(log).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });
});

describe('callCdpTool — find by semantic key (spec v4 §6.3, S3)', () => {
  test('find by key reaches the built JS with the key as data and returns the result', async () => {
    const seen: string[] = [];
    const match = {
      matched: true,
      selector: '#b',
      ref: 'k3x9ab:e3',
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

/*
 * S2 on the cdp-direct executor: `type` / `press` report whether the field
 * they act on is one the page declares sensitive, read with
 * `buildFocusedFieldJs` after the target is focused, and the trail row of
 * such a call stores the marker instead of the typed text or key.
 */
describe('callCdpTool — sensitive fields (S2)', () => {
  /** A page whose focused field answers `field`; resolve/focus succeed. */
  function fieldPage(field: unknown, seen: string[] = []): Record<string, Handler> {
    return {
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression === buildFocusedFieldJs()) {
          seen.push('field');
          if (field instanceof CdpError) return field;
          return { result: { value: field } };
        }
        if (expression.includes("reason: 'invalid-selector'"))
          return { result: { value: { ok: true } } };
        return { result: { value: true } };
      },
      'Input.insertText': () => {
        seen.push('insertText');
        return {};
      },
    };
  }

  test('type and press report sensitive_field: true on a sensitive field, read before the input', async () => {
    const seen: string[] = [];
    const { port, targetId } = await startFakeTarget(fieldPage({ sensitive_field: true }, seen));
    grantAccess(port);
    expect(
      await callCdpTool(`cdp:${targetId}`, 'type', {
        selector: '#pw',
        text: 'hunter2',
        settle_ms: 0,
      }),
    ).toEqual({ typed: 7, selector: '#pw', sensitive_field: true });
    expect(seen).toEqual(['field', 'insertText']);
    expect(await callCdpTool(`cdp:${targetId}`, 'press', { key: 'h', settle_ms: 0 })).toEqual({
      key: 'h',
      modifiers: [],
      sensitive_field: true,
    });
  });

  test('a plain field reports sensitive_field: false', async () => {
    const { port, targetId } = await startFakeTarget(fieldPage({ sensitive_field: false }));
    grantAccess(port);
    expect(
      await callCdpTool(`cdp:${targetId}`, 'type', {
        selector: '#name',
        text: 'alpha',
        settle_ms: 0,
      }),
    ).toEqual({ typed: 5, selector: '#name', sensitive_field: false });
  });

  test('a field check that fails or answers nothing usable leaves the field out and the action succeeds', async () => {
    for (const field of [new CdpError('Execution context was destroyed'), true, undefined]) {
      const { port, targetId } = await startFakeTarget(fieldPage(field));
      grantAccess(port);
      expect(
        await callCdpTool(`cdp:${targetId}`, 'type', {
          selector: '#pw',
          text: 'hunter2',
          settle_ms: 0,
        }),
      ).toEqual({ typed: 7, selector: '#pw' });
      expect(await callCdpTool(`cdp:${targetId}`, 'press', { key: 'Enter', settle_ms: 0 })).toEqual(
        {
          key: 'Enter',
          modifiers: [],
        },
      );
      resetConnectionsForTest();
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
      wss = null;
    }
  });

  describe('end to end through the dispatcher into the activity database', () => {
    afterEach(() => {
      closeActivityDb();
    });

    function dispatchDeps(recordActivityPayloads: boolean): BrowserToolDeps {
      return {
        listTabs: () => [],
        callBrowserTool: async () => {
          throw new Error('the extension transport must not be used for a cdp: tab');
        },
        callCdpTool,
        cdpGate: () => checkCdpDirectGate(),
        recordActivity: (row) => {
          record(row);
        },
        recordActivityPayloads,
      };
    }

    const CALLER = { agent_id: 'agent-cdp-s2', pid: 9, binary: 'node' };

    function storedPayloads(): (string | null)[] {
      return query({ agentId: CALLER.agent_id }).records.map((r) => r.payload);
    }

    test.each([
      ['browser.type', { selector: '#pw', text: 'hunter2', settle_ms: 0 }, 'hunter2'],
      ['browser.press', { selector: '#pw', key: 'h', settle_ms: 0 }, 'h'],
    ] as const)(
      '%s on a sensitive field: result flags it, the stored row has the marker (payloads on and off)',
      async (tool, args, secret) => {
        const { port, targetId } = await startFakeTarget(fieldPage({ sensitive_field: true }));
        grantAccess(port);
        const tabArgs = { tab_id: `cdp:${targetId}`, ...args };
        for (const recordPayloads of [true, false]) {
          const result = (await handleBrowserTool(
            tool,
            tabArgs,
            dispatchDeps(recordPayloads),
            CALLER,
          )) as {
            sensitive_field?: boolean;
          };
          expect(result.sensitive_field).toBe(true);
        }
        const payloads = storedPayloads();
        expect(payloads).toEqual([SENSITIVE_PAYLOAD_MARKER, SENSITIVE_PAYLOAD_MARKER]);
        expect(payloads).not.toContain(secret);
        expect(
          query({ agentId: CALLER.agent_id }).records.every((r) => r.transport === 'cdp'),
        ).toBe(true);
      },
    );

    test('a plain field on cdp-direct is stored as today', async () => {
      const { port, targetId } = await startFakeTarget(fieldPage({ sensitive_field: false }));
      grantAccess(port);
      const args = { tab_id: `cdp:${targetId}`, selector: '#name', text: 'alpha', settle_ms: 0 };
      const on = await handleBrowserTool('browser.type', args, dispatchDeps(true), CALLER);
      expect(on).toEqual({ typed: 5, selector: '#name', sensitive_field: false });
      await handleBrowserTool('browser.type', args, dispatchDeps(false), CALLER);
      // Newest first.
      expect(storedPayloads()).toEqual([null, 'alpha']);
    });
  });
});

/*
 * S2 failure path on cdp-direct: a `type` / `press` that fails AFTER the
 * focused-field probe said the field is sensitive throws the same error
 * text, marked so the trail row stores the marker instead of the input.
 */
describe('callCdpTool — a failed action on a sensitive field (S2)', () => {
  const UNMET = { url_changed: true, timeout_ms: 150 };
  const CALLER = { agent_id: 'agent-cdp-s2-fail', pid: 9, binary: 'node' };

  /** Focused field answers `field`; resolve/focus succeed; the expect
   * probe sees an unchanging page, so `url_changed` is never met. */
  function unmetPage(field: unknown): Record<string, Handler> {
    return {
      'Runtime.evaluate': (params) => {
        const expression = (params as { expression: string }).expression;
        if (expression === buildFocusedFieldJs()) {
          return field instanceof CdpError ? field : { result: { value: field } };
        }
        if (expression.includes("reason: 'invalid-selector'")) {
          return { result: { value: { ok: true } } };
        }
        return { result: { value: { url: 'https://example.com/' } } };
      },
    };
  }

  afterEach(() => {
    closeActivityDb();
  });

  function dispatchDeps(
    recordActivityPayloads: boolean,
    hideSensitiveActivity?: boolean,
  ): BrowserToolDeps {
    return {
      listTabs: () => [],
      callBrowserTool: async () => {
        throw new Error('the extension transport must not be used for a cdp: tab');
      },
      callCdpTool,
      cdpGate: () => checkCdpDirectGate(),
      recordActivity: (row) => {
        record(row);
      },
      recordActivityPayloads,
      ...(hideSensitiveActivity === undefined ? {} : { hideSensitiveActivity }),
    };
  }

  const rows = (): { payload: string | null; outcome: string; error: string | null }[] =>
    query({ agentId: CALLER.agent_id }).records;

  test.each([
    ['browser.type', { selector: '#pw', text: 'hunter2', settle_ms: 0, expect: UNMET }, 'hunter2'],
    ['browser.press', { selector: '#pw', key: 'h', settle_ms: 0, expect: UNMET }, 'h'],
  ] as const)(
    '%s: same error text for the agent, the row stores the marker (payloads on and off)',
    async (tool, args, secret) => {
      const { port, targetId } = await startFakeTarget(unmetPage({ sensitive_field: true }));
      grantAccess(port);
      const tabArgs = { tab_id: `cdp:${targetId}`, ...args };
      for (const recordPayloads of [true, false]) {
        await expect(
          handleBrowserTool(tool, tabArgs, dispatchDeps(recordPayloads), CALLER),
        ).rejects.toThrow(/^expectation not met: url_changed after \d+ms/);
      }
      expect(rows().map((r) => r.payload)).toEqual([
        SENSITIVE_PAYLOAD_MARKER,
        SENSITIVE_PAYLOAD_MARKER,
      ]);
      expect(rows().map((r) => r.payload)).not.toContain(secret);
      expect(
        rows().every((r) => r.outcome === 'error' && /^expectation not met/.test(r.error ?? '')),
      ).toBe(true);
    },
  );

  // A failure carries the field verdict only when it is sensitive, so a
  // failed type on a plain field reads like one that never reached the
  // field: hidden as not identified by default (D13), as before when the
  // trail stores sensitive rows unhidden.
  test('a failed type on a plain field: not identified by default, the text when stored unhidden', async () => {
    const { port, targetId } = await startFakeTarget(unmetPage({ sensitive_field: false }));
    grantAccess(port);
    const args = {
      tab_id: `cdp:${targetId}`,
      selector: '#name',
      text: 'alpha',
      settle_ms: 0,
      expect: UNMET,
    };
    await expect(
      handleBrowserTool('browser.type', args, dispatchDeps(true), CALLER),
    ).rejects.toThrow(/^expectation not met/);
    await expect(
      handleBrowserTool('browser.type', args, dispatchDeps(true, false), CALLER),
    ).rejects.toThrow(/^expectation not met/);
    expect(rows().map((r) => r.payload)).toEqual(['alpha', UNIDENTIFIED_FIELD_MARKER]);
  });

  test('a failure with no field report (probe failed): not identified by default, the text when stored unhidden', async () => {
    const { port, targetId } = await startFakeTarget(unmetPage(new CdpError('context destroyed')));
    grantAccess(port);
    const args = {
      tab_id: `cdp:${targetId}`,
      selector: '#pw',
      text: 'hunter2',
      settle_ms: 0,
      expect: UNMET,
    };
    await expect(
      handleBrowserTool('browser.type', args, dispatchDeps(true), CALLER),
    ).rejects.toThrow(/^expectation not met/);
    await expect(
      handleBrowserTool('browser.type', args, dispatchDeps(true, false), CALLER),
    ).rejects.toThrow(/^expectation not met/);
    expect(rows().map((r) => r.payload)).toEqual(['hunter2', UNIDENTIFIED_FIELD_MARKER]);
  });
});

// Parity G10 (owner decision 2026-11-21, option a): set_permission on a cdp:
// tab is Browser.setPermission on the tab's own page connection, for the
// origin, with no browserContextId; the result says the override is
// temporary.
describe('callCdpTool — set_permission as a temporary override (parity G10)', () => {
  const TEMPORARY_NOTE =
    'Temporary: on a cdp: tab this permission is a DevTools override, not a saved site setting. It lasts while browser-link stays connected to the tab (the connection is dropped after 30 minutes without a tool call on the tab, 5 when nothing was captured) and another DevTools client disconnecting from the browser can clear it earlier.';

  function permissionPage(sent: unknown[]): Record<string, Handler> {
    return {
      'Browser.setPermission': (params) => {
        sent.push(params);
        return {};
      },
    };
  }

  test.each([
    ['granted', 'geolocation', 'geolocation', 'location'],
    ['denied', 'notifications', 'notifications', 'notifications'],
  ])(
    'state %s for %s sends Browser.setPermission on the page connection with the origin and answers the temporary note',
    async (state, name, descriptor, appliedAs) => {
      const sent: unknown[] = [];
      const { port, targetId } = await startFakeTarget(permissionPage(sent));
      grantAccess(port);
      const result = await callCdpTool(`cdp:${targetId}`, 'set_permission', {
        origin: 'https://example.com',
        name,
        state,
      });
      expect(sent).toEqual([
        { permission: { name: descriptor }, setting: state, origin: 'https://example.com' },
      ]);
      expect(result).toEqual({
        origin: 'https://example.com',
        name,
        state,
        applied_as: appliedAs,
        note: TEMPORARY_NOTE,
      });
      expect(connectionCount).toBe(1);
    },
  );

  test('the names whose content setting differs map to the descriptor Chrome takes for it', async () => {
    const sent: { permission: { name: string } }[] = [];
    const { port, targetId } = await startFakeTarget(permissionPage(sent));
    grantAccess(port);
    for (const name of [
      'camera',
      'microphone',
      'clipboardReadWrite',
      'clipboardSanitizedWrite',
      'sensors',
    ]) {
      await callCdpTool(`cdp:${targetId}`, 'set_permission', {
        origin: 'https://example.com/*',
        name,
        state: 'prompt',
      });
    }
    expect(sent).toEqual(
      ['camera', 'microphone', 'clipboard-read', 'clipboard-read', 'accelerometer'].map(
        (descriptor) => ({
          permission: { name: descriptor },
          setting: 'prompt',
          origin: 'https://example.com',
        }),
      ),
    );
  });

  test('an unsupported name fails with the extension text without the MV3 wording and sends nothing', async () => {
    const sent: unknown[] = [];
    const { port, targetId } = await startFakeTarget(permissionPage(sent));
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'set_permission', {
        origin: 'https://example.com',
        name: 'midi',
        state: 'granted',
      }),
    ).rejects.toThrow(
      new Error(
        "set_permission: 'midi' is not supported. Supported names: geolocation, notifications, camera, microphone, clipboardReadWrite, clipboardSanitizedWrite, sensors.",
      ),
    );
    expect(sent).toEqual([]);
  });

  test("Chrome's refusal is the error, unchanged after the tool prefix", async () => {
    const { port, targetId } = await startFakeTarget({
      'Browser.setPermission': () => new CdpError('Unknown permission setting: maybe'),
    });
    grantAccess(port);
    await expect(
      callCdpTool(`cdp:${targetId}`, 'set_permission', {
        origin: 'https://example.com',
        name: 'camera',
        state: 'granted',
      }),
    ).rejects.toThrow(new Error('set_permission: Unknown permission setting: maybe'));
  });
});
