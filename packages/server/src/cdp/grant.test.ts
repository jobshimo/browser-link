import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import {
  clearGrant,
  grantFilePath,
  isGrantLive,
  loadGrant,
  remainingMs,
  saveGrant,
} from './grant.js';

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-cdp-grant-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('loadGrant', () => {
  test('returns null when no grant file exists', () => {
    expect(loadGrant()).toBeNull();
  });

  test('returns null for a corrupt file instead of throwing', () => {
    saveGrant(30);
    writeFileSync(join(dataDir, 'cdp-grant.json'), 'not json', 'utf8');
    expect(loadGrant()).toBeNull();
  });

  test('returns null for well-formed JSON missing required fields', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'cdp-grant.json'), JSON.stringify({ foo: 1 }), 'utf8');
    expect(loadGrant()).toBeNull();
  });
});

describe('saveGrant / loadGrant round trip', () => {
  test('a positive ttl produces a finite expiresAt', () => {
    const now = 1_700_000_000_000;
    const grant = saveGrant(30, now);
    expect(grant.grantedAt).toBe(now);
    expect(grant.expiresAt).toBe(now + 30 * 60_000);
    expect(loadGrant()).toEqual(grant);
  });

  test('ttl 0 ("never") produces expiresAt: null', () => {
    const grant = saveGrant(0, 1_700_000_000_000);
    expect(grant.expiresAt).toBeNull();
    expect(loadGrant()).toEqual(grant);
  });

  test('saving again overwrites the previous grant', () => {
    saveGrant(10, 1_000);
    const second = saveGrant(20, 2_000);
    expect(loadGrant()).toEqual(second);
  });
});

describe('clearGrant', () => {
  test('removes an existing grant', () => {
    saveGrant(30);
    expect(loadGrant()).not.toBeNull();
    clearGrant();
    expect(loadGrant()).toBeNull();
  });

  test('is a no-op when nothing was granted', () => {
    expect(() => clearGrant()).not.toThrow();
    expect(loadGrant()).toBeNull();
  });

  test('surfaces (does NOT swallow) an unlink failure — security-critical', () => {
    // Put a DIRECTORY where the grant file goes: unlinkSync on a directory
    // throws on every OS (EISDIR on Linux/macOS, EPERM on Windows),
    // deterministically reproducing the "grant file can't be removed"
    // failure the reviewer flagged, without a flaky real file lock. A
    // swallowed error here would let the gate keep honouring a "revoked"
    // grant.
    mkdirSync(grantFilePath(), { recursive: true });
    expect(() => clearGrant()).toThrow();
  });
});

test('grantFilePath resolves inside the data dir', () => {
  expect(grantFilePath()).toBe(join(dataDir, 'cdp-grant.json'));
});

describe('isGrantLive', () => {
  test('null grant is never live', () => {
    expect(isGrantLive(null)).toBe(false);
  });

  test('a never-expiring grant is always live', () => {
    const grant = { grantedAt: 0, expiresAt: null };
    expect(isGrantLive(grant, 999_999_999_999)).toBe(true);
  });

  test('a grant is live strictly before its expiresAt', () => {
    const grant = { grantedAt: 0, expiresAt: 1_000 };
    expect(isGrantLive(grant, 999)).toBe(true);
    expect(isGrantLive(grant, 1_000)).toBe(false);
    expect(isGrantLive(grant, 1_001)).toBe(false);
  });
});

describe('remainingMs', () => {
  test('null grant has no remaining time', () => {
    expect(remainingMs(null)).toBeNull();
  });

  test('a never-expiring grant has no remaining time (null, not Infinity)', () => {
    expect(remainingMs({ grantedAt: 0, expiresAt: null }, 5_000)).toBeNull();
  });

  test('computes remaining ms for a finite grant', () => {
    expect(remainingMs({ grantedAt: 0, expiresAt: 10_000 }, 4_000)).toBe(6_000);
  });

  test('never reports negative remaining time for an expired grant', () => {
    expect(remainingMs({ grantedAt: 0, expiresAt: 1_000 }, 5_000)).toBe(0);
  });
});
