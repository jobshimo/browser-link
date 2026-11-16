import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './map/db.js';
import { listApps, listFlows, saveEntry, saveFlow } from './map/queries.js';
import { closeActivityDb } from './activity/db.js';
import { countInRange, record } from './activity/queries.js';
import { grantFilePath, loadGrant } from './cdp/grant.js';
import { dispatch } from './cli.js';
import {
  COMMAND_LINE,
  CommandLineError,
  formatArgProblem,
  parseArgs,
  parseCommandLine,
  readArgs,
  readCommandArgs,
  type ArgsSpec,
} from './cli-args.js';

/* D9 through the REAL entry: `dispatch` from cli.ts with no module mocks,
 * every store redirected to a temp data dir by BROWSER_LINK_DATA_DIR. Only
 * commands whose whole effect lives in that dir are run here (map, activity,
 * cdp); commands that reach the user's home, ports or network are covered in
 * cli.test.ts with their modules mocked. */

let dataDir: string;
let logs: string[];
let errors: string[];

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-cli-d9-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitCalled(code === null || code === undefined ? undefined : Number(code));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  closeActivityDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const STEPS = [{ find: { text: '<QUERY>', role: 'textbox' } }, { click: {} }];

function seedApp(): void {
  saveFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS });
  saveFlow({ origin: 'http://x', title: 'My App', name: 'logout', steps: STEPS });
}

function flowNames(): string[] {
  const app = listApps().find((a) => a.app_key === 'my-app');
  return app ? listFlows(app.id).map((f) => f.name) : [];
}

function seedTrail(n: number): void {
  for (let i = 0; i < n; i++) {
    record({
      tool: 'browser.click',
      tabId: 'tab_1',
      transport: 'extension',
      url: 'https://example.com/a',
      title: 'A',
      agent: 'claude-code',
      agentPid: 1,
      selector: '#go',
      payload: null,
      outcome: 'ok',
      error: null,
      durationMs: 10,
      flowId: null,
    });
  }
}

function trailSize(): number {
  return countInRange({});
}

describe('real entry, D9: map', () => {
  test('map forget <app> --flow=login --yes deletes only that flow', async () => {
    seedApp();
    await dispatch(['map', 'forget', 'my-app', '--flow=login', '--yes']);
    expect(logs.join('\n')).toContain('Deleted flow "login"');
    expect(flowNames()).toEqual(['logout']);
  });

  test('map forget <app> --flow --yes refuses and deletes nothing', async () => {
    seedApp();
    await expect(dispatch(['map', 'forget', 'my-app', '--flow', '--yes'])).rejects.toEqual(
      new ExitCalled(2),
    );
    expect(errors[0]).toBe('browser-link map forget: option --flow needs a value');
    expect(flowNames()).toEqual(['login', 'logout']);
  });

  test('map forget <app> --yes --help prints the help and deletes nothing', async () => {
    seedApp();
    await dispatch(['map', 'forget', 'my-app', '--yes', '--help']);
    expect(logs[0]).toContain('browser-link map forget <app>');
    expect(flowNames()).toEqual(['login', 'logout']);
  });

  test('map forget <app> --yse (a typo) refuses instead of printing a dry run', async () => {
    seedApp();
    await expect(dispatch(['map', 'forget', 'my-app', '--yse'])).rejects.toEqual(new ExitCalled(2));
    expect(errors[0]).toBe('browser-link map forget: unknown option --yse');
    expect(flowNames()).toEqual(['login', 'logout']);
  });

  test('map export --out=f writes the file instead of printing JSON', async () => {
    seedApp();
    const out = join(dataDir, 'export.json');
    await dispatch(['map', 'export', `--out=${out}`]);
    expect(logs.join('\n')).toContain('Wrote 1 app');
    expect(existsSync(out)).toBe(true);
  });

  test('map import <file> --replace=true refuses instead of merging', async () => {
    seedApp();
    const file = join(dataDir, 'in.json');
    writeFileSync(file, '{}', 'utf8');
    await expect(dispatch(['map', 'import', file, '--replace=true'])).rejects.toEqual(
      new ExitCalled(2),
    );
    expect(errors[0]).toBe(
      'browser-link map import: option --replace does not take a value (got --replace=true)',
    );
  });
});

describe('real entry, D9 (assumption A1): map forget never guesses between apps', () => {
  function seedShared(): void {
    saveEntry({
      origin: 'http://a',
      app_key: 'shared',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    saveEntry({
      origin: 'http://b',
      app_key: 'shared',
      url_pattern: '/b',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#b' },
    });
  }

  test('map forget <key> --yes on a key two apps share refuses and lists both', async () => {
    seedShared();
    await expect(dispatch(['map', 'forget', 'shared', '--yes'])).rejects.toThrow(
      /"shared" matches 2 apps/,
    );
    expect(listApps()).toHaveLength(2);
  });

  test('the refusal names every candidate', async () => {
    seedShared();
    const err = await dispatch(['map', 'forget', 'shared', '--yes']).catch((e: unknown) => e);
    expect(String(err)).toContain('shared  (http://a)');
    expect(String(err)).toContain('shared  (http://b)');
    expect(String(err)).toContain('Nothing was deleted.');
  });

  test('the dry run of map forget <origin> confirms with that origin, not the shared key', async () => {
    seedShared();
    await dispatch(['map', 'forget', 'http://a']);
    const out = logs.join('\n');
    expect(out).toContain('This would delete app "shared" (http://a)');
    expect(out).toContain('  browser-link map forget http://a --yes');
    expect(out).not.toContain('map forget shared --yes');
    expect(listApps()).toHaveLength(2);
  });
});

describe('real entry, D9: activity clear never falls through to the whole trail', () => {
  test.each([
    [['activity', 'clear', '--older-than', '--yes']],
    [['activity', 'clear', '--from', '--yes']],
    [['activity', 'clear', '--to', '--yes']],
    [['activity', 'clear', '--older-than=', '--yes']],
  ])('%j refuses and removes nothing', async (argv) => {
    seedTrail(3);
    await expect(dispatch(argv)).rejects.toEqual(new ExitCalled(2));
    expect(errors[0]).toMatch(/^browser-link activity clear: option --\S+ needs a value$/);
    expect(trailSize()).toBe(3);
  });

  test('activity clear --yes --help prints the usage and removes nothing', async () => {
    seedTrail(3);
    await dispatch(['activity', 'clear', '--yes', '--help']);
    expect(logs[0]).toContain('browser-link activity clear [options]');
    expect(trailSize()).toBe(3);
  });

  test('activity clear --yes -h prints the usage and removes nothing', async () => {
    seedTrail(3);
    await dispatch(['activity', 'clear', '--yes', '-h']);
    expect(logs[0]).toContain('browser-link activity clear [options]');
    expect(trailSize()).toBe(3);
  });

  test('activity clear --older-than=7d is the same as --older-than 7d', async () => {
    seedTrail(3);
    await dispatch(['activity', 'clear', '--older-than=7d']);
    expect(logs.join('\n')).toBe('Nothing to remove.');
    expect(trailSize()).toBe(3);
  });

  test('activity clear --yes still wipes the trail when asked explicitly', async () => {
    seedTrail(3);
    await dispatch(['activity', 'clear', '--yes']);
    expect(logs.join('\n')).toBe('Removed 3 actions from the trail.');
    expect(trailSize()).toBe(0);
  });
});

describe('real entry, D9: cdp allow', () => {
  test('cdp allow --help prints the help and records no grant', async () => {
    await dispatch(['cdp', 'allow', '--help']);
    expect(logs[0]).toContain('browser-link cdp allow');
    expect(existsSync(grantFilePath())).toBe(false);
  });

  test('cdp allow --minutes (no value) refuses and records no grant', async () => {
    await expect(dispatch(['cdp', 'allow', '--minutes'])).rejects.toEqual(new ExitCalled(2));
    expect(errors[0]).toBe('browser-link cdp allow: option --minutes needs a value');
    expect(existsSync(grantFilePath())).toBe(false);
  });

  test.each([[['--minutes=5']], [['--minutes', '5']]])(
    'cdp allow %j records a 5-minute grant',
    async (opts) => {
      const before = Date.now();
      await dispatch(['cdp', 'allow', ...opts]);
      const grant = loadGrant();
      expect(grant?.expiresAt).not.toBeNull();
      const minutes = ((grant?.expiresAt ?? 0) - before) / 60_000;
      expect(minutes).toBeGreaterThan(4.9);
      expect(minutes).toBeLessThan(5.1);
      expect(readFileSync(grantFilePath(), 'utf8')).toContain('expiresAt');
    },
  );
});

describe('parseArgs: the one rule set', () => {
  const SPEC: ArgsSpec = { options: { flow: 'value', yes: 'switch' }, maxPositionals: 1 };

  test('--option value and --option=value give the same value', () => {
    const a = parseArgs(SPEC, ['app', '--flow', 'login']);
    const b = parseArgs(SPEC, ['app', '--flow=login']);
    expect(a.ok && a.args.value('flow')).toBe('login');
    expect(b.ok && b.args.value('flow')).toBe('login');
  });

  test('a value may contain = and may start with a dash when written inline', () => {
    const r = parseArgs(SPEC, ['--flow=a=b']);
    expect(r.ok && r.args.value('flow')).toBe('a=b');
    const dash = parseArgs(SPEC, ['--flow=--odd']);
    expect(dash.ok && dash.args.value('flow')).toBe('--odd');
  });

  test('options and words may come in any order', () => {
    const r = parseArgs(SPEC, ['--yes', 'app']);
    expect(r.ok && r.args.has('yes')).toBe(true);
    expect(r.ok && r.args.positionals).toEqual(['app']);
  });

  test('a negative number and a lone dash are words, not options', () => {
    const r = parseArgs({ options: { minutes: 'value' }, maxPositionals: 1 }, [
      '--minutes',
      '-5',
      '-',
    ]);
    expect(r.ok && r.args.value('minutes')).toBe('-5');
    expect(r.ok && r.args.positionals).toEqual(['-']);
  });

  test.each([
    [['--flow'], { kind: 'missing-value', option: 'flow' }],
    [['--flow', '--yes'], { kind: 'missing-value', option: 'flow' }],
    [['--flow', '-x'], { kind: 'missing-value', option: 'flow' }],
    [['--flow='], { kind: 'missing-value', option: 'flow' }],
    [['--yes=true'], { kind: 'unexpected-value', option: 'yes', token: '--yes=true' }],
    [['--nope'], { kind: 'unknown-option', token: '--nope' }],
    [['--nope=1'], { kind: 'unknown-option', token: '--nope' }],
    [['-y'], { kind: 'unknown-option', token: '-y' }],
    [['--'], { kind: 'malformed-option', token: '--' }],
    [['---flow'], { kind: 'malformed-option', token: '---flow' }],
    [['--=x'], { kind: 'malformed-option', token: '--=x' }],
    [['--yes', '--yes'], { kind: 'repeated-option', option: 'yes' }],
    [['--flow', 'a', '--flow=b'], { kind: 'repeated-option', option: 'flow' }],
    [['a', 'b'], { kind: 'unexpected-argument', token: 'b' }],
    [['--constructor'], { kind: 'unknown-option', token: '--constructor' }],
  ])('%j is refused as %j', (tokens, problem) => {
    expect(parseArgs(SPEC, tokens)).toEqual({ ok: false, problem });
  });
});

describe('parseCommandLine: help, subcommands and refusals', () => {
  test('--help or -h anywhere is help for that (sub)command', () => {
    expect(parseCommandLine('map', ['forget', 'a', '--yes', '--help'])).toEqual({
      kind: 'help',
      path: 'map forget',
    });
    expect(parseCommandLine('stop', ['-h'])).toEqual({ kind: 'help', path: 'stop' });
    expect(parseCommandLine('cdp', ['-h', 'allow'])).toEqual({ kind: 'help', path: 'cdp' });
  });

  test('help wins over a refused option', () => {
    expect(parseCommandLine('install', ['--bogus', '--help'])?.kind).toBe('help');
  });

  test('without help detection, --help is an unknown option', () => {
    expect(parseCommandLine('stop', ['--help'], { detectHelp: false })).toEqual({
      kind: 'error',
      path: 'stop',
      problem: { kind: 'unknown-option', token: '--help' },
    });
  });

  test('stop takes one value option, --pid, in both spellings, and nothing else (D14)', () => {
    for (const argv of [['--pid', '4242'], ['--pid=4242']]) {
      const line = parseCommandLine('stop', argv);
      expect(line?.kind === 'ok' && line.args.value('pid')).toBe('4242');
    }
    const bare = parseCommandLine('stop', []);
    expect(bare?.kind === 'ok' && bare.args.has('pid')).toBe(false);
    expect(parseCommandLine('stop', ['--pid'])).toEqual({
      kind: 'error',
      path: 'stop',
      problem: { kind: 'missing-value', option: 'pid' },
    });
    expect(parseCommandLine('stop', ['4242'])).toEqual({
      kind: 'error',
      path: 'stop',
      problem: { kind: 'unexpected-argument', token: '4242' },
    });
  });

  test('an unknown command has no grammar', () => {
    expect(parseCommandLine('nosuchcmd', [])).toBeUndefined();
    expect(parseCommandLine('toString', [])).toBeUndefined();
  });

  test('an unknown first word is left to commands that report their own unknown action', () => {
    expect(parseCommandLine('map', ['bogus', '--yes'])).toEqual({ kind: 'unknown-subcommand' });
    expect(parseCommandLine('activity', ['bogus'])).toEqual({
      kind: 'error',
      path: 'activity',
      problem: { kind: 'unexpected-argument', token: 'bogus' },
    });
  });

  test('every command the CLI dispatches has a grammar', () => {
    expect(Object.keys(COMMAND_LINE).sort()).toEqual(
      [
        'about',
        'activity',
        'cdp',
        'config',
        'doctor',
        'extension',
        'feedback',
        'install',
        'instructions',
        'map',
        'multi-agent',
        'start',
        'stop',
        'tools',
        'uninstall',
        'updates',
        'version',
      ].sort(),
    );
  });
});

describe('module readers share the parser', () => {
  test('readArgs throws a CommandLineError naming the command and the problem', () => {
    expect(() => readArgs('cdp allow', ['--minutes'], 'en')).toThrow(CommandLineError);
    expect(() => readArgs('cdp allow', ['--minutes'], 'en')).toThrow(
      'browser-link cdp allow: option --minutes needs a value\nNothing was done. See: browser-link cdp --help',
    );
  });

  test('readCommandArgs returns no arguments for an unknown first word', () => {
    expect(readCommandArgs('map', ['bogus'], 'en').positionals).toEqual([]);
  });

  test('the refusal is equivalent in both languages', () => {
    const problem = { kind: 'missing-value', option: 'client' } as const;
    expect(formatArgProblem('uninstall', problem, 'en')).toEqual([
      'browser-link uninstall: option --client needs a value',
      'Nothing was done. See: browser-link uninstall --help',
    ]);
    expect(formatArgProblem('uninstall', problem, 'es')).toEqual([
      'browser-link uninstall: la opción --client necesita un valor',
      'No se hizo nada. Consulte: browser-link uninstall --help',
    ]);
  });
});

describe('real entry, D9: commands that write settings or open a store', () => {
  test('feedback --help prints the usage without opening the activity database', async () => {
    await dispatch(['feedback', '--help']);
    expect(logs[0]).toContain('browser-link feedback [--limit <n>]');
    expect(existsSync(join(dataDir, 'activity.db'))).toBe(false);
  });

  test.each([
    [['tools', 'disable', 'browser.click', '--help']],
    [['multi-agent', 'enable', '-h']],
    [['config', 'set', 'idle-ttl', '15', '--help']],
  ])('%j writes no config.json', async (argv) => {
    await dispatch(argv);
    expect(logs[0]?.startsWith('Usage:')).toBe(true);
    expect(existsSync(join(dataDir, 'config.json'))).toBe(false);
  });

  test.each([
    [['tools', 'disable', 'browser.click', '--all'], 'unknown option --all'],
    [['multi-agent', 'enable', 'now'], 'unexpected argument now'],
    [['config', 'set', 'idle-ttl', '15', 'extra'], 'unexpected argument extra'],
  ])('%j refuses and writes no config.json', async (argv, problem) => {
    await expect(dispatch(argv)).rejects.toEqual(new ExitCalled(2));
    expect(errors[0]).toContain(problem);
    expect(existsSync(join(dataDir, 'config.json'))).toBe(false);
  });
});
