import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import { saveConfig } from '../config.js';
import { saveGrant } from './grant.js';
import {
  buildTargetWsUrl,
  cdpTargetIdFromTabId,
  isCdpTabId,
  isChromeDevtoolsEndpoint,
  isDrivablePageTarget,
  listCdpTargets,
} from './targets.js';

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-cdp-targets-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  fetchSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function grantAccess(): void {
  saveConfig({ cdpDirectEnabled: true });
  saveGrant(60);
}

describe('listCdpTargets — gate', () => {
  test('returns [] without ever touching the network when disabled', async () => {
    const result = await listCdpTargets();
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns [] without touching the network when enabled but ungranted', async () => {
    saveConfig({ cdpDirectEnabled: true });
    const result = await listCdpTargets();
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('listCdpTargets — discovery', () => {
  test('returns [] when /json/version is not ok', async () => {
    grantAccess();
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, false));
    expect(await listCdpTargets()).toEqual([]);
  });

  test('returns [] when the Browser string does not mention Chrome', async () => {
    grantAccess();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Browser: 'SomethingElse/1.0' }));
    expect(await listCdpTargets()).toEqual([]);
  });

  test('returns [] when /json/version throws (nothing listening on the port)', async () => {
    grantAccess();
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await listCdpTargets()).toEqual([]);
  });

  test('maps page targets, dropping devtools/extension pages', async () => {
    grantAccess();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ Browser: 'Chrome/124.0.0.0' }))
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'abc123', type: 'page', url: 'https://example.com/', title: 'Example' },
          {
            id: 'skip1',
            type: 'page',
            url: 'devtools://devtools/bundled/inspector.html',
            title: 'DevTools',
          },
          { id: 'skip2', type: 'page', url: 'chrome-extension://abc/popup.html', title: 'Ext' },
          { id: 'skip3', type: 'background_page', url: 'https://example.com/', title: 'BG' },
        ]),
      );
    const result = await listCdpTargets();
    expect(result).toEqual([
      { tab_id: 'cdp:abc123', url: 'https://example.com/', title: 'Example', transport: 'cdp' },
    ]);
  });

  test('returns [] when /json/list is not ok', async () => {
    grantAccess();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ Browser: 'Chrome/124.0.0.0' }))
      .mockResolvedValueOnce(jsonResponse([], false));
    expect(await listCdpTargets()).toEqual([]);
  });

  test('returns [] when /json/list is not an array', async () => {
    grantAccess();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ Browser: 'Chrome/124.0.0.0' }))
      .mockResolvedValueOnce(jsonResponse({ not: 'an array' }));
    expect(await listCdpTargets()).toEqual([]);
  });
});

describe('isChromeDevtoolsEndpoint', () => {
  test('true when the Browser field contains Chrome', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Browser: 'HeadlessChrome/124.0.0.0' }));
    expect(await isChromeDevtoolsEndpoint(9222)).toBe(true);
  });

  test('false on a non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, false));
    expect(await isChromeDevtoolsEndpoint(9222)).toBe(false);
  });

  test('false when fetch rejects', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('nope'));
    expect(await isChromeDevtoolsEndpoint(9222)).toBe(false);
  });
});

describe('tab_id helpers', () => {
  test('isCdpTabId recognizes the cdp: prefix', () => {
    expect(isCdpTabId('cdp:ABC123')).toBe(true);
    expect(isCdpTabId('tab_1')).toBe(false);
  });

  test('cdpTargetIdFromTabId strips the prefix', () => {
    expect(cdpTargetIdFromTabId('cdp:ABC123')).toBe('ABC123');
  });

  test('cdpTargetIdFromTabId returns null for a non-cdp tab_id', () => {
    expect(cdpTargetIdFromTabId('tab_1')).toBeNull();
  });

  test('cdpTargetIdFromTabId returns null for an empty target id', () => {
    expect(cdpTargetIdFromTabId('cdp:')).toBeNull();
  });

  test('buildTargetWsUrl produces the standard devtools/page URL shape', () => {
    expect(buildTargetWsUrl(9222, 'ABC123')).toBe('ws://127.0.0.1:9222/devtools/page/ABC123');
  });
});

describe('isDrivablePageTarget (shared by discovery + connect-time re-validation)', () => {
  test('accepts a real page target', () => {
    expect(isDrivablePageTarget('page', 'https://example.com/')).toBe(true);
  });

  test('rejects a non-page type', () => {
    expect(isDrivablePageTarget('service_worker', 'https://example.com/')).toBe(false);
    expect(isDrivablePageTarget('other', 'chrome://inspect/')).toBe(false);
    expect(isDrivablePageTarget(undefined, 'https://example.com/')).toBe(false);
  });

  test('rejects a devtools or extension page even when type says page', () => {
    expect(isDrivablePageTarget('page', 'devtools://devtools/bundled/inspector.html')).toBe(false);
    expect(isDrivablePageTarget('page', 'chrome-extension://abc/popup.html')).toBe(false);
  });

  test('rejects a missing url', () => {
    expect(isDrivablePageTarget('page', undefined)).toBe(false);
  });
});

describe('SSRF hardening — the cdp-direct port never escapes loopback', () => {
  /** Hand-write a raw config.json with an arbitrary (possibly hostile) port
   * value, bypassing the typed saveConfig, to simulate a corrupted / tampered
   * file. */
  function writeRawConfig(cdpDirectPort: unknown): void {
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({ cdpDirectEnabled: true, cdpDirectPort }) + '\n',
      'utf8',
    );
    saveGrant(60);
  }

  /** Every URL actually handed to fetch, as a parsed URL. */
  function fetchedHosts(): string[] {
    return fetchSpy.mock.calls.map((c) => new URL(String(c[0])).hostname);
  }

  const MALICIOUS_PORTS = [
    '9222@attacker.com',
    '9222@attacker.com/json/version',
    '9222/x',
    '9222 evil.com',
    'attacker.com',
    0,
    70000,
    -1,
    9222.5,
    'not-a-port',
  ];

  test.each(MALICIOUS_PORTS)(
    'a malicious port %p never produces a fetch to a non-loopback host',
    async (badPort) => {
      writeRawConfig(badPort);
      // Answer as a real Chrome so discovery proceeds to BOTH fetches and we
      // exercise every URL-construction site.
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ Browser: 'Chrome/124.0.0.0' }))
        .mockResolvedValueOnce(jsonResponse([]));
      await listCdpTargets();
      // The point: EVERY fetch — if any happened — went to 127.0.0.1, never
      // the off-host breakout target.
      for (const host of fetchedHosts()) expect(host).toBe('127.0.0.1');
      // And it used the fallback port 9222, not the smuggled value.
      for (const call of fetchSpy.mock.calls) {
        expect(new URL(String(call[0])).port).toBe('9222');
      }
    },
  );

  test('a valid custom port is used verbatim against loopback', async () => {
    writeRawConfig(9333);
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ Browser: 'Chrome/124.0.0.0' }))
      .mockResolvedValueOnce(jsonResponse([]));
    await listCdpTargets();
    expect(fetchSpy).toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      const url = new URL(String(call[0]));
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.port).toBe('9333');
    }
  });

  test('isChromeDevtoolsEndpoint fetches loopback even if handed a hostile port directly', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Browser: 'Chrome/124.0.0.0' }));
    // Bypass the config read entirely — prove the sink function itself is safe.
    const ok = await isChromeDevtoolsEndpoint('9222@attacker.com' as unknown as number);
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('9222');
  });

  test('buildTargetWsUrl keeps the host loopback for a hostile port', () => {
    const wsUrl = buildTargetWsUrl('9222@attacker.com' as unknown as number, 'TARGET-1');
    expect(new URL(wsUrl).hostname).toBe('127.0.0.1');
    expect(new URL(wsUrl).port).toBe('9222');
  });
});
