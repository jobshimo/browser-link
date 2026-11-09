import { describe, expect, test, vi } from 'vitest';
import { answerRepairRequest, createRepairController, type RepairDeps } from './repair.js';
import type { ServerToExtension } from '../messages.js';

/* S4 server side: answer first, then spawn the installed CLI detached,
 * terminate every extension socket, stop IPC and exit 0, in that order.
 * Everything is injected: nothing is spawned, terminated or exited here. */

/** A child process stand-in that emits `spawn` (started) or `error`
 * (async spawn failure) on the next tick, like Node's ChildProcess. */
function fakeChild(
  outcome: 'spawn' | Error,
  order: string[] = [],
): ReturnType<RepairDeps['spawn']> & { emitError: (err: Error) => void } {
  const listeners: Record<string, ((err?: Error) => void)[]> = { spawn: [], error: [] };
  setTimeout(() => {
    if (outcome === 'spawn') for (const l of listeners.spawn) l();
    else for (const l of listeners.error) l(outcome);
  }, 0);
  return {
    unref: () => {
      order.push('unref');
    },
    on(event: 'spawn' | 'error', listener: (err?: Error) => void) {
      listeners[event].push(listener);
      return this;
    },
    emitError(err: Error) {
      if (listeners.error.length === 0) throw err;
      for (const l of listeners.error) l(err);
    },
  };
}

function fakeDeps(): { deps: RepairDeps; order: string[] } {
  const order: string[] = [];
  const deps: RepairDeps = {
    execPath: '/usr/bin/node',
    cliPath: '/usr/lib/node_modules/@jobshimo/browser-link/dist/cli.js',
    delay: vi.fn(() => {
      order.push('delay');
      return Promise.resolve();
    }),
    spawn: vi.fn(() => {
      order.push('spawn');
      return fakeChild('spawn', order);
    }),
    terminateSockets: vi.fn(() => {
      order.push('terminate');
    }),
    stopIpc: vi.fn(() => {
      order.push('stop-ipc');
      return Promise.resolve();
    }),
    exit: vi.fn(() => {
      order.push('exit');
    }),
  };
  return { deps, order };
}

describe('answerRepairRequest', () => {
  test('acks ok:true action:restarting BEFORE starting the repair', () => {
    const events: string[] = [];
    const sent: ServerToExtension[] = [];
    answerRepairRequest(
      { kind: 'bridge.repair', request_id: 'r1' },
      (m) => {
        events.push('send');
        sent.push(m);
      },
      () => {
        events.push('repair');
        return true;
      },
    );
    expect(sent).toEqual([
      { kind: 'bridge.repair.result', request_id: 'r1', ok: true, action: 'restarting' },
    ]);
    expect(events).toEqual(['send', 'repair']);
  });

  test('answers ok:false when this process cannot repair', () => {
    const sent: ServerToExtension[] = [];
    answerRepairRequest(
      { kind: 'bridge.repair', request_id: 'r2' },
      (m) => sent.push(m),
      undefined,
    );
    expect(sent).toEqual([
      {
        kind: 'bridge.repair.result',
        request_id: 'r2',
        ok: false,
        error: expect.stringMatching(/not available/),
      },
    ]);
  });
});

describe('createRepairController', () => {
  test('spawns the installed CLI detached, then terminates sockets, stops IPC, exits 0', async () => {
    const { deps, order } = fakeDeps();
    const repair = createRepairController(deps);
    expect(repair.start()).toBe(true);
    await repair.done;
    expect(order).toEqual(['delay', 'spawn', 'unref', 'terminate', 'stop-ipc', 'exit']);
    expect(deps.spawn).toHaveBeenCalledWith('/usr/bin/node', [deps.cliPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  test('a second request while restarting starts nothing new', async () => {
    const { deps } = fakeDeps();
    const repair = createRepairController(deps);
    repair.start();
    repair.start();
    await repair.done;
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  test('a spawn failure keeps this server running (no terminate, no exit)', async () => {
    const { deps } = fakeDeps();
    deps.spawn = () => {
      throw new Error('ENOENT');
    };
    const repair = createRepairController(deps);
    repair.start();
    await repair.done;
    expect(deps.terminateSockets).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  test('an IPC stop failure still exits 0', async () => {
    const { deps } = fakeDeps();
    deps.stopIpc = () => Promise.reject(new Error('already closed'));
    const repair = createRepairController(deps);
    repair.start();
    await repair.done;
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});

describe('createRepairController: asynchronous spawn failure (A1)', () => {
  test('an error emitted after spawn() returned keeps this server running and is logged', async () => {
    const { deps } = fakeDeps();
    const log = vi.fn();
    deps.log = log;
    deps.spawn = () => fakeChild(new Error('spawn EACCES'));
    const repair = createRepairController(deps);
    repair.start();
    expect(repair.inProgress).toBe(true);
    await repair.done;
    expect(deps.terminateSockets).not.toHaveBeenCalled();
    expect(deps.stopIpc).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(repair.inProgress).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/spawn EACCES.*still serving/));
  });

  test('a late error after the hand-off started never throws (a listener stays attached)', async () => {
    const { deps } = fakeDeps();
    const child = fakeChild('spawn');
    deps.spawn = () => child;
    const repair = createRepairController(deps);
    repair.start();
    await repair.done;
    expect(() => child.emitError(new Error('late'))).not.toThrow();
  });

  test('inProgress is true from start until the process exits', async () => {
    const { deps } = fakeDeps();
    const seen: boolean[] = [];
    const repair = createRepairController(deps);
    deps.terminateSockets = () => seen.push(repair.inProgress);
    expect(repair.inProgress).toBe(false);
    repair.start();
    await repair.done;
    expect(seen).toEqual([true]);
  });
});
