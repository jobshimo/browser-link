import { describe, expect, test, vi } from 'vitest';

/* The OS view of a port holder (D14). Every command is an injected fake;
 * the real child_process fails the test if anything reaches it. */
vi.mock('node:child_process', () => {
  const refuse = () => {
    throw new Error('a test reached the real child_process');
  };
  return { execFileSync: vi.fn(refuse), execFile: vi.fn(refuse) };
});

import {
  findPortOwner,
  inspectPortHolder,
  isBrowserLinkServer,
  parseNetstatListeners,
  readImageName,
  type PortLookupDeps,
} from './port-holder.js';

function deps(
  os: NodeJS.Platform,
  answer: (file: string, args: readonly string[]) => string | Error,
  table: { pid: number; command: string }[] = [],
): PortLookupDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    os,
    calls,
    exec: (file, args, options) => {
      calls.push(`${file} ${args.join(' ')} (timeout ${options.timeout})`);
      const a = answer(file, args);
      if (a instanceof Error) throw a;
      return a;
    },
    processTable: () => table.map((p) => ({ ...p, ppid: 0, startedAt: null })),
  };
}

const failure = (props: Record<string, unknown>): Error =>
  Object.assign(new Error('failed'), props);

describe('findPortOwner — macOS and Linux (lsof)', () => {
  test('one pid → held, with a bounded command', () => {
    const d = deps('linux', () => '4242\n');
    expect(findPortOwner(17529, d)).toEqual({ kind: 'held', pid: 4242 });
    expect(d.calls).toEqual(['lsof -nP -iTCP:17529 -sTCP:LISTEN -t (timeout 5000)']);
  });

  test('exit 1 with no output is the only "free"', () => {
    expect(
      findPortOwner(
        17529,
        deps('darwin', () => failure({ status: 1, stdout: '' })),
      ),
    ).toEqual({
      kind: 'free',
    });
  });

  test.each([
    ['lsof missing', failure({ code: 'ENOENT' }), 'command-missing'],
    ['timeout', failure({ code: 'ETIMEDOUT', signal: 'SIGTERM' }), 'timeout'],
    [
      'exit 1 that printed something',
      failure({ status: 1, stdout: 'lsof: WARNING' }),
      'command-failed',
    ],
    ['another exit code', failure({ status: 2, stdout: '' }), 'command-failed'],
  ])('%s → unknown (%s)', (_name, err, reason) => {
    expect(
      findPortOwner(
        17529,
        deps('linux', () => err),
      ),
    ).toEqual({ kind: 'unknown', reason });
  });

  test('garbage → unknown, two pids → unknown', () => {
    expect(
      findPortOwner(
        1,
        deps('linux', () => 'abc\n'),
      ),
    ).toEqual({
      kind: 'unknown',
      reason: 'unreadable-output',
    });
    expect(
      findPortOwner(
        1,
        deps('linux', () => '1\n2\n'),
      ),
    ).toEqual({
      kind: 'unknown',
      reason: 'several-holders',
    });
    expect(
      findPortOwner(
        1,
        deps('linux', () => '7\n7\n'),
      ),
    ).toEqual({ kind: 'held', pid: 7 });
  });
});

describe('findPortOwner — Windows (netstat)', () => {
  test('only the listening row of exactly that port counts, whatever the state language', () => {
    const out = [
      '  TCP    127.0.0.1:17529        127.0.0.1:55555        ESTABLISHED     11111',
      '  TCP    127.0.0.1:175290       0.0.0.0:0              LISTENING       3',
      '  TCP    127.0.0.1:17529        0.0.0.0:0              ESCUCHANDO      22222',
    ].join('\r\n');
    expect(parseNetstatListeners(out, 17529)).toEqual([22222]);
    expect(
      findPortOwner(
        17529,
        deps('win32', () => out),
      ),
    ).toEqual({ kind: 'held', pid: 22222 });
  });

  test('no listening row → free; netstat failing → unknown', () => {
    expect(
      findPortOwner(
        17529,
        deps('win32', () => 'Active Connections\r\n'),
      ),
    ).toEqual({
      kind: 'free',
    });
    expect(
      findPortOwner(
        17529,
        deps('win32', () => failure({ code: 'ENOENT' })),
      ),
    ).toEqual({
      kind: 'unknown',
      reason: 'command-missing',
    });
  });
});

describe('readImageName', () => {
  test('tasklist CSV, checked against the pid asked for', () => {
    const csv = '"node.exe","13212","Console","1","45,000 K"';
    expect(
      readImageName(
        13212,
        deps('win32', () => csv),
      ),
    ).toBe('node.exe');
    expect(
      readImageName(
        99,
        deps('win32', () => csv),
      ),
    ).toBeNull();
    expect(
      readImageName(
        1,
        deps('win32', () => 'INFO: No tasks are running'),
      ),
    ).toBeNull();
  });

  test('ps -o comm=; empty or failing → null', () => {
    expect(
      readImageName(
        5,
        deps('linux', () => 'node\n'),
      ),
    ).toBe('node');
    expect(
      readImageName(
        5,
        deps('linux', () => '\n'),
      ),
    ).toBeNull();
    expect(
      readImageName(
        5,
        deps('linux', () => failure({ status: 1 })),
      ),
    ).toBeNull();
  });
});

describe('isBrowserLinkServer: a runtime image AND a browser-link server command line', () => {
  const cli = 'node /usr/local/bin/browser-link';
  test.each([
    ['node', cli, true],
    ['/usr/local/bin/node', cli, true], // macOS comm can be a full path
    ['node.exe', `${cli} start`, true],
    ['node', `${cli} doctor`, false], // a short-lived subcommand
    ['node', 'node /srv/unrelated.js', false],
    ['nodemon', cli, false],
    ['python3', cli, false],
  ])('%s running "%s" → %s', (imageName, command, expected) => {
    expect(isBrowserLinkServer({ pid: 1, imageName, command })).toBe(expected);
  });

  test('a missing image name or command line is never a browser-link server', () => {
    expect(isBrowserLinkServer({ pid: 1, imageName: null, command: cli })).toBe(false);
    expect(isBrowserLinkServer({ pid: 1, imageName: 'node', command: null })).toBe(false);
  });
});

test('inspectPortHolder joins the holder with its identity', () => {
  const d = deps('linux', (file) => (file === 'lsof' ? '42\n' : 'node\n'), [
    { pid: 42, command: 'node /usr/local/bin/browser-link' },
  ]);
  expect(inspectPortHolder(17529, d)).toEqual({
    kind: 'process',
    process: { pid: 42, imageName: 'node', command: 'node /usr/local/bin/browser-link' },
    isBrowserLink: true,
  });
});
