import { describe, expect, test, vi } from 'vitest';

/* `stop` and `stop --pid` (owner decision D14). Every OS effect is an
 * injected fake: the port lookups, the process lookups and the kill. The
 * real child_process is replaced by one that fails the test if anything
 * reaches it, so no real process is ever looked up or killed. */
vi.mock('node:child_process', () => {
  const refuse = () => {
    throw new Error('a test reached the real child_process');
  };
  return { execFileSync: vi.fn(refuse), execFile: vi.fn(refuse) };
});

import { runFreePort, runStopPid, type StopDeps } from './free-port.js';
import type { ProcessEntry } from '../lifecycle/processes.js';

const SELF = 1;

type Answer = string | Error;

/** An exec fake keyed by `<command> <first arg>` (or the port for lsof and
 * the pid for the image lookups), recording every call. */
function osFake(os: NodeJS.Platform, answers: (file: string, args: readonly string[]) => Answer) {
  const calls: string[] = [];
  const exec = (file: string, args: readonly string[]): string => {
    calls.push(`${file} ${args.join(' ')}`);
    const answer = answers(file, args);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { os, exec, calls };
}

function exitStatus(status: number): Error {
  return Object.assign(new Error(`exit ${status}`), { status, stdout: '' });
}

function missing(file: string): Error {
  return Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
}

function timedOut(): Error {
  return Object.assign(new Error('spawnSync lsof ETIMEDOUT'), {
    code: 'ETIMEDOUT',
    signal: 'SIGTERM',
  });
}

function entry(pid: number, command: string): ProcessEntry {
  return { pid, ppid: SELF === pid ? 0 : 999, startedAt: null, command };
}

const BRIDGE_CMD = 'node /usr/local/bin/browser-link';
const START_CMD = 'node /usr/lib/node_modules/@jobshimo/browser-link/dist/cli.js start';

interface Scenario {
  /** lsof answer per port; absent = nothing listening (exit 1). */
  ports?: Partial<Record<17529 | 17530, Answer>>;
  /** `ps -o comm=` per pid; absent = unknown. */
  images?: Record<number, string>;
  table?: ProcessEntry[];
  killFails?: boolean;
}

function unix(s: Scenario) {
  const fake = osFake('linux', (file, args) => {
    if (file === 'lsof') {
      const port = Number(/-iTCP:(\d+)/.exec(args.join(' '))?.[1]);
      return s.ports?.[port as 17529 | 17530] ?? exitStatus(1);
    }
    if (file === 'ps' && args[0] === '-p') {
      const image = s.images?.[Number(args[1])];
      return image === undefined ? exitStatus(1) : `${image}\n`;
    }
    return missing(file);
  });
  const killed: number[] = [];
  const deps: StopDeps = {
    os: fake.os,
    exec: fake.exec,
    listProcesses: () => s.table ?? [],
    kill: (pid) => {
      killed.push(pid);
      return s.killFails !== true;
    },
    selfPid: SELF,
  };
  return { deps, killed, calls: fake.calls };
}

describe('stop: a verified browser-link holder is stopped (D14)', () => {
  test('the OS says PID 100 holds 17529 and runs browser-link → only PID 100 is killed', () => {
    const s = unix({
      ports: { 17529: '100\n' },
      images: { 100: 'node' },
      table: [entry(100, BRIDGE_CMD)],
    });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([100]);
    expect(r).toEqual({
      portState: 'stopped',
      ok: true,
      pid: 100,
      imageName: 'node',
      message: '✓ Stopped browser-link primary (PID 100). Port 127.0.0.1:17529 is now free.',
      processes: [{ pid: 100, command: 'node browser-link', stopped: true }],
    });
  });

  test('a verified holder on 17530 that is another process is stopped too', () => {
    const s = unix({
      ports: { 17529: '100\n', 17530: '200\n' },
      images: { 100: 'node', 200: 'node' },
      table: [entry(100, BRIDGE_CMD), entry(200, START_CMD)],
    });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([100, 200]);
    expect(r.ok).toBe(true);
    expect(r.message.split('\n')).toEqual([
      '✓ Stopped browser-link primary (PID 100). Port 127.0.0.1:17529 is now free.',
      'Other browser-link processes:',
      '  PID 200  node browser-link start  ✓ stopped',
    ]);
  });

  test('a kill the OS refuses makes the result not ok', () => {
    const s = unix({
      ports: { 17529: '777\n' },
      images: { 777: 'node' },
      table: [entry(777, BRIDGE_CMD)],
      killFails: true,
    });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([777]);
    expect(r.ok).toBe(false);
    expect(r.portState).toBe('stop-failed');
    expect(r.message).toBe(
      '✗ Could not kill PID 777. Try again as administrator, or close the MCP client manually.',
    );
  });
});

describe('stop never kills what the OS did not confirm (D14)', () => {
  test('the port lookup fails → never "already free", nothing killed, the stray bridge only listed', () => {
    const s = unix({ ports: { 17529: missing('lsof'), 17530: missing('lsof') } });
    s.deps.listProcesses = () => [entry(300, START_CMD)];
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.portState).toBe('unknown');
    expect(r.pid).toBeNull();
    expect(r.message.split('\n')).toEqual([
      '✗ Could not check through the operating system which process holds port 127.0.0.1:17529: ' +
        'the lookup tool (netstat or lsof) is not installed. Nothing was stopped.',
      'Other browser-link processes, not stopped (they hold no browser-link port, so the ' +
        'operating system cannot confirm them through it):',
      '  PID 300  node browser-link start  to stop it: browser-link stop --pid 300',
    ]);
    expect(r.processes).toBeUndefined();
  });

  test('the port lookup times out → same refusal, nothing killed', () => {
    const s = unix({ ports: { 17529: timedOut(), 17530: timedOut() } });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(
      '✗ Could not check through the operating system which process holds port 127.0.0.1:17529: ' +
        'the lookup timed out. Nothing was stopped.',
    );
  });

  test('lsof prints something that is not a pid → unknown, not free', () => {
    const s = unix({ ports: { 17529: 'not-a-number\n' } });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/could not be read\. Nothing was stopped\.$/);
  });

  test('a node process that is not a browser-link holds the port → not killed, named with the command', () => {
    const s = unix({
      ports: { 17529: '500\n' },
      images: { 500: 'node' },
      table: [entry(500, 'node /srv/unrelated.js')],
    });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r).toEqual({
      portState: 'held-by-other',
      ok: false,
      pid: 500,
      imageName: 'node',
      message:
        '✗ Port 127.0.0.1:17529 is held by PID 500 (node) — node /srv/unrelated.js, which the ' +
        'operating system does not show as a browser-link server. Nothing was stopped. ' +
        'To stop that process: browser-link stop --pid 500',
    });
  });

  test('a non-runtime image with a browser-link command line is not killed', () => {
    const s = unix({
      ports: { 17529: '9999\n' },
      images: { 9999: 'caddy' },
      table: [entry(9999, BRIDGE_CMD)],
    });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('PID 9999 (caddy)');
    // The holder is named once, not listed again as an "other" process.
    expect(r.message).not.toContain('Other browser-link processes');
  });

  test('a holder whose image name cannot be read is not killed', () => {
    const s = unix({ ports: { 17529: '4242\n' }, table: [entry(4242, BRIDGE_CMD)] });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.imageName).toBeNull();
    expect(r.message).toContain('PID 4242 (name unknown)');
    expect(r.message).toContain('browser-link stop --pid 4242');
  });

  test('two pids listed on the port → unknown, nothing killed', () => {
    const s = unix({ ports: { 17529: '100\n200\n' }, images: { 100: 'node', 200: 'node' } });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.message).toMatch(/more than one process is listed on the port/);
  });

  test('a holder that is this command or an ancestor is never killed', () => {
    const s = unix({
      ports: { 17529: `${SELF}\n` },
      images: { [SELF]: 'node' },
      table: [entry(SELF, BRIDGE_CMD)],
    });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.portState).toBe('held-by-other');
    expect(r.message).toMatch(/is this command or one of the processes that started it/);
  });

  test('a 17530 holder that is not a browser-link is left alone and not mentioned', () => {
    const s = unix({ ports: { 17530: '600\n' }, images: { 600: 'caddy' } });
    const r = runFreePort('en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Port 127.0.0.1:17529 is already free — nothing to stop.');
    expect(r.processes).toBeUndefined();
  });
});

describe('stop: behaviors kept', () => {
  test('nothing listening (lsof exit 1, no output) → ok, null pid, "already free", exact old shape', () => {
    const s = unix({});
    const r = runFreePort('en', s.deps);
    expect(r).toEqual({
      portState: 'free',
      ok: true,
      pid: null,
      imageName: null,
      message: 'Port 127.0.0.1:17529 is already free — nothing to stop.',
    });
    expect(s.killed).toEqual([]);
  });

  test('short-lived commands and unrelated node scripts are never listed', () => {
    const s = unix({});
    s.deps.listProcesses = () => [
      entry(400, 'node /usr/local/bin/browser-link doctor'),
      entry(500, 'node /srv/unrelated.js'),
      entry(SELF, 'node /usr/local/bin/browser-link'),
    ];
    const r = runFreePort('en', s.deps);
    expect(r.message).toBe('Port 127.0.0.1:17529 is already free — nothing to stop.');
  });

  test('the process table is read once per run', () => {
    const s = unix({
      ports: { 17529: '100\n', 17530: '100\n' },
      images: { 100: 'node' },
    });
    const table = vi.fn(() => [entry(100, BRIDGE_CMD)]);
    s.deps.listProcesses = table;
    runFreePort('en', s.deps);
    expect(table).toHaveBeenCalledOnce();
    expect(s.killed).toEqual([100]);
  });

  test('Spanish messages', () => {
    const free = unix({});
    expect(runFreePort('es', free.deps).message).toBe(
      'El puerto 127.0.0.1:17529 ya está libre — no hay nada que parar.',
    );
    const ok = unix({
      ports: { 17529: '321\n' },
      images: { 321: 'node' },
      table: [entry(321, BRIDGE_CMD)],
    });
    expect(runFreePort('es', ok.deps).message).toMatch(/browser-link primary detenido \(PID 321\)/);
    const refused = unix({ ports: { 17529: '321\n' }, images: { 321: 'caddy' } });
    expect(runFreePort('es', refused.deps).message).toBe(
      '✗ El puerto 127.0.0.1:17529 lo ocupa el PID 321 (caddy), que el sistema operativo no ' +
        'muestra como un servidor browser-link. No se detuvo nada. Para detener ese proceso: ' +
        'browser-link stop --pid 321',
    );
  });
});

describe('stop: the Windows lookups', () => {
  const netstat = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024',
    '  TCP    127.0.0.1:17529        127.0.0.1:55555        ESTABLISHED     11111',
    '  TCP    127.0.0.1:17529        0.0.0.0:0              ABHÖREN         13212',
    '  TCP    127.0.0.1:175290       0.0.0.0:0              LISTENING       3',
    '  TCP    192.168.1.1:443        0.0.0.0:0              LISTENING       4',
  ].join('\r\n');
  const commandLine = String.raw`"C:\nodejs\node.exe" "C:\nodejs\node_modules\@jobshimo\browser-link\dist\cli.js"`;

  function windows(tasklist: string) {
    const killed: number[] = [];
    const fake = osFake('win32', (file) => {
      if (file === 'netstat') return netstat;
      if (file === 'tasklist') return tasklist;
      return missing(file);
    });
    const deps: StopDeps = {
      os: fake.os,
      exec: fake.exec,
      listProcesses: () => [entry(13212, commandLine)],
      kill: (pid) => {
        killed.push(pid);
        return true;
      },
      selfPid: SELF,
    };
    return { deps, killed, calls: fake.calls };
  }

  test('reads the listening row of the port whatever the state language, and kills the verified holder', () => {
    const w = windows('"node.exe","13212","Console","1","45,000 K"');
    const r = runFreePort('en', w.deps);
    expect(w.killed).toEqual([13212]);
    expect(r.pid).toBe(13212);
    expect(r.imageName).toBe('node.exe');
    expect(w.calls).toContain('tasklist /FI PID eq 13212 /FO CSV /NH');
  });

  test('tasklist "INFO: No tasks" → name unknown, nothing killed', () => {
    const w = windows('INFO: No tasks are running which match the specified criteria.');
    const r = runFreePort('en', w.deps);
    expect(w.killed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.imageName).toBeNull();
  });

  test('a chrome.exe holder is refused', () => {
    const w = windows('"chrome.exe","13212","Console","1","200,000 K"');
    const r = runFreePort('en', w.deps);
    expect(w.killed).toEqual([]);
    expect(r.message).toContain('PID 13212 (chrome.exe)');
  });
});

describe('stop --pid <PID>: the explicit command (D14)', () => {
  test('a verified browser-link holder: shows it, then kills exactly that pid', () => {
    const s = unix({
      ports: { 17529: '100\n' },
      images: { 100: 'node' },
      table: [entry(100, BRIDGE_CMD), entry(300, START_CMD)],
    });
    const r = runStopPid(100, 'en', s.deps);
    expect(s.killed).toEqual([100]);
    expect(r).toEqual({
      ok: true,
      pid: 100,
      imageName: 'node',
      message: [
        'Process to stop: PID 100 (node) — node browser-link, holds 127.0.0.1:17529',
        '✓ Stopped PID 100.',
      ].join('\n'),
      processes: [{ pid: 100, command: 'node browser-link', stopped: true }],
    });
  });

  test('a non-browser-link holder of the port (what the take-over refused) is stopped on order', () => {
    const s = unix({
      ports: { 17529: '500\n' },
      images: { 500: 'python3' },
      table: [entry(500, 'python3 -m http.server 17529')],
    });
    const r = runStopPid(500, 'en', s.deps);
    expect(s.killed).toEqual([500]);
    expect(r.message.split('\n')).toEqual([
      'Process to stop: PID 500 (python3) — python3 -m http.server 17529, holds 127.0.0.1:17529',
      '✓ Stopped PID 500.',
    ]);
  });

  test('a browser-link proxy that holds no port is stopped on order (the command `stop` lists)', () => {
    const s = unix({ images: { 300: 'node' }, table: [entry(300, START_CMD)] });
    const r = runStopPid(300, 'en', s.deps);
    expect(s.killed).toEqual([300]);
    expect(r.message.split('\n')[0]).toBe(
      'Process to stop: PID 300 (node) — node browser-link start',
    );
  });

  test('a pid that is neither a browser-link nor a holder of its ports → nothing killed', () => {
    const s = unix({ images: { 4321: 'bash' }, table: [entry(4321, 'bash')] });
    const r = runStopPid(4321, 'en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r).toEqual({
      ok: false,
      pid: 4321,
      imageName: 'bash',
      message:
        '✗ PID 4321 (bash) — bash is not a browser-link server and holds no browser-link port ' +
        '(127.0.0.1:17529, 127.0.0.1:17530). Nothing was stopped.',
    });
  });

  test('a pid the OS does not list → nothing killed', () => {
    const s = unix({});
    const r = runStopPid(8888, 'en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(
      '✗ The operating system lists no process with PID 8888, or could not be asked. Nothing was stopped.',
    );
  });

  test('this command or an ancestor → nothing killed', () => {
    const s = unix({ images: { [SELF]: 'node' }, table: [entry(SELF, BRIDGE_CMD)] });
    const r = runStopPid(SELF, 'en', s.deps);
    expect(s.killed).toEqual([]);
    expect(r.message).toMatch(/one of the processes that started it/);
  });

  test('a kill the OS refuses: shown, then not ok', () => {
    const s = unix({
      ports: { 17529: '100\n' },
      images: { 100: 'node' },
      table: [entry(100, BRIDGE_CMD)],
      killFails: true,
    });
    const r = runStopPid(100, 'es', s.deps);
    expect(s.killed).toEqual([100]);
    expect(r.ok).toBe(false);
    expect(r.message.split('\n')).toEqual([
      'Proceso a detener: PID 100 (node) — node browser-link, ocupa 127.0.0.1:17529',
      '✗ No se pudo detener el PID 100. Inténtelo de nuevo como administrador o cierre el cliente MCP manualmente.',
    ]);
  });
});
