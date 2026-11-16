import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from './map/paths.js';
import {
  ConfigUnreadableError,
  configReadRetry,
  DEFAULT_CDP_DIRECT_PORT,
  DEFAULT_DOWNLOADS_MAX_MB,
  DEFAULT_GRANT_TTL_MINUTES,
  defaultSettings,
  loadConfig,
  readConfig,
  restoreDefaultConfig,
  saveConfig,
  unreadableConfigMessage,
} from './config.js';

/* S6: an unreadable config.json (exists but cannot be read, does not parse,
 * or is not a JSON object) is a state of its own, never the defaults. A
 * missing file is the defaults, as before. */

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;
let configPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-unreadable-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  configPath = join(dataDir, 'config.json');
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

const BROKEN = '{ "disabledTools": ["browser.evaluate"], ';

describe('readConfig reports ok, missing and unreadable (S6.1)', () => {
  test('a missing file is "missing", with the path and the defaults', () => {
    const result = readConfig();
    expect(result).toEqual({ state: 'missing', path: configPath, config: loadConfig() });
  });

  test('a valid file is "ok", with the path and the effective config', () => {
    writeFileSync(configPath, JSON.stringify({ multiAgent: false }), 'utf8');
    const result = readConfig();
    expect(result.state).toBe('ok');
    expect(result.path).toBe(configPath);
    expect(result.state === 'ok' && result.config.multiAgent).toBe(false);
  });

  test('a file that does not parse is "unreadable", with the path and the parse error', () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    let parseError = '';
    try {
      JSON.parse(BROKEN);
    } catch (err) {
      parseError = (err as Error).message;
    }
    expect(readConfig()).toEqual({ state: 'unreadable', path: configPath, error: parseError });
  });

  test.each([
    ['null', 'null'],
    ['an array', '["browser.evaluate"]'],
    ['a string', '"hello"'],
    ['a number', '42'],
    ['an empty file', ''],
  ])('a file holding %s is "unreadable"', (_label, contents) => {
    writeFileSync(configPath, contents, 'utf8');
    const result = readConfig();
    expect(result.state).toBe('unreadable');
    expect(result.path).toBe(configPath);
    expect(result.state === 'unreadable' && result.error.length > 0).toBe(true);
  });

  test('a config.json that exists but cannot be read (a directory) is "unreadable"', () => {
    mkdirSync(configPath);
    const result = readConfig();
    expect(result.state).toBe('unreadable');
    expect(result.state === 'unreadable' && result.error).toMatch(/EISDIR|EPERM|EACCES/);
  });

  test('the error never carries control characters or line breaks into a log line', () => {
    writeFileSync(configPath, `{"a": "x${String.fromCharCode(7, 0x2028)}`, 'utf8');
    const result = readConfig();
    expect(result.state).toBe('unreadable');
    const error = result.state === 'unreadable' ? result.error : '';
    const unprintable = new RegExp(`[\x00-\x1f\x7f-\x9f${String.fromCharCode(0x2028, 0x2029)}]`);
    expect(unprintable.test(error)).toBe(false);
  });

  test('loadConfig throws ConfigUnreadableError instead of returning the defaults', () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    const read = readConfig();
    expect(() => loadConfig()).toThrow(ConfigUnreadableError);
    expect(() => loadConfig()).toThrow(
      unreadableConfigMessage(read as Extract<typeof read, { state: 'unreadable' }>),
    );
  });

  test('loadConfig no longer warns "Using defaults" for an unreadable file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(configPath, BROKEN, 'utf8');
    expect(() => loadConfig()).toThrow(ConfigUnreadableError);
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/Using defaults/);
  });
});

describe('the refusal message names the file, the error and both ways out (S6.2)', () => {
  test('exact text', () => {
    expect(unreadableConfigMessage({ path: '/data/config.json', error: 'Unexpected end' })).toBe(
      'browser-link refuses to work: its config file /data/config.json cannot be read (Unexpected end). ' +
        'It will not guess your settings (disabled tools, allowed extension ids, strict mode) from a broken file. ' +
        'Two ways out: fix the file by hand so it holds one JSON object, or run ' +
        '`browser-link config restore-defaults` to keep a copy of it and start again from the default settings.',
    );
  });

  test('ConfigUnreadableError carries the path and the error, and its message is that text', () => {
    const err = new ConfigUnreadableError({ path: '/p/config.json', error: 'bad' });
    expect(err.path).toBe('/p/config.json');
    expect(err.error).toBe('bad');
    expect(err.message).toBe(unreadableConfigMessage({ path: '/p/config.json', error: 'bad' }));
  });
});

describe('saveConfig never overwrites an unreadable file (S6.3)', () => {
  test('it throws the refusal and leaves the bytes and the folder as they were', () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    expect(() => saveConfig({ multiAgent: false })).toThrow(ConfigUnreadableError);
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('a missing file is still created with the patch (unchanged)', () => {
    saveConfig({ multiAgent: false });
    expect(readFileSync(configPath, 'utf8')).toBe(
      JSON.stringify({ multiAgent: false }, null, 2) + '\n',
    );
  });

  test('a valid file is still merged with the patch (unchanged)', () => {
    writeFileSync(configPath, JSON.stringify({ language: 'es' }), 'utf8');
    saveConfig({ skipWelcome: true });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      language: 'es',
      skipWelcome: true,
    });
  });
});

describe('restoreDefaultConfig (S6.4)', () => {
  const NOW = new Date('2026-11-11T10:20:30.123Z');
  const BACKUP = 'config.json.unreadable-2026-11-11T10-20-30-123Z';

  test('copies the unreadable file next to it, then writes a fresh default config', () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    const before = readConfig();
    const result = restoreDefaultConfig(NOW);
    expect(result).toEqual({
      restored: true,
      path: configPath,
      error: before.state === 'unreadable' ? before.error : 'not unreadable',
      backupPath: join(dataDir, BACKUP),
      inEffect: defaultSettings(),
    });
    expect(readFileSync(join(dataDir, BACKUP), 'utf8')).toBe(BROKEN);
    expect(readFileSync(configPath, 'utf8')).toBe('{}\n');
    expect(readConfig()).toEqual({ state: 'ok', path: configPath, config: loadConfig() });
    expect(readdirSync(dataDir).sort()).toEqual([BACKUP, 'config.json'].sort());
  });

  test('the restored config reads exactly as a missing one', () => {
    const missing = loadConfig();
    writeFileSync(configPath, BROKEN, 'utf8');
    restoreDefaultConfig(NOW);
    expect(loadConfig()).toEqual(missing);
  });

  test('a valid file is left untouched and nothing is copied', () => {
    const valid = JSON.stringify({ multiAgent: false });
    writeFileSync(configPath, valid, 'utf8');
    expect(restoreDefaultConfig(NOW)).toEqual({ restored: false, state: 'ok', path: configPath });
    expect(readFileSync(configPath, 'utf8')).toBe(valid);
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('a missing file stays missing', () => {
    expect(restoreDefaultConfig(NOW)).toEqual({
      restored: false,
      state: 'missing',
      path: configPath,
    });
    expect(readdirSync(dataDir)).toEqual([]);
  });

  test('when the copy cannot be made, nothing is written and the error says so', () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    // A copy with the same timestamp already exists: the copy refuses to
    // overwrite it, so the restore must stop before writing.
    writeFileSync(join(dataDir, BACKUP), 'older copy', 'utf8');
    expect(() => restoreDefaultConfig(NOW)).toThrow(/Nothing was changed/);
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
    expect(readFileSync(join(dataDir, BACKUP), 'utf8')).toBe('older copy');
  });
});

describe('defaultSettings is derived from the loader, not hand-copied (S6.4)', () => {
  test('every value equals what an empty config reads as', () => {
    const empty = loadConfig();
    const d = defaultSettings();
    expect(d.multiAgent).toBe(empty.multiAgent);
    expect(d.autoReelect).toBe(empty.autoReelect);
    expect(d.cdpDirectEnabled).toBe(empty.cdpDirectEnabled);
    expect(d.cdpDirectPort).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(d.cdpDirectGrantTtlMinutes).toBe(DEFAULT_GRANT_TTL_MINUTES);
    expect(d.instructionsAutoRefresh).toBe(true);
    expect(d.noticeAcknowledged).toBe(false);
    expect(d.downloadsMaxMb).toBe(DEFAULT_DOWNLOADS_MAX_MB);
    expect(d.disabledTools).toEqual([]);
    expect(d.allowedExtensionIds).toEqual([]);
    expect(d.peerExecutablePaths).toBeUndefined();
    expect(d.idleTtlMinutes).toBeUndefined();
    expect(d.language).toBe('en');
  });

  test('it names every key a config.json can persist', () => {
    expect(Object.keys(defaultSettings()).sort()).toEqual(
      [
        'activityEnabled',
        'activityRecordPayloads',
        'allowedExtensionIds',
        'autoReelect',
        'cdpDirectEnabled',
        'cdpDirectGrantTtlMinutes',
        'cdpDirectPort',
        'disabledTools',
        'downloadsDir',
        'downloadsMaxMb',
        'flowRecordingEnabled',
        'flowRecordingUpdatedAt',
        'idleTtlMinutes',
        'idleTtlUpdatedAt',
        'instructionsAutoRefresh',
        'language',
        'mapLearningEnabled',
        'multiAgent',
        'noticeAcknowledged',
        'peerExecutablePaths',
        'skipWelcome',
      ].sort(),
    );
  });
});

describe('Unchanged: missing, valid and mistyped files read as at 295a57d', () => {
  test('a mistyped value is still decided by the sanitizers, not refused', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ cdpDirectPort: '9222@attacker.com', peerExecutablePaths: 'oops' }),
      'utf8',
    );
    expect(readConfig().state).toBe('ok');
    const cfg = loadConfig();
    expect(cfg.cdpDirectPort).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(cfg.peerExecutablePaths).toEqual([]);
  });
});

describe('a UTF-8 byte order mark is not an error; UTF-16 is explained (S6.0)', () => {
  const BOM = '﻿';
  const utf16le = (text: string): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const utf16be = (text: string): Buffer => {
    const le = Buffer.from(text, 'utf16le');
    le.swap16();
    return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
  };

  test('BOM + a valid object loads as ok with the same config as without the BOM', () => {
    const json = JSON.stringify({ multiAgent: false, disabledTools: ['browser.evaluate'] });
    writeFileSync(configPath, json, 'utf8');
    const plain = readConfig();
    writeFileSync(configPath, BOM + json, 'utf8');
    const withBom = readConfig();
    expect(withBom.state).toBe('ok');
    expect(withBom).toEqual(plain);
  });

  test('saveConfig on a BOM file merges and writes a file that does not start with EF BB BF', () => {
    writeFileSync(configPath, BOM + JSON.stringify({ multiAgent: false }), 'utf8');
    saveConfig({ disabledTools: ['browser.evaluate'] });
    const written = readFileSync(configPath);
    expect(written.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const parsed = JSON.parse(written.toString('utf8')) as Record<string, unknown>;
    expect(parsed.multiAgent).toBe(false);
    expect(parsed.disabledTools).toEqual(['browser.evaluate']);
  });

  test('BOM + invalid JSON is still unreadable, and the error has no U+FEFF', () => {
    writeFileSync(configPath, BOM + BROKEN, 'utf8');
    const result = readConfig();
    expect(result.state).toBe('unreadable');
    expect(result.state === 'unreadable' && result.error.includes(BOM)).toBe(false);
  });

  test.each([
    ['UTF-16LE', utf16le],
    ['UTF-16BE', utf16be],
  ])('%s with a BOM is unreadable and the error says UTF-16 and UTF-8', (_label, encode) => {
    writeFileSync(configPath, encode(JSON.stringify({ multiAgent: false })));
    const result = readConfig();
    expect(result.state).toBe('unreadable');
    const error = result.state === 'unreadable' ? result.error : '';
    expect(error).toMatch(/UTF-16/);
    expect(error).toMatch(/UTF-8/);
    expect(error.includes(BOM)).toBe(false);
    expect(() => saveConfig({ multiAgent: true })).toThrow(ConfigUnreadableError);
  });

  test('a file without a BOM: valid still loads, invalid keeps the plain parse error', () => {
    writeFileSync(configPath, JSON.stringify({ multiAgent: false }), 'utf8');
    const ok = readConfig();
    expect(ok.state === 'ok' && ok.config.multiAgent).toBe(false);
    writeFileSync(configPath, BROKEN, 'utf8');
    let parseError = '';
    try {
      JSON.parse(BROKEN);
    } catch (err) {
      parseError = (err as Error).message;
    }
    expect(readConfig()).toEqual({ state: 'unreadable', path: configPath, error: parseError });
  });
});

describe('a read that can pass by itself is retried, a bad file is not (S6.8)', () => {
  const real = { ...configReadRetry };
  afterEach(() => {
    Object.assign(configReadRetry, real);
  });

  function failing(code: string, failures: number, calls: { n: number }) {
    configReadRetry.sleep = vi.fn();
    configReadRetry.readFile = (path: string) => {
      calls.n++;
      if (calls.n <= failures) throw Object.assign(new Error(`${code}: busy`), { code });
      return real.readFile(path);
    };
  }

  test('a transient error followed by a good read loads as ok', () => {
    writeFileSync(configPath, JSON.stringify({ multiAgent: false }), 'utf8');
    const calls = { n: 0 };
    failing('EBUSY', 2, calls);
    expect(readConfig().state).toBe('ok');
    expect(calls.n).toBe(3);
    expect(configReadRetry.sleep).toHaveBeenCalledTimes(2);
  });

  test.each(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE'])(
    '%s on every try ends unreadable after exactly the bounded number of tries',
    (code) => {
      writeFileSync(configPath, '{}', 'utf8');
      const calls = { n: 0 };
      failing(code, Infinity, calls);
      const result = readConfig();
      expect(result.state).toBe('unreadable');
      expect(calls.n).toBe(configReadRetry.attempts);
      expect(configReadRetry.sleep).toHaveBeenCalledTimes(configReadRetry.attempts - 1);
    },
  );

  test('the total wait is small', () => {
    expect((real.attempts - 1) * real.waitMs).toBeLessThanOrEqual(250);
  });

  test('a file that does not parse is read once', () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    const calls = { n: 0 };
    failing('EBUSY', 0, calls);
    expect(readConfig().state).toBe('unreadable');
    expect(calls.n).toBe(1);
    expect(configReadRetry.sleep).not.toHaveBeenCalled();
  });

  test.each(['ENOENT', 'ENOTDIR'])('%s is "missing" and read once', (code) => {
    const calls = { n: 0 };
    failing(code, Infinity, calls);
    expect(readConfig().state).toBe('missing');
    expect(calls.n).toBe(1);
    expect(configReadRetry.sleep).not.toHaveBeenCalled();
  });
});
