import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import { saveConfig } from '../config.js';
import { saveGrant } from './grant.js';
import {
  CDP_DIRECT_DISABLED_ERROR,
  CDP_DIRECT_NO_GRANT_ERROR,
  checkCdpDirectGate,
} from './gate.js';

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-cdp-gate-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('checkCdpDirectGate', () => {
  test('fails with the exact disabled-error text on a fresh install', () => {
    const result = checkCdpDirectGate();
    expect(result).toEqual({ ok: false, error: CDP_DIRECT_DISABLED_ERROR });
  });

  test('fails with the exact disabled-error text even when a grant exists', () => {
    saveGrant(60);
    const result = checkCdpDirectGate();
    expect(result).toEqual({ ok: false, error: CDP_DIRECT_DISABLED_ERROR });
  });

  test('fails with the exact no-grant-error text once enabled with no grant', () => {
    saveConfig({ cdpDirectEnabled: true });
    const result = checkCdpDirectGate();
    expect(result).toEqual({ ok: false, error: CDP_DIRECT_NO_GRANT_ERROR });
  });

  test('fails with the no-grant error once a grant has expired', () => {
    saveConfig({ cdpDirectEnabled: true });
    const now = 1_700_000_000_000;
    saveGrant(10, now);
    const result = checkCdpDirectGate(now + 11 * 60_000);
    expect(result).toEqual({ ok: false, error: CDP_DIRECT_NO_GRANT_ERROR });
  });

  test('passes once enabled AND a live grant exists', () => {
    saveConfig({ cdpDirectEnabled: true });
    saveGrant(60);
    expect(checkCdpDirectGate()).toEqual({ ok: true });
  });

  test('passes with a never-expiring grant', () => {
    saveConfig({ cdpDirectEnabled: true });
    saveGrant(0);
    expect(checkCdpDirectGate(Number.MAX_SAFE_INTEGER)).toEqual({ ok: true });
  });

  test('re-evaluates on every call — disabling after a pass fails the next check', () => {
    saveConfig({ cdpDirectEnabled: true });
    saveGrant(60);
    expect(checkCdpDirectGate()).toEqual({ ok: true });
    saveConfig({ cdpDirectEnabled: false });
    expect(checkCdpDirectGate()).toEqual({ ok: false, error: CDP_DIRECT_DISABLED_ERROR });
  });
});
