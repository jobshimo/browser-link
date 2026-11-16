import { afterEach, describe, expect, test, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocketServer } from 'ws';
import {
  decideElection,
  probeVersion,
  retryBind,
  runElection,
  stepDownProcess,
  shutdownOnSignal,
  SHUTDOWN_IPC_DEADLINE_MS,
  STEP_DOWN_GRACE_MS,
  type ElectionDeps,
  type VersionProbe,
} from './election.js';
import { isAddrInUse, startWsBridge } from '../bridge/ws-bridge.js';
import { BridgeEventLog } from '../bridge/events.js';
import type { PortHolder } from './port-holder.js';

/* Version-aware primary election (S1). Pure decision + injected effects:
 * no test here kills a process, and every bridge binds port 0. */

const running: WebSocketServer[] = [];
const plain: Server[] = [];

afterEach(async () => {
  await Promise.all(
    plain.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
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

/** The OS says `pid` holds the bridge port and is a browser-link server. */
function verified(pid: number): () => Promise<PortHolder> {
  return () =>
    Promise.resolve({
      kind: 'process',
      process: { pid, imageName: 'node', command: 'node /usr/local/bin/browser-link' },
      isBrowserLink: true,
    });
}

function deps(overrides: Partial<ElectionDeps>): ElectionDeps {
  return {
    localVersion: '0.41.0',
    probe: () => Promise.resolve({ kind: 'unreachable' }),
    // Conservative default: the OS could not be asked.
    inspectHolder: () => Promise.resolve({ kind: 'unknown', reason: 'command-missing' }),
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
      deps({
        localVersion: '0.41.0',
        probe: () => probeVersion(port),
        inspectHolder: verified(process.pid),
        stepDown,
      }),
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
        inspectHolder: verified(4242),
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
        inspectHolder: verified(4242),
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
        inspectHolder: verified(77),
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

  /** A plain HTTP server on port 0 that answers `/version` with `body`. */
  async function serveBody(body: object): Promise<number> {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    plain.push(server);
    return (server.address() as AddressInfo).port;
  }

  const OLD_BODY = {
    name: '@jobshimo/browser-link',
    version: '1.0.2',
    pid: 4242,
    startedAt: '2026-11-16T00:00:00.000Z',
    installedVersion: '1.0.2',
  };

  test('an older primary that sends no sessions is accepted exactly as before', async () => {
    const probe = await probeVersion(await serveBody(OLD_BODY));
    expect(probe).toEqual({ kind: 'version', info: OLD_BODY });
  });

  test('sessions is read when it is a non-negative integer', async () => {
    for (const sessions of [0, 1, 7]) {
      const probe = await probeVersion(await serveBody({ ...OLD_BODY, sessions }));
      expect(probe).toEqual({ kind: 'version', info: { ...OLD_BODY, sessions } });
    }
  });

  test('a sessions value that is not a non-negative integer drops the field, not the body', async () => {
    for (const sessions of [-1, 1.5, '3', null, true, {}, [2]]) {
      const probe = await probeVersion(await serveBody({ ...OLD_BODY, sessions }));
      expect(probe).toEqual({ kind: 'version', info: OLD_BODY });
    }
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
    await stepDownProcess(4242, {
      // Deterministic guard: never compare against the real test runner pids.
      selfPid: 1,
      listProcesses: () => [],
      os: 'win32',
      execFile,
      kill,
    });
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/F'], {
      timeout: expect.any(Number),
    });
    expect(kill).not.toHaveBeenCalled();
  });

  test('Unix: SIGTERM, and no SIGKILL when the process exits in time', async () => {
    const kill = vi.fn();
    let alive = true;
    await stepDownProcess(4242, {
      // Deterministic guard: never compare against the real test runner pids.
      selfPid: 1,
      listProcesses: () => [],
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
      // Deterministic guard: never compare against the real test runner pids.
      selfPid: 1,
      listProcesses: () => [],
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

describe('stepDownProcess never stops itself or an ancestor (A3)', () => {
  const list = [
    { pid: 10, ppid: 1, startedAt: null, command: 'shell' },
    { pid: 20, ppid: 10, startedAt: null, command: 'client' },
    { pid: 30, ppid: 20, startedAt: null, command: 'node cli.js' },
    { pid: 40, ppid: 1, startedAt: null, command: 'node cli.js' },
  ];

  test.each([30, 20, 10])('refuses PID %i (self or ancestor) and kills nothing', async (pid) => {
    const execFile = vi.fn(() => '');
    const kill = vi.fn();
    await expect(
      stepDownProcess(pid, {
        os: 'win32',
        execFile,
        kill,
        selfPid: 30,
        listProcesses: () => list,
      }),
    ).rejects.toThrow(/this process or one of its ancestors/);
    expect(execFile).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  test('an unrelated PID is still stepped down', async () => {
    const execFile = vi.fn(() => '');
    await stepDownProcess(40, { os: 'win32', execFile, selfPid: 30, listProcesses: () => list });
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/PID', '40', '/F'], {
      timeout: expect.any(Number),
    });
  });

  test('defaults to the real process.pid', async () => {
    const execFile = vi.fn(() => '');
    await expect(
      stepDownProcess(process.pid, { os: 'win32', execFile, listProcesses: () => [] }),
    ).rejects.toThrow(/this process/);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('a primary in the middle of a repair hand-off (A1)', () => {
  const sameVersionRepairing: VersionProbe = {
    kind: 'version',
    info: {
      name: '@jobshimo/browser-link',
      version: '0.41.0',
      pid: 77,
      startedAt: '2026-11-09T00:00:00.000Z',
      installedVersion: '0.41.0',
      repairing: true,
    },
  };
  const base = { ownerPid: null, ownerStartedAt: null, installedCodeMtime: null };

  test('same version and repairing: await the hand-off instead of defer', () => {
    const outcome = decideElection({ ...base, local: '0.41.0', probe: sameVersionRepairing });
    expect(outcome).toMatchObject({ decision: 'await-handoff', pid: 77 });
  });

  test('runElection never steps a repairing primary down', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({
        localVersion: '0.41.0',
        probe: () => Promise.resolve(sameVersionRepairing),
        stepDown,
      }),
    );
    expect(outcome.decision).toBe('await-handoff');
    expect(stepDown).not.toHaveBeenCalled();
  });

  test('a newer repairing primary is still deferred to; a same-version idle one too', () => {
    expect(decideElection({ ...base, local: '0.40.0', probe: sameVersionRepairing }).decision).toBe(
      'defer',
    );
    const idle: VersionProbe = {
      kind: 'version',
      info: { ...sameVersionRepairing.info, repairing: false },
    };
    expect(decideElection({ ...base, local: '0.41.0', probe: idle }).decision).toBe('defer');
  });

  test('probeVersion reads repairing from a live bridge', async () => {
    const wss = await startWsBridge(new Map(), new Map(), new BridgeEventLog(), {
      port: 0,
      version: '0.41.0',
      isRepairing: () => true,
    });
    running.push(wss);
    const probe = await probeVersion((wss.address() as AddressInfo).port);
    expect(probe.kind === 'version' && probe.info.repairing).toBe(true);
  });
});

describe('shutdownOnSignal awaits the IPC server before exiting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('exit waits until the IPC server has closed', async () => {
    vi.useFakeTimers();
    let closeIpc: () => void = () => undefined;
    const order: string[] = [];
    const done = shutdownOnSignal({
      stopIpc: () =>
        new Promise<void>((resolve) => (closeIpc = resolve)).then(() => {
          order.push('ipc-closed');
        }),
      closeDb: () => order.push('db-closed'),
      exit: (code) => order.push(`exit:${code}`),
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual([]);
    closeIpc();
    await done;
    expect(order).toEqual(['ipc-closed', 'db-closed', 'exit:0']);
  });

  test('an IPC close that never resolves is abandoned at the deadline', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const done = shutdownOnSignal({
      stopIpc: () => new Promise<void>(() => undefined),
      closeDb: () => undefined,
      exit,
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_IPC_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(exit).toHaveBeenCalledWith(0);
    // The deadline stays inside the Unix step-down grace, so a SIGTERM'd
    // primary finishes before the SIGKILL that would follow.
    expect(SHUTDOWN_IPC_DEADLINE_MS).toBeLessThan(STEP_DOWN_GRACE_MS);
  });

  test('without an IPC server (multi-agent off) it exits 0 at once, as before', async () => {
    const order: string[] = [];
    await shutdownOnSignal({
      stopIpc: null,
      closeDb: () => order.push('db-closed'),
      exit: (code) => order.push(`exit:${code}`),
    });
    expect(order).toEqual(['db-closed', 'exit:0']);
  });

  test('a rejecting IPC close still exits 0', async () => {
    const exit = vi.fn();
    await shutdownOnSignal({
      stopIpc: () => Promise.reject(new Error('boom')),
      closeDb: () => undefined,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});

/* Owner decision D14: the take-over kills only a process the operating
 * system shows holding the port and running browser-link. The pid in the
 * holder's own /version body is a claim, compared and never trusted. */
describe('take-over kills only an OS-verified browser-link holder (D14)', () => {
  const olderPrimary =
    (pid: number): (() => Promise<VersionProbe>) =>
    () =>
      Promise.resolve({
        kind: 'version',
        info: {
          name: '@jobshimo/browser-link',
          version: '0.40.0',
          pid,
          startedAt: '2026-11-09T00:00:00.000Z',
          installedVersion: '0.40.0',
        },
      });
  const holder = (pid: number, imageName: string | null, isBrowserLink: boolean) => () =>
    Promise.resolve<PortHolder>({
      kind: 'process',
      process: { pid, imageName, command: 'node /srv/other.js' },
      isBrowserLink,
    });

  test('verified holder that runs browser-link → stepped down exactly once, as before', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({ probe: olderPrimary(111), inspectHolder: verified(111), stepDown }),
    );
    expect(outcome).toEqual({
      decision: 'take-over',
      pid: 111,
      reason: 'running primary 0.40.0 is older than 0.41.0',
    });
    expect(stepDown.mock.calls).toEqual([[111]]);
  });

  test('/version says PID 111 but the OS says PID 222 holds the port → nothing killed, holder named', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({ probe: olderPrimary(111), inspectHolder: holder(222, 'python.exe', false), stepDown }),
    );
    expect(stepDown.mock.calls).toEqual([]);
    expect(outcome).toEqual({
      decision: 'defer',
      pid: 111,
      reason:
        'take-over refused: the server answering on 127.0.0.1:17529 says it is PID 111, but the ' +
        'operating system says PID 222 (python.exe) holds the port. Nothing was stopped. ' +
        'To stop it: browser-link stop --pid 222',
    });
  });

  test('a mismatch is refused even when the real holder is a browser-link', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({ probe: olderPrimary(111), inspectHolder: verified(222), stepDown }),
    );
    expect(stepDown.mock.calls).toEqual([]);
    expect(outcome.decision).toBe('defer');
    expect(outcome.reason).toContain('browser-link stop --pid 222');
  });

  test.each([
    ['timeout', 'the lookup timed out'],
    ['command-missing', 'the lookup tool (netstat or lsof) is not installed'],
  ] as const)('the OS lookup fails (%s) → nothing killed, said so', async (reason, text) => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({
        probe: olderPrimary(111),
        inspectHolder: () => Promise.resolve({ kind: 'unknown', reason }),
        stepDown,
      }),
    );
    expect(stepDown.mock.calls).toEqual([]);
    expect(outcome).toEqual({
      decision: 'defer',
      pid: 111,
      reason:
        'take-over refused: could not verify through the operating system which process holds ' +
        `127.0.0.1:17529 (${text}). The server answering there says it is PID 111, unverified. ` +
        'Nothing was stopped. Run `browser-link stop` to look again.',
    });
  });

  test('the holder is the pid it claims but not a browser-link → nothing killed, named with the command', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({ probe: olderPrimary(111), inspectHolder: holder(111, 'node.exe', false), stepDown }),
    );
    expect(stepDown.mock.calls).toEqual([]);
    expect(outcome.reason).toBe(
      'take-over refused: PID 111 (node.exe) holds 127.0.0.1:17529, but the operating system ' +
        'does not show it as a browser-link server. Nothing was stopped. ' +
        'To stop it: browser-link stop --pid 111',
    );
  });

  test('an unnamed holder is refused with "name unknown"', async () => {
    const outcome = await runElection(
      deps({ probe: olderPrimary(5), inspectHolder: holder(5, null, false) }),
    );
    expect(outcome.reason).toContain('PID 5 (name unknown)');
  });

  test('the OS lists nobody on the port any more → nothing killed', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({
        probe: olderPrimary(111),
        inspectHolder: () => Promise.resolve({ kind: 'free' }),
        stepDown,
      }),
    );
    expect(stepDown.mock.calls).toEqual([]);
    expect(outcome.decision).toBe('defer');
    expect(outcome.reason).toMatch(/lists no process listening on 127\.0\.0\.1:17529/);
  });

  test('a primary without /version that is not a browser-link is not taken over', async () => {
    const stepDown = vi.fn(() => Promise.resolve());
    const outcome = await runElection(
      deps({
        probe: () => Promise.resolve({ kind: 'no-endpoint' }),
        inspectHolder: holder(4242, 'node', false),
        processStartTime: () => 1_000,
        installedCodeMtime: () => 2_000,
        stepDown,
      }),
    );
    expect(stepDown.mock.calls).toEqual([]);
    expect(outcome.decision).toBe('defer');
    expect(outcome.reason).toContain('browser-link stop --pid 4242');
  });

  test('a deferring election never asks the OS who holds the port when it has no use for it', async () => {
    const inspectHolder = vi.fn(verified(1));
    await runElection(
      deps({ probe: () => Promise.resolve({ kind: 'unreachable' }), inspectHolder }),
    );
    expect(inspectHolder).not.toHaveBeenCalled();
  });
});

describe('pre-release versions in the election', () => {
  test('a starting pre-release does not take over a stable primary of the same number', () => {
    const outcome = decideElection({
      local: '1.1.0-rc.1',
      probe: {
        kind: 'version',
        info: {
          name: 'browser-link',
          version: '1.1.0',
          pid: 4242,
          startedAt: '2026-11-16T00:00:00.000Z',
          installedVersion: null,
        },
      },
      ownerPid: null,
      ownerStartedAt: null,
      installedCodeMtime: null,
    });
    expect(outcome.decision).toBe('defer');
  });

  test('a stable start takes over a running pre-release of the same number', () => {
    const outcome = decideElection({
      local: '1.1.0',
      probe: {
        kind: 'version',
        info: {
          name: 'browser-link',
          version: '1.1.0-rc.1',
          pid: 4242,
          startedAt: '2026-11-16T00:00:00.000Z',
          installedVersion: null,
        },
      },
      ownerPid: null,
      ownerStartedAt: null,
      installedCodeMtime: null,
    });
    expect(outcome.decision).toBe('take-over');
  });
});
