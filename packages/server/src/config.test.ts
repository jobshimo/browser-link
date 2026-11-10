import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from './map/paths.js';
import {
  DEFAULT_CDP_DIRECT_PORT,
  DEFAULT_DOWNLOADS_MAX_MB,
  MAX_DOWNLOADS_MAX_MB,
  DEFAULT_GRANT_TTL_MINUTES,
  DEFAULT_IDLE_TTL_MINUTES,
  clampCdpDirectPort,
  clampGrantTtlMinutes,
  clampIdleTtlMinutes,
  loadConfig,
  sanitizeCdpPort,
  sanitizeDownloadsMaxMb,
  sanitizePeerExecutablePaths,
  saveConfig,
} from './config.js';
import { applyAdminAction } from './admin/actions.js';
import type { AdminInput } from './admin/descriptor.js';

// Pass-through spies on the two write primitives so the atomic-write test
// can observe which paths saveConfig targets. Every other test sees the
// real behaviour.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

describe('clampGrantTtlMinutes', () => {
  test('0 ("never") passes through untouched', () => {
    expect(clampGrantTtlMinutes(0)).toBe(0);
  });

  test('an in-range integer passes through untouched', () => {
    expect(clampGrantTtlMinutes(120)).toBe(120);
  });

  test('a non-integer falls back to the default (not snapped to a boundary)', () => {
    expect(clampGrantTtlMinutes(30.5)).toBe(DEFAULT_GRANT_TTL_MINUTES);
  });

  test('NaN/Infinity fall back to the default', () => {
    expect(clampGrantTtlMinutes(NaN)).toBe(DEFAULT_GRANT_TTL_MINUTES);
    expect(clampGrantTtlMinutes(Infinity)).toBe(DEFAULT_GRANT_TTL_MINUTES);
  });

  test('an out-of-range value falls back to the default (not clamped to a boundary)', () => {
    expect(clampGrantTtlMinutes(99999)).toBe(DEFAULT_GRANT_TTL_MINUTES);
    expect(clampGrantTtlMinutes(-5)).toBe(DEFAULT_GRANT_TTL_MINUTES);
  });
});

describe('clampCdpDirectPort', () => {
  test('an in-range integer passes through untouched', () => {
    expect(clampCdpDirectPort(9333)).toBe(9333);
  });

  test('a non-integer falls back to the default port', () => {
    expect(clampCdpDirectPort(9222.5)).toBe(DEFAULT_CDP_DIRECT_PORT);
  });

  test('an out-of-range value falls back to the default port', () => {
    expect(clampCdpDirectPort(0)).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(clampCdpDirectPort(70000)).toBe(DEFAULT_CDP_DIRECT_PORT);
  });
});

describe('sanitizeCdpPort (SSRF trust-boundary sanitizer)', () => {
  test('a valid custom port is used as-is', () => {
    expect(sanitizeCdpPort(9333)).toBe(9333);
    expect(sanitizeCdpPort('9333')).toBe(9333); // numeric string coerces cleanly
  });

  test('the userinfo-breakout string falls back to the default (NOT parsed as 9222)', () => {
    // parseInt("9222@attacker.com") would have returned 9222 and quietly
    // accepted it — Number() returns NaN, so it is rejected.
    expect(sanitizeCdpPort('9222@attacker.com')).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort('9222/x')).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort('9222 evil')).toBe(DEFAULT_CDP_DIRECT_PORT);
  });

  test('out-of-range, non-integer, NaN and non-number all fall back to the default', () => {
    expect(sanitizeCdpPort(0)).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort(70000)).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort(9222.5)).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort(NaN)).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort(Infinity)).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort(null)).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort(undefined)).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort({})).toBe(DEFAULT_CDP_DIRECT_PORT);
    expect(sanitizeCdpPort('not a port')).toBe(DEFAULT_CDP_DIRECT_PORT);
  });

  test('loadConfig neutralizes a malicious config.json port at the read boundary', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-ssrf-'));
    const spy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
    try {
      // Hand-write a hostile config.json directly (bypassing the typed
      // saveConfig) to simulate a corrupted / tampered file.
      writeFileSync(
        join(dataDir, 'config.json'),
        JSON.stringify({ cdpDirectPort: '9222@attacker.com' }) + '\n',
        'utf8',
      );
      // cfg.cdpDirectPort is a valid integer by construction after load.
      expect(loadConfig().cdpDirectPort).toBe(DEFAULT_CDP_DIRECT_PORT);
    } finally {
      spy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig neutralizes corrupted numeric fields at the read boundary', () => {
  let dataDir: string;
  let getDataDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-clamp-'));
    getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  });

  afterEach(() => {
    getDataDirSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeRawConfig(contents: Record<string, unknown>): void {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(contents) + '\n', 'utf8');
  }

  describe('idleTtlMinutes', () => {
    test('a string value falls back to the default', () => {
      writeRawConfig({ idleTtlMinutes: 'abc' });
      expect(loadConfig().idleTtlMinutes).toBe(DEFAULT_IDLE_TTL_MINUTES);
    });

    test('a negative value falls back to the default', () => {
      writeRawConfig({ idleTtlMinutes: -5 });
      expect(loadConfig().idleTtlMinutes).toBe(DEFAULT_IDLE_TTL_MINUTES);
    });

    test('a float value falls back to the default', () => {
      writeRawConfig({ idleTtlMinutes: 1.5 });
      expect(loadConfig().idleTtlMinutes).toBe(DEFAULT_IDLE_TTL_MINUTES);
    });

    test('an absurdly large value falls back to the default', () => {
      writeRawConfig({ idleTtlMinutes: 1e9 });
      expect(loadConfig().idleTtlMinutes).toBe(DEFAULT_IDLE_TTL_MINUTES);
    });

    test('0 ("never") survives the clamp — it is a real value, not garbage', () => {
      writeRawConfig({ idleTtlMinutes: 0 });
      expect(loadConfig().idleTtlMinutes).toBe(0);
    });

    test('a value never written by the CLI stays undefined (not defaulted)', () => {
      writeRawConfig({});
      expect(loadConfig().idleTtlMinutes).toBeUndefined();
    });
  });

  describe('cdpDirectGrantTtlMinutes', () => {
    test('a string value falls back to the default', () => {
      writeRawConfig({ cdpDirectGrantTtlMinutes: 'abc' });
      expect(loadConfig().cdpDirectGrantTtlMinutes).toBe(DEFAULT_GRANT_TTL_MINUTES);
    });

    test('a negative value falls back to the default', () => {
      writeRawConfig({ cdpDirectGrantTtlMinutes: -5 });
      expect(loadConfig().cdpDirectGrantTtlMinutes).toBe(DEFAULT_GRANT_TTL_MINUTES);
    });

    test('a float value falls back to the default', () => {
      writeRawConfig({ cdpDirectGrantTtlMinutes: 1.5 });
      expect(loadConfig().cdpDirectGrantTtlMinutes).toBe(DEFAULT_GRANT_TTL_MINUTES);
    });

    test('an absurdly large value falls back to the default', () => {
      writeRawConfig({ cdpDirectGrantTtlMinutes: 1e9 });
      expect(loadConfig().cdpDirectGrantTtlMinutes).toBe(DEFAULT_GRANT_TTL_MINUTES);
    });

    test('0 ("never") survives the clamp — it is a real value, not garbage', () => {
      writeRawConfig({ cdpDirectGrantTtlMinutes: 0 });
      expect(loadConfig().cdpDirectGrantTtlMinutes).toBe(0);
    });
  });

  test('clampIdleTtlMinutes and clampGrantTtlMinutes agree on the "0 is never" contract', () => {
    // Both clamps must treat 0 identically — sanity check the shared
    // contract the two describe blocks above each exercise in isolation.
    expect(clampIdleTtlMinutes(0)).toBe(0);
    expect(clampGrantTtlMinutes(0)).toBe(0);
  });
});

describe('cdp-direct config defaults + persistence', () => {
  let dataDir: string;
  let getDataDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-cdp-'));
    getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  });

  afterEach(() => {
    getDataDirSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('defaults on a fresh install: disabled, port 9222, grant-ttl 60', () => {
    const cfg = loadConfig();
    expect(cfg.cdpDirectEnabled).toBe(false);
    expect(cfg.cdpDirectPort).toBe(9222);
    expect(cfg.cdpDirectGrantTtlMinutes).toBe(60);
  });

  test('saveConfig persists an explicit override and loadConfig reflects it', () => {
    saveConfig({ cdpDirectEnabled: true, cdpDirectPort: 9333, cdpDirectGrantTtlMinutes: 15 });
    const cfg = loadConfig();
    expect(cfg.cdpDirectEnabled).toBe(true);
    expect(cfg.cdpDirectPort).toBe(9333);
    expect(cfg.cdpDirectGrantTtlMinutes).toBe(15);
  });

  test('values matching the runtime default are stripped from the on-disk file', () => {
    // Write an override, then write it back to the default — the field
    // should vanish from config.json rather than linger as an explicit
    // "false"/9222/60, keeping the file diff-friendly (idle-ttl's
    // normaliseForWrite does the same for multiAgent/autoReelect).
    saveConfig({ cdpDirectEnabled: true, cdpDirectPort: 9333, cdpDirectGrantTtlMinutes: 15 });
    saveConfig({ cdpDirectEnabled: false, cdpDirectPort: 9222, cdpDirectGrantTtlMinutes: 60 });
    const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw).not.toHaveProperty('cdpDirectEnabled');
    expect(raw).not.toHaveProperty('cdpDirectPort');
    expect(raw).not.toHaveProperty('cdpDirectGrantTtlMinutes');
    // loadConfig still reports the (default) values regardless of whether
    // they were stripped from disk — that's the point of withDefaults().
    const cfg = loadConfig();
    expect(cfg.cdpDirectEnabled).toBe(false);
    expect(cfg.cdpDirectPort).toBe(9222);
    expect(cfg.cdpDirectGrantTtlMinutes).toBe(60);
  });

  test('grant-ttl 0 ("never") is a real value, not the stripped default', () => {
    saveConfig({ cdpDirectGrantTtlMinutes: 0 });
    expect(loadConfig().cdpDirectGrantTtlMinutes).toBe(0);
  });
});

describe('instructionsAutoRefresh', () => {
  let dataDir: string;
  let getDataDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-instr-'));
    getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  });

  afterEach(() => {
    getDataDirSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('defaults to true on a fresh install', () => {
    expect(loadConfig().instructionsAutoRefresh).toBe(true);
  });

  test('an explicit false is respected and persisted', () => {
    saveConfig({ instructionsAutoRefresh: false });
    expect(loadConfig().instructionsAutoRefresh).toBe(false);
    const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw.instructionsAutoRefresh).toBe(false);
  });

  test('a hand-written false in config.json is respected', () => {
    writeFileSync(join(dataDir, 'config.json'), '{"instructionsAutoRefresh": false}');
    expect(loadConfig().instructionsAutoRefresh).toBe(false);
  });

  test('true is the default and is stripped from the on-disk file', () => {
    saveConfig({ instructionsAutoRefresh: false });
    saveConfig({ instructionsAutoRefresh: true });
    const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw).not.toHaveProperty('instructionsAutoRefresh');
    expect(loadConfig().instructionsAutoRefresh).toBe(true);
  });
});

describe('noticeAcknowledged', () => {
  let dataDir: string;
  let getDataDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-notice-'));
    getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  });

  afterEach(() => {
    getDataDirSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function rawFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  test('defaults to false on a fresh install', () => {
    expect(loadConfig().noticeAcknowledged).toBe(false);
  });

  test('an acknowledgement is persisted as true', () => {
    saveConfig({ noticeAcknowledged: true });
    expect(loadConfig().noticeAcknowledged).toBe(true);
    expect(rawFile().noticeAcknowledged).toBe(true);
  });

  test('false is never written to disk', () => {
    saveConfig({ noticeAcknowledged: false, skipWelcome: true });
    expect(rawFile()).not.toHaveProperty('noticeAcknowledged');
    expect(loadConfig().noticeAcknowledged).toBe(false);
  });

  test('a hand-written non-boolean reads as not acknowledged', () => {
    writeFileSync(join(dataDir, 'config.json'), '{"noticeAcknowledged": "yes"}');
    expect(loadConfig().noticeAcknowledged).toBe(false);
  });

  test('skipWelcome is unaffected by the acknowledgement', () => {
    saveConfig({ skipWelcome: true });
    saveConfig({ noticeAcknowledged: true });
    expect(loadConfig().skipWelcome).toBe(true);
    expect(rawFile()).toEqual({ skipWelcome: true, noticeAcknowledged: true });
  });
});

describe('mapLearningEnabled', () => {
  let dataDir: string;
  let getDataDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-learning-'));
    getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  });

  afterEach(() => {
    getDataDirSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('is absent on a fresh install (the learner treats absent as on)', () => {
    expect(loadConfig().mapLearningEnabled).toBeUndefined();
  });

  test('an explicit false is persisted and read back', () => {
    saveConfig({ mapLearningEnabled: false });
    expect(loadConfig().mapLearningEnabled).toBe(false);
    expect(
      JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>,
    ).toEqual({ mapLearningEnabled: false });
  });

  test('clearing it removes the key from disk', () => {
    saveConfig({ mapLearningEnabled: false, skipWelcome: true });
    saveConfig({ mapLearningEnabled: undefined });
    expect(
      JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>,
    ).toEqual({ skipWelcome: true });
  });
});

describe('downloadsMaxMb', () => {
  let dataDir: string;
  let getDataDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-download-cap-'));
    getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  });

  afterEach(() => {
    getDataDirSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('is absent on a fresh install and sanitizes to the 25 MiB default', () => {
    expect(loadConfig().downloadsMaxMb).toBeUndefined();
    expect(DEFAULT_DOWNLOADS_MAX_MB).toBe(25);
    expect(sanitizeDownloadsMaxMb(loadConfig().downloadsMaxMb)).toBe(25);
  });

  test('a set value is persisted, and clearing it removes the key from disk', () => {
    saveConfig({ downloadsMaxMb: 50, skipWelcome: true });
    expect(loadConfig().downloadsMaxMb).toBe(50);
    saveConfig({ downloadsMaxMb: undefined });
    expect(
      JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>,
    ).toEqual({ skipWelcome: true });
  });

  test('the sanitizer passes [1, 64] and refuses everything else', () => {
    expect(MAX_DOWNLOADS_MAX_MB).toBe(64);
    expect(sanitizeDownloadsMaxMb(1)).toBe(1);
    expect(sanitizeDownloadsMaxMb(64)).toBe(64);
    for (const raw of [0, 65, 501, -1, 2.5, '50', null, undefined, Number.NaN, Infinity]) {
      expect(sanitizeDownloadsMaxMb(raw)).toBe(DEFAULT_DOWNLOADS_MAX_MB);
    }
  });
});

describe('saveConfig writes config.json atomically', () => {
  let dataDir: string;
  let getDataDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-atomic-'));
    getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.renameSync).mockClear();
  });

  afterEach(() => {
    getDataDirSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('never writes config.json in place: a sibling temp file is renamed over it', () => {
    const target = join(dataDir, 'config.json');
    saveConfig({ skipWelcome: true });
    saveConfig({ mapLearningEnabled: false });

    const written = vi.mocked(fs.writeFileSync).mock.calls.map((c) => String(c[0]));
    expect(written).toHaveLength(2);
    expect(written).not.toContain(target);
    for (const path of written) {
      expect(path.startsWith(`${target}.${process.pid}-`)).toBe(true);
      expect(path.slice(target.length)).toMatch(/^\.\d+-\d+\.tmp$/);
    }
    const renames = vi.mocked(fs.renameSync).mock.calls.map((c) => [String(c[0]), String(c[1])]);
    expect(renames).toEqual(written.map((tmp) => [tmp, target]));
    // No temp file is left behind after a successful save.
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('the bytes on disk are unchanged: two-space JSON, normalised, trailing newline', () => {
    saveConfig({ skipWelcome: true, downloadsMaxMb: 50 });
    const cfg = saveConfig({ instructionsAutoRefresh: false });
    expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).toBe(
      JSON.stringify(
        { skipWelcome: true, downloadsMaxMb: 50, instructionsAutoRefresh: false },
        null,
        2,
      ) + '\n',
    );
    expect(cfg).toEqual(loadConfig());
  });
});

describe('peerExecutablePaths (opt-in strict mode, hand-edited only)', () => {
  let dataDir: string;
  let getDataDirSpy: ReturnType<typeof vi.spyOn>;
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-peer-paths-'));
    getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  });

  afterEach(() => {
    getDataDirSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeConfig(contents: Record<string, unknown>): void {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(contents) + '\n', 'utf8');
  }

  test('absent or an empty array means no path check (undefined)', () => {
    expect(sanitizePeerExecutablePaths(undefined, 'win32')).toBeUndefined();
    expect(sanitizePeerExecutablePaths(null, 'win32')).toBeUndefined();
    expect(sanitizePeerExecutablePaths([], 'win32')).toBeUndefined();
    expect(loadConfig().peerExecutablePaths).toBeUndefined();
  });

  test('absolute string entries are kept, in order', () => {
    expect(sanitizePeerExecutablePaths([CHROME, 'D:\\b\\brave.exe'], 'win32')).toEqual([
      CHROME,
      'D:\\b\\brave.exe',
    ]);
    expect(sanitizePeerExecutablePaths(['/opt/google/chrome/chrome'], 'linux')).toEqual([
      '/opt/google/chrome/chrome',
    ]);
  });

  test('relative or non-string entries are dropped, and strict mode stays on (fail closed)', () => {
    expect(sanitizePeerExecutablePaths(['chrome.exe', 42, CHROME], 'win32')).toEqual([CHROME]);
    expect(sanitizePeerExecutablePaths(['chrome.exe'], 'win32')).toEqual([]);
    expect(sanitizePeerExecutablePaths(['C:\\x\\chrome.exe'], 'linux')).toEqual([]);
  });

  test('a value that is not an array keeps strict mode on with nothing allowed', () => {
    expect(sanitizePeerExecutablePaths(CHROME, 'win32')).toEqual([]);
    expect(sanitizePeerExecutablePaths({ 0: CHROME }, 'win32')).toEqual([]);
  });

  test('loadConfig applies the sanitizer to a hand-edited config.json', () => {
    const abs = process.platform === 'win32' ? CHROME : '/opt/google/chrome/chrome';
    writeConfig({ peerExecutablePaths: ['relative', abs] });
    expect(loadConfig().peerExecutablePaths).toEqual([abs]);
  });

  test('saving another key keeps the hand-edited list on disk untouched', () => {
    writeConfig({ peerExecutablePaths: ['relative', CHROME] });
    saveConfig({ mapLearningEnabled: false });
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk.peerExecutablePaths).toEqual(['relative', CHROME]);
  });

  test('the admin panel cannot write it: admin.action is refused and nothing is saved', async () => {
    const saveSpy = vi.fn();
    const input = async (): Promise<AdminInput> => ({
      config: loadConfig(),
      now: Date.parse('2026-11-10T12:00:00.000Z'),
      version: '0.50.0',
      server: { running: null, installed: '0.50.0', outdated: false },
      tabsConnected: 1,
      ports: { ws: 17529, ipc: 17530 },
      extension: { path: null, connectedVersion: '0.50.0' },
      instructions: [],
      clients: [],
      cdpGrant: { live: false, remainingMs: null },
      update: null,
      toolNames: [],
      downloadsDir: '/d',
    });
    const res = await applyAdminAction(
      { id: 'peerExecutablePaths', value: CHROME, confirm: true },
      {
        input,
        doctor: () => Promise.resolve([]),
        checkUpdates: () => Promise.resolve([]),
        helpers: { saveConfig: saveSpy },
      },
    );
    expect(res.ok).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(loadConfig().peerExecutablePaths).toBeUndefined();
  });
});
