import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import { loadConfig, saveConfig } from '../config.js';
import { checkCdpDirectGate } from '../cdp/gate.js';
import { grantFilePath, loadGrant, saveGrant } from '../cdp/grant.js';
import { allowCdpDirect, cdpDirectStatus, revokeCdpDirect, runCdpCommand } from './cdp.js';

/*
 * Controllable node:fs mock. The realistic "revoke fails open" scenario is a
 * file lock that blocks unlinkSync while readFileSync STILL SUCCEEDS — a
 * directory-at-path (used elsewhere) can't reproduce that because it also
 * breaks the read, and `vi.spyOn(fs, ...)` fails ("Module namespace is not
 * configurable in ESM"). So we mock node:fs once and let each `*Throws` flag
 * — off by default, reset in afterEach — inject a targeted failure while
 * every other fs op (and every other test) runs against the real fs.
 */
const fsControl = vi.hoisted(() => ({
  unlinkThrows: null as Error | null,
  writeThrows: null as Error | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (fsControl.unlinkThrows) throw fsControl.unlinkThrows;
      return actual.unlinkSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsControl.writeThrows) throw fsControl.writeThrows;
      return actual.writeFileSync(...args);
    },
  };
});

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-cdp-cmd-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no Chrome in tests'));
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  fetchSpy.mockRestore();
  fsControl.unlinkThrows = null;
  fsControl.writeThrows = null;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('allowCdpDirect', () => {
  test('records a grant using the configured default TTL (60 min) when no override is given', () => {
    const msg = allowCdpDirect([]);
    const grant = loadGrant();
    expect(grant).not.toBeNull();
    expect(grant?.expiresAt).not.toBeNull();
    expect(msg).toMatch(/grant recorded/i);
    expect(msg).toMatch(/browser-link cdp revoke/);
  });

  test('--minutes overrides the configured default', () => {
    allowCdpDirect(['--minutes', '5']);
    const grant = loadGrant();
    const remaining = (grant?.expiresAt ?? 0) - (grant?.grantedAt ?? 0);
    expect(remaining).toBe(5 * 60_000);
  });

  test('--minutes never / 0 records a grant with no expiry and warns about it', () => {
    const msg = allowCdpDirect(['--minutes', 'never']);
    const grant = loadGrant();
    expect(grant?.expiresAt).toBeNull();
    expect(msg).toMatch(/never expires/i);
  });

  test('an invalid --minutes value throws a clear error', () => {
    expect(() => allowCdpDirect(['--minutes', 'banana'])).toThrow(/invalid/i);
  });

  test('clamps an out-of-range --minutes and notes it', () => {
    const msg = allowCdpDirect(['--minutes', '99999']);
    expect(msg).toMatch(/clamped from 99999 to 1440/);
  });

  test('notes that cdp-direct.enabled is still off', () => {
    const msg = allowCdpDirect([]);
    expect(msg).toMatch(/cdp-direct\.enabled is currently off/i);
  });

  test('does not repeat the disabled note once cdp-direct.enabled is on', () => {
    saveConfig({ cdpDirectEnabled: true });
    const msg = allowCdpDirect([]);
    expect(msg).not.toMatch(/currently off/i);
  });
});

describe('revokeCdpDirect', () => {
  test('clears an existing grant', () => {
    allowCdpDirect([]);
    expect(loadGrant()).not.toBeNull();
    const msg = revokeCdpDirect();
    expect(loadGrant()).toBeNull();
    expect(msg).toMatch(/revoked/i);
  });

  test('reports plainly when there was nothing to revoke', () => {
    const msg = revokeCdpDirect();
    expect(msg).toMatch(/no cdp-direct grant was active/i);
  });

  test('throws an honest, path-naming error when the grant file cannot be removed', () => {
    // Directory-at-path makes unlinkSync fail deterministically on every OS
    // (see grant.test.ts). revoke must NOT report a false success.
    mkdirSync(grantFilePath(), { recursive: true });
    expect(() => revokeCdpDirect()).toThrow(/could not remove the grant file/i);
    expect(() => revokeCdpDirect()).toThrow(grantFilePath());
  });

  test('the honest revoke-failure error is localized in es', () => {
    mkdirSync(grantFilePath(), { recursive: true });
    expect(() => revokeCdpDirect('es')).toThrow(/no se pudo eliminar el archivo de permiso/i);
  });

  test('fails CLOSED: unlink fails but the grant file survives readable → gate DENIES afterward', () => {
    // The REALISTIC Windows failure: a lock blocks DELETION while the file
    // stays READABLE. The grant file survives, loadGrant reads it fine — so
    // without the fail-closed fallback the gate would keep returning ok:true.
    saveConfig({ cdpDirectEnabled: true });
    saveGrant(60);
    expect(checkCdpDirectGate()).toEqual({ ok: true }); // gate OPEN before revoke

    // Unlink fails, but the grant file stays on disk and readable.
    fsControl.unlinkThrows = new Error('EBUSY: resource busy or locked');

    let thrown: Error | null = null;
    try {
      revokeCdpDirect();
    } catch (e) {
      thrown = e as Error;
    }
    // (d) it threw → CLI dispatcher exits non-zero
    expect(thrown).not.toBeNull();
    // (c) message names BOTH facts: removal failed AND the safeguard disabled
    expect(thrown?.message).toMatch(/could not remove the grant file/i);
    expect(thrown?.message).toMatch(/disabled/i);
    // The grant file genuinely survived and is still readable (the real case)
    expect(loadGrant()).not.toBeNull();
    // (b) enabled was flipped false via the different-file fallback
    expect(loadConfig().cdpDirectEnabled).toBe(false);
    // (a) THE POINT: the gate now DENIES despite the surviving readable grant
    expect(checkCdpDirectGate().ok).toBe(false);
  });

  test('surfaces BOTH failures when the disable safeguard also fails', () => {
    saveConfig({ cdpDirectEnabled: true });
    saveGrant(60);
    // Unlink fails AND the config.json write that would disable the feature
    // also fails — the genuinely-catastrophic case, surfaced loudly.
    fsControl.unlinkThrows = new Error('EBUSY');
    fsControl.writeThrows = new Error('EROFS: read-only file system');

    let thrown: Error | null = null;
    try {
      revokeCdpDirect();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toMatch(/may still be active/i);
    expect(thrown?.message).toMatch(/EROFS/);
  });
});

describe('cdpDirectStatus', () => {
  test('reports disabled + no grant + unreachable on a fresh install', async () => {
    const msg = await cdpDirectStatus();
    expect(msg).toMatch(/cdp-direct status/i);
    expect(msg).toMatch(/enabled\s+no/i);
    expect(msg).toMatch(/9222/);
    expect(msg).toMatch(/none/i);
    expect(msg).toMatch(/reachable\s+no/i);
  });

  test('reports the custom port when one is configured', async () => {
    saveConfig({ cdpDirectPort: 9333 });
    const msg = await cdpDirectStatus();
    expect(msg).toMatch(/9333/);
  });

  test('reports remaining time for a live grant', async () => {
    allowCdpDirect(['--minutes', '10']);
    const msg = await cdpDirectStatus();
    expect(msg).toMatch(/active, \d+ min remaining/i);
  });

  test('reports "never expires" for a never-expiring grant', async () => {
    allowCdpDirect(['--minutes', 'never']);
    const msg = await cdpDirectStatus();
    expect(msg).toMatch(/never expires/i);
  });

  test('reports expired for a grant whose TTL has passed', async () => {
    allowCdpDirect(['--minutes', '1']);
    const grant = loadGrant();
    expect(grant).not.toBeNull();
    // Force "now" past the grant's expiresAt without waiting a real minute.
    vi.useFakeTimers();
    vi.setSystemTime((grant?.expiresAt ?? 0) + 1);
    const msg = await cdpDirectStatus();
    vi.useRealTimers();
    expect(msg).toMatch(/expired/i);
  });

  test('reports reachable when the endpoint answers', async () => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Browser: 'Chrome/124.0.0.0' }),
    } as unknown as Response);
    const msg = await cdpDirectStatus();
    expect(msg).toMatch(/reachable\s+yes/i);
  });
});

describe('runCdpCommand dispatch', () => {
  test('bare `cdp` (no action) throws usage', async () => {
    await expect(runCdpCommand([])).rejects.toThrow(/usage/i);
  });

  test('routes allow/revoke/status', async () => {
    await expect(runCdpCommand(['allow'])).resolves.toMatch(/grant recorded/i);
    await expect(runCdpCommand(['status'])).resolves.toMatch(/cdp-direct status/i);
    await expect(runCdpCommand(['revoke'])).resolves.toMatch(/revoked/i);
  });

  test('an unknown action throws a clear error', async () => {
    await expect(runCdpCommand(['bogus'])).rejects.toThrow(/unknown cdp action/i);
  });

  test('es locale uses Spanish strings', async () => {
    await expect(runCdpCommand(['status'], 'es')).resolves.toMatch(/estado de cdp-direct/i);
  });
});

test('loadConfig defaults cdp-direct fields sanely on a fresh install', () => {
  const cfg = loadConfig();
  expect(cfg.cdpDirectEnabled).toBe(false);
  expect(cfg.cdpDirectPort).toBe(9222);
  expect(cfg.cdpDirectGrantTtlMinutes).toBe(60);
});
