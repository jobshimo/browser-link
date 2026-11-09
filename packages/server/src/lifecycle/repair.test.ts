import { describe, expect, test, vi } from 'vitest';
import { answerRepairRequest, createRepairController, type RepairDeps } from './repair.js';
import type { ServerToExtension } from '../messages.js';

/* S4 server side: answer first, then spawn the installed CLI detached,
 * terminate every extension socket, stop IPC and exit 0, in that order.
 * Everything is injected: nothing is spawned, terminated or exited here. */

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
      return {
        unref: () => {
          order.push('unref');
        },
      };
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
