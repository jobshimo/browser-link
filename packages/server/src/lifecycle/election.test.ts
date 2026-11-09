import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { WebSocketServer } from 'ws';
import {
  decideElection,
  probeVersion,
  retryBind,
  runElection,
  stepDownProcess,
  type ElectionDeps,
  type VersionProbe,
} from './election.js';
import { isAddrInUse, startWsBridge } from '../bridge/ws-bridge.js';
import { BridgeEventLog } from '../bridge/events.js';

/* Version-aware primary election (S1). Pure decision + injected effects:
 * no test here kills a process, and every bridge binds port 0. */

const running: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map((wss) => new Promise<void>((resolve) => wss.close(() => resolve()))),
  );
});

async function startBridge(version: string): Promise<number> {
  const wss = await startWsBridge(new Map(), new Map(), new BridgeEventLog(), {
    port: 0,
    version,
  });
  running.push(wss);
  return (wss.address() as AddressInfo).port;
}

function deps(overrides: Partial<ElectionDeps>): ElectionDeps {
  return {
    localVersion: '0.41.0',
    probe: () => Promise.resolve({ kind: 'unreachable' }),
    findOwnerPid: () => null,
    processStartTime: () => null,
    installedCodeMtime: () => null,
    stepDown: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('old and new primaries: the new one wins', () => {
  test('an old 0.40.0 primary is stepped down by a starting 0.41.0', async () => {
    const port = await startBridge('0.40.0');
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({ localVersion: '0.41.0', probe: () => probeVersion(port), stepDown }),
    );
    expect(outcome.decision).toBe('take-over');
    expect(outcome.pid).toBe(process.pid);
    expect(stepDown).toHaveBeenCalledExactlyOnceWith(process.pid);
  });

  test('mirror: a starting 0.40.0 defers to a running 0.41.0', async () => {
    const port = await startBridge('0.41.0');
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({ localVersion: '0.40.0', probe: () => probeVersion(port), stepDown }),
    );
    expect(outcome.decision).toBe('defer');
    expect(stepDown).not.toHaveBeenCalled();
  });

  test('a second bridge on a taken port still rejects with the AddrInUse sentinel', async () => {
    const port = await startBridge('0.41.0');
    const err: unknown = await startWsBridge(new Map(), new Map(), new BridgeEventLog(), {
      port,
      version: '0.41.0',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isAddrInUse(err)).toBe(true);
  });

  test('same version defers (the existing proxy / error path)', async () => {
    const port = await startBridge('0.41.0');
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({ localVersion: '0.41.0', probe: () => probeVersion(port), stepDown }),
    );
    expect(outcome.decision).toBe('defer');
    expect(stepDown).not.toHaveBeenCalled();
  });
});

describe('primary without /version (older than 0.41.0): stale start time', () => {
  const noEndpoint: VersionProbe = { kind: 'no-endpoint' };

  test('owner started before the installed code was written → take over', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({
        probe: () => Promise.resolve(noEndpoint),
        findOwnerPid: () => 4242,
        processStartTime: (pid) => (pid === 4242 ? 1_000 : null),
        installedCodeMtime: () => 2_000,
        stepDown,
      }),
    );
    expect(outcome).toMatchObject({ decision: 'take-over', pid: 4242 });
    expect(stepDown).toHaveBeenCalledExactlyOnceWith(4242);
  });

  test('owner started after the installed code was written → defer', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({
        probe: () => Promise.resolve(noEndpoint),
        findOwnerPid: () => 4242,
        processStartTime: () => 3_000,
        installedCodeMtime: () => 2_000,
        stepDown,
      }),
    );
    expect(outcome.decision).toBe('defer');
    expect(stepDown).not.toHaveBeenCalled();
  });

  test('unknown owner, start time or mtime → defer', () => {
    const base = { local: '0.41.0', probe: noEndpoint };
    expect(
      decideElection({ ...base, ownerPid: null, ownerStartedAt: 1, installedCodeMtime: 2 }),
    ).toMatchObject({ decision: 'defer' });
    expect(
      decideElection({ ...base, ownerPid: 9, ownerStartedAt: null, installedCodeMtime: 2 }),
    ).toMatchObject({ decision: 'defer' });
    expect(
      decideElection({ ...base, ownerPid: 9, ownerStartedAt: 1, installedCodeMtime: null }),
    ).toMatchObject({ decision: 'defer' });
  });
});

describe('decideElection', () => {
  test('an unreachable port holder is never taken over', () => {
    expect(
      decideElection({
        local: '9.9.9',
        probe: { kind: 'unreachable' },
        ownerPid: 1,
        ownerStartedAt: 1,
        installedCodeMtime: 2,
      }),
    ).toMatchObject({ decision: 'defer' });
  });

  test('a step-down failure falls back to defer', async () => {
    const outcome = await runElection(
      deps({
        probe: () =>
          Promise.resolve({
            kind: 'version',
            info: {
              name: '@jobshimo/browser-link',
              version: '0.40.0',
              pid: 77,
              startedAt: '2026-11-09T00:00:00.000Z',
              installedVersion: '0.41.0',
            },
          }),
        stepDown: () => Promise.reject(new Error('access denied')),
      }),
    );
    expect(outcome.decision).toBe('defer');
    expect(outcome.reason).toMatch(/access denied/);
  });
});

describe('probeVersion', () => {
  test('reads name, version, pid, startedAt and installedVersion from /version', async () => {
    const port = await startBridge('0.40.0');
    const probe = await probeVersion(port);
    expect(probe.kind).toBe('version');
    if (probe.kind !== 'version') return;
    expect(probe.info).toMatchObject({
      name: '@jobshimo/browser-link',
      version: '0.40.0',
      pid: process.pid,
    });
    expect(Number.isFinite(Date.parse(probe.info.startedAt))).toBe(true);
  });

  test('nothing listening → unreachable', async () => {
    const port = await startBridge('0.40.0');
    await new Promise<void>((resolve) => running.pop()?.close(() => resolve()));
    expect(await probeVersion(port, 300)).toEqual({ kind: 'unreachable' });
  });
});

describe('retryBind', () => {
  const inUse = (e: unknown) => e instanceof Error && e.message === 'in use';

  test('retries a busy bind and resolves once it succeeds', async () => {
    let calls = 0;
    const sleep = vi.fn(() => Promise.resolve());
    const value = await retryBind(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error('in use')) : Promise.resolve('bound');
      },
      { attempts: 25, delayMs: 200, isRetryable: inUse, sleep },
    );
    expect(value).toBe('bound');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  test('gives up after the attempt budget with the last error', async () => {
    let calls = 0;
    await expect(
      retryBind(
        () => {
          calls += 1;
          return Promise.reject(new Error('in use'));
        },
        { attempts: 4, delayMs: 1, isRetryable: inUse, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow('in use');
    expect(calls).toBe(4);
  });

  test('a non-retryable error is thrown at once', async () => {
    let calls = 0;
    await expect(
      retryBind(
        () => {
          calls += 1;
          return Promise.reject(new Error('EACCES'));
        },
        { attempts: 4, delayMs: 1, isRetryable: inUse, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow('EACCES');
    expect(calls).toBe(1);
  });
});

describe('stepDownProcess', () => {
  test('Windows: taskkill /PID n /F', async () => {
    const execFile = vi.fn(() => '');
    const kill = vi.fn();
    await stepDownProcess(4242, { os: 'win32', execFile, kill });
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/F'], {
      timeout: expect.any(Number),
    });
    expect(kill).not.toHaveBeenCalled();
  });

  test('Unix: SIGTERM, and no SIGKILL when the process exits in time', async () => {
    const kill = vi.fn();
    let alive = true;
    await stepDownProcess(4242, {
      os: 'linux',
      kill,
      isAlive: () => {
        const was = alive;
        alive = false;
        return was;
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    expect(kill.mock.calls).toEqual([[4242, 'SIGTERM']]);
  });

  test('Unix: SIGKILL after 3 s when SIGTERM is ignored', async () => {
    const kill = vi.fn();
    let clock = 0;
    await stepDownProcess(4242, {
      os: 'darwin',
      kill,
      isAlive: () => true,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    });
    expect(kill.mock.calls).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL'],
    ]);
    expect(clock).toBeGreaterThanOrEqual(3000);
  });
});
