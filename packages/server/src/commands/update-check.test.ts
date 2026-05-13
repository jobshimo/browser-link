import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../version.js';
import { checkForUpdates } from './update-check.js';

/**
 * The background update check is the source for the passive update banner
 * in the TUI. Behaviour we lock in:
 *
 *  - mocked fetch returning latest > current ⇒ isNewer=true
 *  - mocked fetch returning latest === current ⇒ isNewer=false
 *  - mocked fetch failing ⇒ latest=null, isNewer=false (silent failure)
 *  - successful checks are cached to disk
 *  - cached responses within 6h are returned without re-hitting the registry
 *  - failed checks do NOT pollute the cache
 */

const originalFetch = globalThis.fetch;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-update-check-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockFetchOnce(body: unknown, init: { status?: number } = {}): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('checkForUpdates', () => {
  test('reports isNewer=true when the registry returns a higher version', async () => {
    mockFetchOnce({ latest: '99.0.0' });
    const r = await checkForUpdates();
    expect(r.current).toBe(VERSION);
    expect(r.latest).toBe('99.0.0');
    expect(r.isNewer).toBe(true);
  });

  test('reports isNewer=false when latest === current', async () => {
    mockFetchOnce({ latest: VERSION });
    const r = await checkForUpdates();
    expect(r.latest).toBe(VERSION);
    expect(r.isNewer).toBe(false);
  });

  test('returns latest=null silently when the registry call fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch;
    const r = await checkForUpdates();
    expect(r.latest).toBeNull();
    expect(r.isNewer).toBe(false);
  });

  test('persists the latest version to disk on success', async () => {
    mockFetchOnce({ latest: '99.0.0' });
    await checkForUpdates();
    const cachePath = join(dataDir, 'update-check.json');
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cached.latest).toBe('99.0.0');
    expect(cached.current).toBe(VERSION);
    expect(typeof cached.checkedAtMs).toBe('number');
  });

  test('serves cached value within the 6h window without hitting the registry', async () => {
    // Seed a fresh cache.
    const cachePath = join(dataDir, 'update-check.json');
    writeFileSync(
      cachePath,
      JSON.stringify({ current: VERSION, latest: '99.0.0', checkedAtMs: Date.now() }),
      'utf8',
    );
    // Fail any actual fetch attempt — if the cache is honoured, this is
    // never called.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called when the cache is fresh');
    }) as unknown as typeof fetch;
    const r = await checkForUpdates();
    expect(r.latest).toBe('99.0.0');
    expect(r.isNewer).toBe(true);
  });

  test('bypasses the cache when force=true is set', async () => {
    const cachePath = join(dataDir, 'update-check.json');
    writeFileSync(
      cachePath,
      JSON.stringify({ current: VERSION, latest: '99.0.0', checkedAtMs: Date.now() }),
      'utf8',
    );
    mockFetchOnce({ latest: '100.0.0' });
    const r = await checkForUpdates({ force: true });
    expect(r.latest).toBe('100.0.0');
  });

  test('refreshes the cache when the build version no longer matches the cached `current`', async () => {
    // A cache with a different current (e.g. user upgraded browser-link
    // between TUI sessions) must be discarded — the comparison is no
    // longer meaningful.
    const cachePath = join(dataDir, 'update-check.json');
    writeFileSync(
      cachePath,
      JSON.stringify({ current: '0.0.1', latest: '99.0.0', checkedAtMs: Date.now() }),
      'utf8',
    );
    mockFetchOnce({ latest: '50.0.0' });
    const r = await checkForUpdates();
    expect(r.latest).toBe('50.0.0');
  });

  test('failed checks do not poison the cache', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch;
    await checkForUpdates();
    const cachePath = join(dataDir, 'update-check.json');
    // Either the file does not exist or it does not carry a null latest —
    // we never overwrite an existing cache with a failed lookup.
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      expect(cached.latest).not.toBeNull();
    }
  });
});
