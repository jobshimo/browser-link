import { beforeEach, describe, expect, test, vi } from 'vitest';

/* Mock queries — they have their own integration tests against a real
 * SQLite. Here we only verify routing + argument normalisation. */
vi.mock('./queries.js', () => ({
  recall: vi.fn(),
  saveEntry: vi.fn(),
  recordUse: vi.fn(),
  forget: vi.fn(),
  renameApp: vi.fn(),
  listApps: vi.fn(),
}));

import { handleMapTool, isMapTool, MAP_TOOL_DEFINITIONS } from './tools.js';
import { forget, listApps, recall, recordUse, renameApp, saveEntry } from './queries.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isMapTool', () => {
  test('accepts every browser.map.* tool exposed in MAP_TOOL_DEFINITIONS', () => {
    for (const def of MAP_TOOL_DEFINITIONS) {
      expect(isMapTool(def.name)).toBe(true);
    }
  });

  test('rejects browser bridge tools and anything not under browser.map.', () => {
    expect(isMapTool('browser.list_tabs')).toBe(false);
    expect(isMapTool('browser.navigate')).toBe(false);
    expect(isMapTool('browser.evaluate')).toBe(false);
    expect(isMapTool('something.else')).toBe(false);
    expect(isMapTool('')).toBe(false);
  });

  test('does NOT accept the prefix on its own', () => {
    /* Subtle guard: a name of literally "browser.map." would pass the
     * prefix check but is not a real tool. handleMapTool would throw
     * "Unknown map tool", which is the correct behaviour either way. */
    expect(isMapTool('browser.map.')).toBe(true);
    expect(() => handleMapTool('browser.map.', {})).toThrow(/Unknown map tool/);
  });
});

describe('MAP_TOOL_DEFINITIONS', () => {
  test('every entry has a non-empty name, description and a JSON-schema-ish inputSchema', () => {
    expect(MAP_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    for (const def of MAP_TOOL_DEFINITIONS) {
      expect(def.name).toMatch(/^browser\.map\./);
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  test('exposes the six tools the bridge MCP layer expects', () => {
    const names = MAP_TOOL_DEFINITIONS.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        'browser.map.apps',
        'browser.map.forget',
        'browser.map.recall',
        'browser.map.record_use',
        'browser.map.rename_app',
        'browser.map.save',
      ].sort(),
    );
  });

  test('save and recall declare additionalProperties: false to lock down the input shape', () => {
    for (const name of ['browser.map.save', 'browser.map.recall']) {
      const schema = MAP_TOOL_DEFINITIONS.find((d) => d.name === name)?.inputSchema as Record<
        string,
        unknown
      >;
      expect(schema.additionalProperties).toBe(false);
    }
  });
});

describe('handleMapTool — routing', () => {
  test('recall: forwards origin, defaults app_key and url to null', () => {
    handleMapTool('browser.map.recall', { origin: 'http://x' });
    expect(recall).toHaveBeenCalledExactlyOnceWith({
      origin: 'http://x',
      app_key: null,
      url: null,
    });
  });

  test('recall: passes through explicit app_key and url', () => {
    handleMapTool('browser.map.recall', {
      origin: 'http://x',
      app_key: 'my-app',
      url: 'http://x/path',
    });
    expect(recall).toHaveBeenCalledWith({
      origin: 'http://x',
      app_key: 'my-app',
      url: 'http://x/path',
    });
  });

  test('save: defaults app_key, title and notes to null when omitted', () => {
    handleMapTool('browser.map.save', {
      origin: 'http://x',
      url_pattern: '/cga',
      kind: 'selector',
      purpose: 'open',
      payload: { selector: '#x' },
    });
    expect(saveEntry).toHaveBeenCalledExactlyOnceWith({
      origin: 'http://x',
      app_key: null,
      title: null,
      url_pattern: '/cga',
      kind: 'selector',
      purpose: 'open',
      payload: { selector: '#x' },
      notes: null,
    });
  });

  test('save: forwards every optional field when provided', () => {
    handleMapTool('browser.map.save', {
      origin: 'http://x',
      app_key: 'app',
      title: 'My App',
      url_pattern: '/',
      kind: 'flow',
      purpose: 'login',
      payload: { steps: [] },
      notes: 'tricky modal',
    });
    expect(saveEntry).toHaveBeenCalledWith({
      origin: 'http://x',
      app_key: 'app',
      title: 'My App',
      url_pattern: '/',
      kind: 'flow',
      purpose: 'login',
      payload: { steps: [] },
      notes: 'tricky modal',
    });
  });

  test('record_use: defaults notes to null when omitted', () => {
    handleMapTool('browser.map.record_use', { entry_id: 42, ok: true });
    expect(recordUse).toHaveBeenCalledExactlyOnceWith({ entry_id: 42, ok: true, notes: null });
  });

  test('record_use: passes notes when provided', () => {
    handleMapTool('browser.map.record_use', { entry_id: 7, ok: false, notes: 'page changed' });
    expect(recordUse).toHaveBeenCalledWith({ entry_id: 7, ok: false, notes: 'page changed' });
  });

  test('forget: passes entry_id, app_id and reason as-is (any can be undefined)', () => {
    handleMapTool('browser.map.forget', { entry_id: 1 });
    expect(forget).toHaveBeenCalledExactlyOnceWith({
      entry_id: 1,
      app_id: undefined,
      reason: undefined,
    });

    vi.mocked(forget).mockClear();
    handleMapTool('browser.map.forget', { app_id: 2, reason: 'refactored' });
    expect(forget).toHaveBeenCalledWith({ entry_id: undefined, app_id: 2, reason: 'refactored' });
  });

  test('rename_app: forwards (app_id, new_app_key) as positional args', () => {
    handleMapTool('browser.map.rename_app', { app_id: 5, new_app_key: 'flight-management' });
    expect(renameApp).toHaveBeenCalledExactlyOnceWith(5, 'flight-management');
  });

  test('apps: takes no arguments and calls listApps()', () => {
    handleMapTool('browser.map.apps', undefined);
    expect(listApps).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('handleMapTool — return values', () => {
  test('returns whatever the underlying query returns, unmodified', () => {
    vi.mocked(listApps).mockReturnValue([{ id: 1 } as never]);
    const result = handleMapTool('browser.map.apps', undefined);
    expect(result).toEqual([{ id: 1 }]);
  });

  test('returns the recall query result directly', () => {
    vi.mocked(recall).mockReturnValue({ app: null, entries: [] });
    const result = handleMapTool('browser.map.recall', { origin: 'http://x' });
    expect(result).toEqual({ app: null, entries: [] });
  });
});

describe('handleMapTool — unknown tool', () => {
  test('throws "Unknown map tool" for names outside the catalogue', () => {
    expect(() => handleMapTool('browser.map.does_not_exist', {})).toThrow(
      /Unknown map tool: browser\.map\.does_not_exist/,
    );
    expect(recall).not.toHaveBeenCalled();
    expect(saveEntry).not.toHaveBeenCalled();
  });

  test('throws on totally unrelated names too (defence in depth)', () => {
    expect(() => handleMapTool('browser.list_tabs', {})).toThrow(/Unknown map tool/);
  });
});
