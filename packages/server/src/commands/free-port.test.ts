import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/* runFreePort talks to the OS via execFileSync (netstat/lsof/tasklist/ps/
 * taskkill) and process.kill. We mock both so the tests exercise every
 * branch of the kill-only-node safety rule deterministically, on any host. */
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: vi.fn(() => actual.platform()) };
});

import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { runFreePort } from './free-port.js';

const exec = vi.mocked(execFileSync);
const plat = vi.mocked(platform);

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
});

afterEach(() => {
  killSpy.mockRestore();
});

/**
 * Returns a stub for execFileSync keyed by the binary name. Each binary
 * either returns a string (success) or throws (command failed / not found).
 */
function withCommands(map: Record<string, string | (() => never)>): void {
  exec.mockImplementation(((cmd: string) => {
    const handler = map[cmd];
    if (handler == null) {
      const err = new Error(`unexpected command: ${cmd}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    if (typeof handler === 'function') return handler();
    return handler;
  }) as never);
}

describe('runFreePort — Unix path', () => {
  beforeEach(() => {
    plat.mockReturnValue('linux');
  });

  test('returns ok + null pid when nothing is listening on the port', () => {
    withCommands({
      lsof: () => {
        const err = new Error('exit 1') as NodeJS.ErrnoException;
        err.code = '1';
        throw err;
      },
    });
    const r = runFreePort('en');
    expect(r).toEqual({
      ok: true,
      pid: null,
      imageName: null,
      message: expect.stringMatching(/already free/),
    });
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('kills a node process holding the port', () => {
    withCommands({
      lsof: '12345\n',
      ps: 'node\n',
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(true);
    expect(r.pid).toBe(12345);
    expect(r.imageName).toBe('node');
    expect(r.message).toMatch(/Stopped browser-link primary \(PID 12345\)/);
    expect(killSpy).toHaveBeenCalledExactlyOnceWith(12345, 'SIGTERM');
  });

  test('refuses to kill a non-node process and returns ok:false', () => {
    withCommands({
      lsof: '9999\n',
      ps: 'caddy\n',
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(false);
    expect(r.pid).toBe(9999);
    expect(r.imageName).toBe('caddy');
    expect(r.message).toMatch(/PID 9999 \(caddy\).*NOT a node process/);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('refuses to kill when the image name cannot be resolved', () => {
    withCommands({
      lsof: '4242\n',
      ps: () => {
        throw new Error('ps failed');
      },
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(false);
    expect(r.pid).toBe(4242);
    expect(r.imageName).toBe(null);
    expect(r.message).toMatch(/could not identify the process/);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('reports kill failure when process.kill throws', () => {
    withCommands({
      lsof: '777\n',
      ps: 'node\n',
    });
    killSpy.mockImplementation(() => {
      throw new Error('EPERM');
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(false);
    expect(r.pid).toBe(777);
    expect(r.imageName).toBe('node');
    expect(r.message).toMatch(/Could not kill PID 777/);
  });

  test('ignores garbage on stdout that is not a valid pid', () => {
    withCommands({ lsof: 'not-a-number\n' });
    const r = runFreePort('en');
    expect(r.pid).toBe(null);
    expect(r.ok).toBe(true);
  });
});

describe('runFreePort — Windows path', () => {
  beforeEach(() => {
    plat.mockReturnValue('win32');
  });

  test('parses netstat output and kills the node owner with taskkill', () => {
    /* Real netstat -ano -p TCP output includes the header + many
     * unrelated lines, plus the target line in the format the parser
     * expects. */
    const netstatOut = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024',
      '  TCP    127.0.0.1:17529        0.0.0.0:0              LISTENING       13212',
      '  TCP    192.168.1.1:443        0.0.0.0:0              LISTENING       4',
    ].join('\r\n');
    const tasklistOut = '"node.exe","13212","Console","1","45,000 K"';
    withCommands({
      netstat: netstatOut,
      tasklist: tasklistOut,
      taskkill: '', // taskkill prints nothing on success
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(true);
    expect(r.pid).toBe(13212);
    expect(r.imageName).toBe('node.exe');
    expect(r.message).toMatch(/Stopped browser-link primary \(PID 13212\)/);
    // process.kill is NOT used on Windows — taskkill is.
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('only matches LISTENING rows (skips ESTABLISHED on the same port)', () => {
    const netstatOut = [
      '  TCP    127.0.0.1:17529        127.0.0.1:55555        ESTABLISHED     11111',
      '  TCP    127.0.0.1:17529        0.0.0.0:0              LISTENING       22222',
    ].join('\r\n');
    withCommands({
      netstat: netstatOut,
      tasklist: '"node.exe","22222","Console","1","45,000 K"',
      taskkill: '',
    });
    const r = runFreePort('en');
    expect(r.pid).toBe(22222);
  });

  test('refuses to taskkill a non-node owner', () => {
    const netstatOut =
      '  TCP    127.0.0.1:17529        0.0.0.0:0              LISTENING       55555';
    withCommands({
      netstat: netstatOut,
      tasklist: '"chrome.exe","55555","Console","1","200,000 K"',
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(false);
    expect(r.imageName).toBe('chrome.exe');
    expect(r.message).toMatch(/PID 55555 \(chrome\.exe\).*NOT a node process/);
  });

  test('handles tasklist "INFO: No tasks" as unknown owner', () => {
    const netstatOut =
      '  TCP    127.0.0.1:17529        0.0.0.0:0              LISTENING       9999';
    withCommands({
      netstat: netstatOut,
      tasklist: 'INFO: No tasks are running which match the specified criteria.',
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(false);
    expect(r.imageName).toBe(null);
  });

  test('reports kill failure when taskkill throws', () => {
    const netstatOut = '  TCP    127.0.0.1:17529        0.0.0.0:0              LISTENING       7';
    withCommands({
      netstat: netstatOut,
      tasklist: '"node.exe","7","Console","1","45,000 K"',
      taskkill: () => {
        throw new Error('access denied');
      },
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Could not kill PID 7/);
  });
});

describe('runFreePort — i18n', () => {
  beforeEach(() => {
    plat.mockReturnValue('linux');
  });

  test('uses English by default', () => {
    withCommands({
      lsof: () => {
        throw new Error();
      },
    });
    const r = runFreePort();
    expect(r.message).toContain('already free');
  });

  test('switches to Spanish (Rioplatense) for es', () => {
    withCommands({
      lsof: () => {
        throw new Error();
      },
    });
    const r = runFreePort('es');
    expect(r.message).toMatch(/ya está libre/);
  });

  test('localises the kill-success message', () => {
    withCommands({
      lsof: '321\n',
      ps: 'node\n',
    });
    const r = runFreePort('es');
    expect(r.message).toMatch(/browser-link primary detenido/);
  });

  test('localises the not-node refusal', () => {
    withCommands({
      lsof: '321\n',
      ps: 'caddy\n',
    });
    const r = runFreePort('es');
    expect(r.message).toMatch(/NO es un proceso node/);
  });
});

describe('isNodeImage — image-name matching (via runFreePort)', () => {
  beforeEach(() => {
    plat.mockReturnValue('linux');
  });

  test.each([
    ['node', true],
    ['nodejs', true],
    ['Node.exe', true], // case-insensitive
    ['NODE.EXE', true],
    ['node-debug', true], // anything that starts with "node"
    ['snode', false],
    ['python', false],
    ['', false],
  ])('image "%s" kills?=%s', (image, shouldKill) => {
    withCommands({
      lsof: '111\n',
      ps: `${image}\n`,
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(shouldKill);
  });
});

/**
 * S2: `stop` kills every live browser-link bridge, not only the 17529 owner.
 * The exec stub here is keyed by binary AND arguments, so each port and the
 * process listing can answer differently.
 */
function withExec(fn: (cmd: string, args: readonly string[]) => string): void {
  exec.mockImplementation(((cmd: string, args: readonly string[]) => fn(cmd, args)) as never);
}

function notFound(): never {
  const err = new Error('exit 1') as NodeJS.ErrnoException;
  err.code = '1';
  throw err;
}

describe('runFreePort — every live browser-link process (Unix)', () => {
  beforeEach(() => {
    plat.mockReturnValue('linux');
  });

  const psList = [
    '  100     1 Mon Nov  9 01:00:00 2026 node /usr/local/bin/browser-link',
    '  200     1 Mon Nov  9 01:00:00 2026 node /usr/local/bin/browser-link',
    '  300     1 Mon Nov  9 01:00:00 2026 node /usr/lib/node_modules/@jobshimo/browser-link/dist/cli.js start',
    '  400     1 Mon Nov  9 01:00:00 2026 node /usr/local/bin/browser-link doctor',
    '  500     1 Mon Nov  9 01:00:00 2026 node /srv/unrelated.js',
    `${process.pid}     1 Mon Nov  9 01:00:00 2026 node /usr/local/bin/browser-link stop`,
  ].join('\n');

  test('kills the port owner, the 17530 owner and every other bridge; never non-bridge commands', () => {
    withExec((cmd, args) => {
      if (cmd === 'lsof' && args.includes('-iTCP:17529')) return '100\n';
      if (cmd === 'lsof' && args.includes('-iTCP:17530')) return '200\n';
      if (cmd === 'ps' && args[0] === '-axo') return psList;
      if (cmd === 'ps' && args[0] === '-p') return 'node\n';
      return notFound();
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(true);
    expect(r.pid).toBe(100);
    expect(r.message.split('\n')[0]).toMatch(/Stopped browser-link primary \(PID 100\)/);
    expect(r.message).toMatch(/PID 200 {2}node browser-link {2}✓ stopped/);
    expect(r.message).toMatch(/PID 300 {2}node browser-link start {2}✓ stopped/);
    expect(r.message).not.toMatch(/PID 400|PID 500/);
    expect(killSpy.mock.calls).toEqual([
      [100, 'SIGTERM'],
      [200, 'SIGTERM'],
      [300, 'SIGTERM'],
    ]);
    expect(r.processes).toEqual([
      { pid: 100, command: 'node browser-link', stopped: true },
      { pid: 200, command: 'node browser-link', stopped: true },
      { pid: 300, command: 'node browser-link start', stopped: true },
    ]);
  });

  test('a stray bridge is stopped even when the port is already free', () => {
    withExec((cmd, args) => {
      if (cmd === 'ps' && args[0] === '-axo') return psList.split('\n')[2];
      if (cmd === 'ps' && args[0] === '-p') return 'node\n';
      return notFound();
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(true);
    expect(r.pid).toBeNull();
    expect(r.message.split('\n')[0]).toMatch(/already free/);
    expect(r.message).toMatch(/Other browser-link processes:/);
    expect(r.message).toMatch(/PID 300 {2}node browser-link start {2}✓ stopped/);
    expect(killSpy).toHaveBeenCalledExactlyOnceWith(300, 'SIGTERM');
  });

  test('a bridge that cannot be killed makes the result not ok', () => {
    withExec((cmd, args) => {
      if (cmd === 'ps' && args[0] === '-axo') return psList.split('\n')[1];
      return notFound();
    });
    killSpy.mockImplementation(() => {
      throw new Error('EPERM');
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/PID 200 {2}node browser-link {2}✗ could not stop/);
  });

  test('localises the process lines', () => {
    withExec((cmd, args) => {
      if (cmd === 'ps' && args[0] === '-axo') return psList.split('\n')[1];
      return notFound();
    });
    const r = runFreePort('es');
    expect(r.message).toMatch(/Otros procesos de browser-link:/);
    expect(r.message).toMatch(/PID 200 {2}node browser-link {2}✓ detenido/);
  });

  test('a 17530 owner that is not node is left alone', () => {
    withExec((cmd, args) => {
      if (cmd === 'lsof' && args.includes('-iTCP:17530')) return '600\n';
      if (cmd === 'ps' && args[0] === '-p') return 'caddy\n';
      return notFound();
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    expect(r.processes).toBeUndefined();
  });
});

describe('runFreePort — every live browser-link process (Windows)', () => {
  beforeEach(() => {
    plat.mockReturnValue('win32');
  });

  test('lists with Get-CimInstance and stops each bridge with taskkill', () => {
    const commandLine = String.raw`"C:\nodejs\node.exe" "C:\nodejs\node_modules\@jobshimo\browser-link\dist\cli.js"`;
    const list = JSON.stringify([
      {
        ProcessId: 13212,
        ParentProcessId: 1,
        CreationDate: '/Date(1794190664124)/',
        CommandLine: commandLine,
      },
      {
        ProcessId: 45544,
        ParentProcessId: 1,
        CreationDate: '/Date(1794190664124)/',
        CommandLine: commandLine,
      },
    ]);
    const killed: string[] = [];
    withExec((cmd, args) => {
      if (cmd === 'netstat')
        return '  TCP    127.0.0.1:17529        0.0.0.0:0              LISTENING       13212';
      if (cmd === 'tasklist') return '"node.exe","13212","Console","1","45,000 K"';
      if (cmd === 'powershell') return list;
      if (cmd === 'taskkill') {
        killed.push(args.join(' '));
        return '';
      }
      return notFound();
    });
    const r = runFreePort('en');
    expect(r.ok).toBe(true);
    expect(killed).toEqual(['/F /PID 13212', '/F /PID 45544']);
    expect(r.message).toMatch(/PID 45544 {2}node browser-link {2}✓ stopped/);
    expect(r.processes?.map((p) => p.pid)).toEqual([13212, 45544]);
  });
});
