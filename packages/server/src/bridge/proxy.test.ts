import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { PEER_GATE_MAX_MS } from '../auth/peer-lookup-limiter.js';
import { LOOKUP_TIMEOUT_MS, NETSTAT_RETRY_DELAYS_MS } from '../auth/process-identity.js';
import type { ConnectOptions } from './ipc-client.js';
import {
  DEFAULT_REELECT_INTERVAL_MS,
  DEFAULT_REELECT_TIMEOUT_MS,
  RECONNECT_HANDSHAKE_TIMEOUT_MS,
  runProxy,
} from './proxy.js';

/* S5.3: one reconnect attempt of auto-reelect waits for the primary's peer
 * check, and the reelect window holds at least two such attempts. The IPC
 * client and the token file are replaced, so no socket and no real timer. */

const state = vi.hoisted(() => ({
  connects: [] as Array<ConnectOptions | undefined>,
  closeHandlers: [] as Array<(reason: 'remote' | 'local' | 'primary-closing') => void>,
  /** How a reconnect (any connect after the first) behaves: `accept`
   * answers the hello; `silent` is a primary that accepts the connection
   * and never answers it, so the attempt ends at its handshake timeout,
   * except before `refuseUntil` (fake clock), when the port refuses at once. */
  reconnect: 'accept' as 'accept' | 'silent',
  refuseUntil: 0,
}));

vi.mock('./ipc-client.js', () => ({
  IpcClient: class {
    connect(_token: string, opts?: ConnectOptions) {
      state.connects.push(opts);
      if (state.connects.length === 1 || state.reconnect === 'accept') {
        return Promise.resolve({ sessionId: 's', version: '1' });
      }
      if (Date.now() < state.refuseUntil) return Promise.reject(new Error('ECONNREFUSED'));
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('Handshake timed out — primary did not reply.'));
        }, opts?.handshakeTimeoutMs ?? 4000);
      });
    }
    onClose(cb: (reason: 'remote' | 'local' | 'primary-closing') => void) {
      state.closeHandlers.push(cb);
    }
    disconnect() {
      return Promise.resolve();
    }
    sendMcpNotification() {}
    sendMcpRequest() {
      return Promise.resolve({});
    }
  },
}));
vi.mock('./token.js', () => ({ readToken: () => 'token' }));

describe('auto-reelect timing', () => {
  let logged: string[];
  beforeEach(() => {
    state.connects.length = 0;
    state.closeHandlers.length = 0;
    state.reconnect = 'accept';
    state.refuseUntil = 0;
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('one reconnect attempt waits at least as long as the primary peer check can take', () => {
    // The normal path: netstat snapshots (with their retry waits) and one
    // CIM call bounded by its own command timeout.
    const normalPath = NETSTAT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + LOOKUP_TIMEOUT_MS;
    expect(PEER_GATE_MAX_MS).toBeGreaterThanOrEqual(normalPath);
    expect(RECONNECT_HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(PEER_GATE_MAX_MS);
  });

  test('the default reelect window allows at least two full attempts', () => {
    expect(DEFAULT_REELECT_TIMEOUT_MS).toBeGreaterThanOrEqual(
      2 * (DEFAULT_REELECT_INTERVAL_MS + RECONNECT_HANDSHAKE_TIMEOUT_MS),
    );
  });

  test.each([undefined, 1000])(
    'a reconnect attempt (interval %s) is given the full handshake budget',
    async (interval) => {
      await runProxy({
        input: new PassThrough(),
        output: new PassThrough(),
        token: 'token',
        autoReelect: true,
        ...(interval === undefined ? {} : { reelectIntervalMs: interval }),
      });
      state.closeHandlers[0]?.('remote');
      await vi.advanceTimersByTimeAsync(interval ?? DEFAULT_REELECT_INTERVAL_MS);
      expect(state.connects).toHaveLength(2);
      expect(state.connects[1]?.handshakeTimeoutMs).toBe(RECONNECT_HANDSHAKE_TIMEOUT_MS);
    },
  );

  test('without an override the reelect window is the default one', async () => {
    await runProxy({
      input: new PassThrough(),
      output: new PassThrough(),
      token: 'token',
      autoReelect: true,
    });
    state.closeHandlers[0]?.('remote');
    await vi.advanceTimersByTimeAsync(DEFAULT_REELECT_INTERVAL_MS);
    expect(logged).toContain(
      `[browser-link proxy] Primary closed (remote); reelect window opened for ${String(DEFAULT_REELECT_TIMEOUT_MS)}ms.`,
    );
  });

  test('an explicit reelect window is still honoured', async () => {
    await runProxy({
      input: new PassThrough(),
      output: new PassThrough(),
      token: 'token',
      autoReelect: true,
      reelectTimeoutMs: 600,
    });
    state.closeHandlers[0]?.('remote');
    await vi.advanceTimersByTimeAsync(DEFAULT_REELECT_INTERVAL_MS);
    expect(logged).toContain(
      '[browser-link proxy] Primary closed (remote); reelect window opened for 600ms.',
    );
  });

  /** Start a proxy, drop its primary, and resolve with how long after the
   * drop the reelect window was given up. */
  async function giveUpAfter(reelectTimeoutMs?: number): Promise<number> {
    let exhaustedAt: number | null = null;
    await runProxy({
      input: new PassThrough(),
      output: new PassThrough(),
      token: 'token',
      autoReelect: true,
      ...(reelectTimeoutMs === undefined ? {} : { reelectTimeoutMs }),
      onReelectExhausted: () => {
        exhaustedAt = Date.now();
      },
    });
    const droppedAt = Date.now();
    state.closeHandlers[0]?.('remote');
    for (let waited = 0; exhaustedAt === null && waited < 120_000; waited += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    if (exhaustedAt === null) throw new Error('the reelect window never ended');
    return exhaustedAt - droppedAt;
  }

  test('a primary that never answers the hello: the default window ends on time', async () => {
    state.reconnect = 'silent';
    // The port refuses at once until just before the window ends, so the
    // last attempt starts with little of the window left.
    state.refuseUntil = Date.now() + DEFAULT_REELECT_TIMEOUT_MS - 300;
    expect(await giveUpAfter()).toBeLessThanOrEqual(DEFAULT_REELECT_TIMEOUT_MS);
    const last = state.connects[state.connects.length - 1];
    expect(last?.handshakeTimeoutMs).toBeLessThan(RECONNECT_HANDSHAKE_TIMEOUT_MS);
  });

  test('a primary that never answers the hello: a short explicit window ends on time', async () => {
    state.reconnect = 'silent';
    expect(await giveUpAfter(1000)).toBeLessThanOrEqual(1000);
    expect(state.connects.slice(1).map((c) => c?.handshakeTimeoutMs)).toEqual([800]);
  });

  test('an attempt started with the full budget left still gets the full budget', async () => {
    state.reconnect = 'silent';
    expect(await giveUpAfter()).toBeLessThanOrEqual(DEFAULT_REELECT_TIMEOUT_MS);
    // Two attempts, each with the full handshake budget.
    expect(state.connects.slice(1).map((c) => c?.handshakeTimeoutMs)).toEqual([
      RECONNECT_HANDSHAKE_TIMEOUT_MS,
      RECONNECT_HANDSHAKE_TIMEOUT_MS,
    ]);
  });
});
