import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import {
  applyPreset,
  disableTools,
  enableTools,
  listToolsStatus,
  parseToolsArgs,
  runToolsCommand,
} from './tools.js';
import { loadConfig } from '../config.js';

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Redirect config.json to a throwaway dir for each test. The data-dir
  // helper is the one place config.ts asks "where do I live?".
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-tools-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('parseToolsArgs', () => {
  test('no args defaults to list', () => {
    expect(parseToolsArgs([])).toEqual({ action: 'list', names: [] });
    expect(parseToolsArgs(['list'])).toEqual({ action: 'list', names: [] });
  });

  test('enable / disable / preset capture remaining names', () => {
    expect(parseToolsArgs(['enable', 'browser.evaluate'])).toEqual({
      action: 'enable',
      names: ['browser.evaluate'],
    });
    expect(parseToolsArgs(['disable', 'browser.click', 'browser.type'])).toEqual({
      action: 'disable',
      names: ['browser.click', 'browser.type'],
    });
    expect(parseToolsArgs(['preset', 'readonly'])).toEqual({
      action: 'preset',
      names: ['readonly'],
    });
  });

  test('rejects unknown action verb', () => {
    expect(() => parseToolsArgs(['nope'])).toThrow(/Unknown tools action/);
  });
});

describe('disableTools', () => {
  test('adds a tool to the disabled list and dedupes / sorts', () => {
    disableTools(['browser.evaluate']);
    expect(loadConfig().disabledTools).toEqual(['browser.evaluate']);
    disableTools(['browser.click', 'browser.evaluate']);
    expect(loadConfig().disabledTools).toEqual(['browser.click', 'browser.evaluate']);
  });

  test('rejects unknown tool names without touching the config', () => {
    expect(() => disableTools(['totally.fake'])).toThrow(/Unknown tool/);
    expect(loadConfig().disabledTools).toBeUndefined();
  });

  test('rejects empty names list', () => {
    expect(() => disableTools([])).toThrow(/Usage/);
  });

  test('reports no-change when every requested tool was already disabled', () => {
    disableTools(['browser.evaluate']);
    const msg = disableTools(['browser.evaluate']);
    expect(msg).toMatch(/No change/);
  });
});

describe('enableTools', () => {
  test('removes a tool from the disabled list', () => {
    disableTools(['browser.evaluate', 'browser.click']);
    enableTools(['browser.evaluate']);
    expect(loadConfig().disabledTools).toEqual(['browser.click']);
  });

  test('clears the disabled key entirely when the list becomes empty', () => {
    disableTools(['browser.evaluate']);
    enableTools(['browser.evaluate']);
    expect(loadConfig().disabledTools).toBeUndefined();
  });

  test('rejects unknown names', () => {
    expect(() => enableTools(['totally.fake'])).toThrow(/Unknown tool/);
  });

  test('reports no-change when nothing was disabled to begin with', () => {
    const msg = enableTools(['browser.evaluate']);
    expect(msg).toMatch(/No change/);
  });
});

describe('applyPreset', () => {
  test('replaces the disabled list with the preset', () => {
    disableTools(['browser.evaluate']);
    applyPreset('no-map');
    const out = loadConfig().disabledTools ?? [];
    // every map tool present, no bridge tool present
    expect(out).toContain('browser.map.recall');
    expect(out).toContain('browser.map.save');
    expect(out).not.toContain('browser.evaluate');
  });

  test('"all" wipes everything', () => {
    disableTools(['browser.evaluate']);
    applyPreset('all');
    expect(loadConfig().disabledTools).toBeUndefined();
  });

  test('rejects unknown preset ids', () => {
    expect(() => applyPreset('totally-fake')).toThrow(/Unknown preset/);
  });
});

describe('listToolsStatus', () => {
  test('lists every tool with its current mark', () => {
    disableTools(['browser.evaluate']);
    const out = listToolsStatus();
    expect(out).toContain('browser.evaluate');
    expect(out).toContain('1 disabled');
    expect(out).toContain('Browser bridge:');
    expect(out).toContain('Persistent UI map:');
    expect(out).toContain('Presets:');
  });

  test('says "all enabled" when nothing is disabled', () => {
    expect(listToolsStatus()).toContain('all enabled');
  });
});

describe('runToolsCommand integration', () => {
  test('preset → list reflects the change', () => {
    runToolsCommand(['preset', 'no-eval']);
    expect(loadConfig().disabledTools).toEqual(['browser.evaluate']);
    const out = runToolsCommand([]);
    expect(out).toContain('1 disabled');
  });
});

describe('i18n (es path)', () => {
  test('listToolsStatus in es uses Spanish headers', () => {
    const out = listToolsStatus('es');
    expect(out).toContain('Permisos de tools');
    expect(out).toContain('Bridge del browser');
    expect(out).toContain('Mapa persistente');
  });

  test('disableTools in es reports in Spanish', () => {
    const msg = disableTools(['browser.evaluate'], 'es');
    expect(msg).toMatch(/Deshabilitadas/);
  });

  test('unknown tool error is in Spanish', () => {
    expect(() => disableTools(['totally.fake'], 'es')).toThrow(/Tool desconocida/);
  });

  test('unknown preset error is in Spanish', () => {
    expect(() => applyPreset('bogus', 'es')).toThrow(/Preset desconocido/);
  });
});
