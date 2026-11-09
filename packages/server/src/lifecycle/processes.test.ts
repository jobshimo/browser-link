import { describe, expect, test, vi } from 'vitest';
import {
  findBridgeProcesses,
  listBridgeProcesses,
  matchBrowserLinkCommand,
  parseProcessTime,
  parseUnixProcessList,
  parseWindowsProcessList,
  readProcessStartTime,
  shortCommand,
  type ExecFileLike,
  type ProcessEntry,
} from './processes.js';

/* Process enumeration for `browser-link stop`, `doctor` and the election.
 * Every OS call goes through an injected ExecFileLike, so nothing here
 * spawns PowerShell or ps, and nothing is ever killed. */

const NODE_WIN = '"C:\\nvm4w\\nodejs\\\\node.exe"';
const CLI_WIN = '"C:\\nvm4w\\nodejs\\\\node_modules\\@jobshimo\\browser-link\\dist\\cli.js"';

describe('parseProcessTime', () => {
  test('reads the PowerShell 5.1 JSON date form /Date(ms)/', () => {
    expect(parseProcessTime('/Date(1793846675959)/')).toBe(1793846675959);
  });

  test('reads an ISO timestamp (PowerShell 7 JSON, ToString("o"))', () => {
    expect(parseProcessTime('2026-11-09T02:17:44.1241560Z')).toBe(
      Date.parse('2026-11-09T02:17:44.124Z'),
    );
  });

  test('reads a WMI datetime yyyyMMddHHmmss.ffffff±UUU (offset in minutes)', () => {
    // 03:17:44 at UTC+60 minutes is 02:17:44 UTC.
    expect(parseProcessTime('20261109031744.124156+060')).toBe(
      Date.parse('2026-11-09T02:17:44.124Z'),
    );
  });

  test('reads a ps lstart value', () => {
    expect(parseProcessTime('Mon Nov  9 02:17:44 2026')).toBe(
      new Date(2026, 10, 9, 2, 17, 44).getTime(),
    );
  });

  test('returns null for garbage and empty input', () => {
    expect(parseProcessTime('')).toBeNull();
    expect(parseProcessTime('not a date')).toBeNull();
  });
});

describe('parseWindowsProcessList', () => {
  test('parses the ConvertTo-Json array, tolerating a null CommandLine', () => {
    const json = JSON.stringify([
      {
        ProcessId: 51044,
        ParentProcessId: 33464,
        CreationDate: '/Date(1794190664124)/',
        CommandLine: `${NODE_WIN}   ${CLI_WIN} `,
      },
      { ProcessId: 4, ParentProcessId: 0, CreationDate: null, CommandLine: null },
    ]);
    expect(parseWindowsProcessList(json)).toEqual([
      { pid: 51044, ppid: 33464, startedAt: 1794190664124, command: `${NODE_WIN}   ${CLI_WIN}` },
      { pid: 4, ppid: 0, startedAt: null, command: '' },
    ]);
  });

  test('accepts the single-object form ConvertTo-Json emits for one process', () => {
    const json = JSON.stringify({
      ProcessId: 7,
      ParentProcessId: 1,
      CreationDate: '2026-11-09T02:17:44Z',
      CommandLine: 'node x.js',
    });
    expect(parseWindowsProcessList(json)).toHaveLength(1);
  });

  test('returns [] on malformed output', () => {
    expect(parseWindowsProcessList('oops')).toEqual([]);
  });
});

describe('parseUnixProcessList', () => {
  test('parses pid, ppid, lstart and the full command', () => {
    const out = [
      '    1     0 Mon Nov  9 01:00:00 2026 /sbin/init',
      '40296   900 Mon Nov  9 02:17:44 2026 node /usr/local/bin/browser-link',
      'garbage line',
    ].join('\n');
    expect(parseUnixProcessList(out)).toEqual([
      {
        pid: 1,
        ppid: 0,
        startedAt: new Date(2026, 10, 9, 1, 0, 0).getTime(),
        command: '/sbin/init',
      },
      {
        pid: 40296,
        ppid: 900,
        startedAt: new Date(2026, 10, 9, 2, 17, 44).getTime(),
        command: 'node /usr/local/bin/browser-link',
      },
    ]);
  });
});

describe('matchBrowserLinkCommand', () => {
  test('recognises the Windows global install with no subcommand (a bridge)', () => {
    expect(matchBrowserLinkCommand(`${NODE_WIN}   ${CLI_WIN} `)).toEqual({ subcommand: null });
  });

  test('reports the subcommand', () => {
    expect(matchBrowserLinkCommand(`${NODE_WIN} ${CLI_WIN} stop`)).toEqual({ subcommand: 'stop' });
    expect(
      matchBrowserLinkCommand(
        'node /usr/lib/node_modules/@jobshimo/browser-link/dist/cli.js start',
      ),
    ).toEqual({ subcommand: 'start' });
  });

  test('recognises the Unix bin shim and a plain browser-link/dist/cli.js path', () => {
    expect(matchBrowserLinkCommand('node /usr/local/bin/browser-link')).toEqual({
      subcommand: null,
    });
    expect(matchBrowserLinkCommand('/usr/bin/node /opt/browser-link/dist/cli.js doctor')).toEqual({
      subcommand: 'doctor',
    });
  });

  test('recognises npx @jobshimo/browser-link', () => {
    expect(
      matchBrowserLinkCommand(
        'node /usr/lib/node_modules/npm/bin/npx-cli.js -y @jobshimo/browser-link@latest',
      ),
    ).toEqual({ subcommand: null });
  });

  test('ignores browser-link appearing only as an argument value', () => {
    expect(
      matchBrowserLinkCommand(
        'C:\\x\\node.exe --liftoff-only C:\\x\\codegraph.js serve --mcp --path C:\\Users\\NERO\\repos\\browser-link',
      ),
    ).toBeNull();
    expect(matchBrowserLinkCommand('grep browser-link')).toBeNull();
    expect(matchBrowserLinkCommand('bash -c "browser-link/dist/cli.js"')).toBeNull();
    expect(matchBrowserLinkCommand('')).toBeNull();
  });
});

describe('findBridgeProcesses', () => {
  const entry = (pid: number, ppid: number, command: string): ProcessEntry => ({
    pid,
    ppid,
    startedAt: 1000 + pid,
    command,
  });

  test('keeps bridges, drops non-bridge subcommands, self and its ancestors', () => {
    const list = [
      entry(10, 1, 'node /usr/local/bin/browser-link'), // another agent's bridge
      entry(11, 1, 'node /usr/local/bin/browser-link start'), // explicit start
      entry(12, 1, 'node /usr/local/bin/browser-link doctor'), // non-bridge
      entry(20, 1, 'node /usr/local/bin/browser-link'), // ancestor of self
      entry(21, 20, 'node /usr/local/bin/browser-link stop'), // self
      entry(30, 1, 'node /srv/other-app.js'), // unrelated
    ];
    expect(findBridgeProcesses(list, 21).map((p) => p.pid)).toEqual([10, 11]);
  });

  test('survives a ppid cycle without looping', () => {
    const list = [entry(5, 6, 'node a.js'), entry(6, 5, 'node b.js')];
    expect(findBridgeProcesses(list, 5)).toEqual([]);
  });
});

describe('listBridgeProcesses', () => {
  test('Windows: one Get-CimInstance call, never wmic', () => {
    const exec = vi.fn<ExecFileLike>(() =>
      JSON.stringify([
        {
          ProcessId: 51044,
          ParentProcessId: 33464,
          CreationDate: '/Date(1794190664124)/',
          CommandLine: `${NODE_WIN} ${CLI_WIN}`,
        },
      ]),
    );
    const found = listBridgeProcesses({ os: 'win32', exec, selfPid: 1 });
    expect(found.map((p) => p.pid)).toEqual([51044]);
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args] = exec.mock.calls[0];
    expect(file).toBe('powershell');
    expect(args.join(' ')).toContain('Get-CimInstance Win32_Process');
    expect(args.join(' ')).not.toMatch(/wmic/i);
  });

  test('Unix: ps -axo pid=,ppid=,lstart=,command=', () => {
    const exec = vi.fn<ExecFileLike>(
      () => '40296   900 Mon Nov  9 02:17:44 2026 node /usr/local/bin/browser-link\n',
    );
    expect(listBridgeProcesses({ os: 'linux', exec, selfPid: 1 }).map((p) => p.pid)).toEqual([
      40296,
    ]);
    expect(exec).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
      timeout: expect.any(Number),
    });
  });

  test('a failing listing degrades to []', () => {
    const exec: ExecFileLike = () => {
      throw new Error('powershell not found');
    };
    expect(listBridgeProcesses({ os: 'win32', exec, selfPid: 1 })).toEqual([]);
  });
});

describe('readProcessStartTime', () => {
  test('Windows: filters Win32_Process by pid and parses the ISO output', () => {
    const exec = vi.fn<ExecFileLike>(() => '2026-11-09T02:17:44.1241560Z\r\n');
    expect(readProcessStartTime(51044, { os: 'win32', exec })).toBe(
      Date.parse('2026-11-09T02:17:44.124Z'),
    );
    expect(exec.mock.calls[0][1].join(' ')).toContain('ProcessId = 51044');
  });

  test('Unix: ps -o lstart= -p <pid>', () => {
    const exec = vi.fn<ExecFileLike>(() => 'Mon Nov  9 02:17:44 2026\n');
    expect(readProcessStartTime(40296, { os: 'darwin', exec })).toBe(
      new Date(2026, 10, 9, 2, 17, 44).getTime(),
    );
    expect(exec).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '40296'], {
      timeout: expect.any(Number),
    });
  });

  test('null when the lookup fails', () => {
    const exec: ExecFileLike = () => {
      throw new Error('no such process');
    };
    expect(readProcessStartTime(1, { os: 'linux', exec })).toBeNull();
  });
});

describe('shortCommand', () => {
  test('names the runtime and the browser-link entry, then the arguments', () => {
    expect(shortCommand(`${NODE_WIN}   ${CLI_WIN} start`)).toBe('node browser-link start');
    expect(shortCommand('node /usr/local/bin/browser-link')).toBe('node browser-link');
  });
});
