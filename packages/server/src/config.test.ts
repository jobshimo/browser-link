import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from './map/paths.js';
import {
  DEFAULT_CDP_DIRECT_PORT,
  DEFAULT_GRANT_TTL_MINUTES,
  clampCdpDirectPort,
  clampGrantTtlMinutes,
  loadConfig,
  sanitizeCdpPort,
  saveConfig,
} from './config.js';

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
