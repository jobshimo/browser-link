import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import {
  ConfigUnreadableError,
  defaultSettings,
  readConfig,
  unreadableConfigMessage,
  type UnreadableConfig,
} from '../config.js';
import { grantFilePath } from '../cdp/grant.js';
import { formatRestoreResult, runConfigCommand } from './config.js';
import { runToolsCommand } from './tools.js';
import { runMultiAgentCommand } from './multi-agent.js';
import { runCdpCommand } from './cdp.js';

/* S6.3 and S6.4 through the commands: every write path refuses an
 * unreadable config.json with the same message and writes nothing;
 * `config restore-defaults` keeps a copy and writes the defaults. Each
 * write command still writes a valid file as before. */

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;
let configPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-cmd-unreadable-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  configPath = join(dataDir, 'config.json');
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  delete process.env.BROWSER_LINK_DATA_DIR;
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

const BROKEN = '{ "disabledTools": ["browser.evaluate"], "multiAgent": false ';

function problem(): UnreadableConfig {
  const read = readConfig();
  if (read.state !== 'unreadable') throw new Error('config is not unreadable');
  return read;
}

function expectUntouched(): void {
  expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
  expect(readdirSync(dataDir)).toEqual(['config.json']);
}

describe('every write command refuses an unreadable config.json and writes nothing (S6.3)', () => {
  const WRITES: [string, () => Promise<unknown>][] = [
    ['config set idle-ttl', () => runConfigCommand(['set', 'idle-ttl', '15'])],
    ['config set flow-recording', () => runConfigCommand(['set', 'flow-recording', 'on'])],
    [
      'config set cdp-direct.enabled',
      () => runConfigCommand(['set', 'cdp-direct.enabled', 'true']),
    ],
    ['config set cdp-direct.port', () => runConfigCommand(['set', 'cdp-direct.port', '9333'])],
    [
      'config set cdp-direct.grant-ttl',
      () => runConfigCommand(['set', 'cdp-direct.grant-ttl', '5']),
    ],
    ['config set downloads.dir', () => runConfigCommand(['set', 'downloads.dir', 'default'])],
    ['config set downloads.max-mb', () => runConfigCommand(['set', 'downloads.max-mb', '10'])],
    ['config set map-learning', () => runConfigCommand(['set', 'map-learning', 'off'])],
    ['tools enable', async () => runToolsCommand(['enable', 'browser.evaluate'])],
    ['tools disable', async () => runToolsCommand(['disable', 'browser.click'])],
    ['tools preset', async () => runToolsCommand(['preset', 'readonly'])],
    ['multi-agent enable', async () => runMultiAgentCommand(['enable'])],
    ['multi-agent disable', async () => runMultiAgentCommand(['disable'])],
    [
      'multi-agent auto-reelect enable',
      async () => runMultiAgentCommand(['auto-reelect', 'enable']),
    ],
    [
      'multi-agent auto-reelect disable',
      async () => runMultiAgentCommand(['auto-reelect', 'disable']),
    ],
    ['cdp allow', () => runCdpCommand(['allow'])],
  ];

  test.each(WRITES)('%s', async (_name, run) => {
    writeFileSync(configPath, BROKEN, 'utf8');
    const failure = await run().then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ConfigUnreadableError);
    expect((failure as Error).message).toBe(unreadableConfigMessage(problem()));
    expectUntouched();
  });

  test('cdp allow records no grant while the config is unreadable', async () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    await expect(runCdpCommand(['allow'])).rejects.toThrow(ConfigUnreadableError);
    expect(existsSync(grantFilePath())).toBe(false);
  });

  test.each([
    ['config get', () => runConfigCommand(['get'])],
    ['tools', async () => runToolsCommand([])],
    ['multi-agent', async () => runMultiAgentCommand([])],
  ] as [string, () => Promise<unknown>][])(
    'the read command %s reports the file instead of showing the defaults',
    async (_name, run) => {
      writeFileSync(configPath, BROKEN, 'utf8');
      await expect(run()).rejects.toThrow(unreadableConfigMessage(problem()));
      expectUntouched();
    },
  );
});

describe('every write command still writes a valid file as before (Unchanged)', () => {
  const START = { language: 'es', skipWelcome: true };
  const CASES: [string, () => Promise<unknown>, Record<string, unknown>][] = [
    [
      'config set cdp-direct.enabled',
      () => runConfigCommand(['set', 'cdp-direct.enabled', 'true']),
      { cdpDirectEnabled: true },
    ],
    [
      'config set cdp-direct.port',
      () => runConfigCommand(['set', 'cdp-direct.port', '9333']),
      { cdpDirectPort: 9333 },
    ],
    [
      'config set cdp-direct.grant-ttl',
      () => runConfigCommand(['set', 'cdp-direct.grant-ttl', '5']),
      { cdpDirectGrantTtlMinutes: 5 },
    ],
    [
      'config set downloads.max-mb',
      () => runConfigCommand(['set', 'downloads.max-mb', '10']),
      { downloadsMaxMb: 10 },
    ],
    [
      'config set map-learning',
      () => runConfigCommand(['set', 'map-learning', 'off']),
      { mapLearningEnabled: false },
    ],
    [
      'tools disable',
      async () => runToolsCommand(['disable', 'browser.click']),
      { disabledTools: ['browser.click'] },
    ],
    ['multi-agent disable', async () => runMultiAgentCommand(['disable']), { multiAgent: false }],
  ];

  test.each(CASES)('%s merges into the existing keys', async (_name, run, added) => {
    writeFileSync(configPath, JSON.stringify(START), 'utf8');
    await run();
    expect(readFileSync(configPath, 'utf8')).toBe(
      JSON.stringify({ ...START, ...added }, null, 2) + '\n',
    );
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('config set idle-ttl and flow-recording still write their value and timestamp', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
    await runConfigCommand(['set', 'idle-ttl', '15']);
    await runConfigCommand(['set', 'flow-recording', 'on']);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      idleTtlMinutes: 15,
      idleTtlUpdatedAt: 1_700_000_000_000,
      flowRecordingEnabled: true,
      flowRecordingUpdatedAt: 1_700_000_000_000,
    });
  });
});

describe('browser-link config restore-defaults (S6.4)', () => {
  const NOW = new Date('2026-11-11T10:20:30.123Z');
  const BACKUP = 'config.json.unreadable-2026-11-11T10-20-30-123Z';

  test('without --yes it changes nothing and says how to confirm', async () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    const p = problem();
    const out = await runConfigCommand(['restore-defaults']);
    expect(out).toBe(
      [
        `config.json could not be read: ${p.path}`,
        `  error: ${p.error}`,
        'Restoring keeps a copy of it next to it (config.json.unreadable-<date and time>), then writes the default settings; the custom settings in it stop applying until you re-enter them.',
        'Nothing was changed. Re-run with --yes to confirm:',
        '  browser-link config restore-defaults --yes',
      ].join('\n'),
    );
    expectUntouched();
  });

  test('with --yes it keeps a copy, writes the defaults and prints what happened', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    writeFileSync(configPath, BROKEN, 'utf8');
    const p = problem();
    const out = await runConfigCommand(['restore-defaults', '--yes']);
    expect(readFileSync(join(dataDir, BACKUP), 'utf8')).toBe(BROKEN);
    expect(readFileSync(configPath, 'utf8')).toBe('{}\n');
    expect(readdirSync(dataDir).sort()).toEqual([BACKUP, 'config.json'].sort());
    expect(out).toBe(
      formatRestoreResult(
        {
          restored: true,
          path: configPath,
          error: p.error,
          backupPath: join(dataDir, BACKUP),
          inEffect: defaultSettings(),
        },
        'en',
      ),
    );
    expect(out).toContain('Restored the default settings.');
    expect(out).toContain(join(dataDir, BACKUP));
    expect(out).toContain('The custom settings of the old file are no longer in effect.');
    for (const key of [
      'peerExecutablePaths',
      'allowedExtensionIds',
      'disabledTools',
      'multiAgent',
      'cdpDirectEnabled',
      'idleTtlMinutes',
      'language',
    ]) {
      expect(out).toContain(key);
    }
    expect(out).toContain('In effect now (the defaults):');
    expect(out).toMatch(/multiAgent\s+true/);
    expect(out).toMatch(/cdpDirectPort\s+9222/);
    expect(out).toMatch(/disabledTools\s+\[\]/);
    expect(out).toMatch(/peerExecutablePaths\s+not set/);
  });

  test('a valid config.json is left as it is, and the command says so', async () => {
    writeFileSync(configPath, '{"multiAgent":false}', 'utf8');
    for (const argv of [['restore-defaults'], ['restore-defaults', '--yes']]) {
      expect(await runConfigCommand(argv)).toBe(
        `config.json can be read (${configPath}): there is nothing to restore. Nothing was changed.`,
      );
    }
    expect(readFileSync(configPath, 'utf8')).toBe('{"multiAgent":false}');
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('a missing config.json stays missing, and the command says so', async () => {
    expect(await runConfigCommand(['restore-defaults', '--yes'])).toBe(
      `There is no config.json (${configPath}): the default settings are already in effect. Nothing was changed.`,
    );
    expect(readdirSync(dataDir)).toEqual([]);
  });

  test('the Spanish text names the same things', () => {
    const out = formatRestoreResult(
      {
        restored: true,
        path: '/d/config.json',
        error: 'bad',
        backupPath: '/d/config.json.unreadable-x',
        inEffect: defaultSettings(),
      },
      'es',
    );
    expect(out).toContain('Se restauró la configuración por defecto.');
    expect(out).toContain('/d/config.json.unreadable-x');
    expect(out).toContain('ya no está en efecto');
    expect(out).toContain('En efecto ahora (los valores por defecto):');
    expect(out).toMatch(/peerExecutablePaths\s+sin valor/);
  });

  test('the config command help names restore-defaults', async () => {
    await expect(runConfigCommand(['bogus'])).rejects.toThrow(/restore-defaults/);
  });
});
