import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkUpdates, formatUpdate } from './updates.js';
import { VERSION } from '../version.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchOnce(body: unknown, init: { status?: number } = {}) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('checkUpdates', () => {
  test('reports newer:true when registry latest > current', async () => {
    mockFetchOnce({ latest: '99.0.0' });
    const info = await checkUpdates();
    expect(info.current).toBe(VERSION);
    expect(info.latest).toBe('99.0.0');
    expect(info.newer).toBe(true);
    expect(info.error).toBeUndefined();
  });

  test('reports newer:false when current === latest', async () => {
    mockFetchOnce({ latest: VERSION });
    const info = await checkUpdates();
    expect(info.latest).toBe(VERSION);
    expect(info.newer).toBe(false);
  });

  test('reports newer:false when current is ahead of registry (pre-publish)', async () => {
    mockFetchOnce({ latest: '0.0.1' });
    const info = await checkUpdates();
    expect(info.latest).toBe('0.0.1');
    expect(info.newer).toBe(false);
  });

  test('reports newer:null with error when registry returns non-2xx', async () => {
    mockFetchOnce({}, { status: 503 });
    const info = await checkUpdates();
    expect(info.latest).toBeNull();
    expect(info.newer).toBeNull();
    expect(info.error).toMatch(/HTTP 503/);
  });

  test('reports newer:null with error when latest dist-tag is missing', async () => {
    mockFetchOnce({});
    const info = await checkUpdates();
    expect(info.latest).toBeNull();
    expect(info.error).toMatch(/no "latest"/);
  });

  test('reports newer:null with error when fetch throws (network down)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH 0.0.0.0:443');
    }) as unknown as typeof fetch;
    const info = await checkUpdates();
    expect(info.latest).toBeNull();
    expect(info.error).toContain('ENETUNREACH');
  });
});

describe('formatUpdate', () => {
  test('uptodate message when newer:false', () => {
    const out = formatUpdate({ current: '0.2.0', latest: '0.2.0', newer: false });
    expect(out).toContain('Current: 0.2.0');
    expect(out).toContain('Latest:  0.2.0');
    expect(out).toContain('up to date');
  });

  test('update-available message when newer:true', () => {
    const out = formatUpdate({ current: '0.1.0', latest: '0.2.0', newer: true });
    expect(out).toContain('Update available');
    expect(out).toContain('npm install -g');
  });

  test('error message when registry could not be reached', () => {
    const out = formatUpdate({
      current: '0.2.0',
      latest: null,
      newer: null,
      error: 'timed out',
    });
    expect(out).toContain('Could not check the registry');
    expect(out).toContain('timed out');
  });
});
