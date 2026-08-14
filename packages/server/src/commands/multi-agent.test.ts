import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import {
  disableAutoReelect,
  disableMultiAgent,
  enableAutoReelect,
  enableMultiAgent,
  listMultiAgentStatus,
  runMultiAgentCommand,
} from './multi-agent.js';
import { loadConfig } from '../config.js';

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-multi-agent-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('enableMultiAgent / disableMultiAgent', () => {
  test('multi-agent and auto-reelect are ON by default for a fresh install', () => {
    // Empty config → both flags read as true via the runtime defaults applied
    // by loadConfig. The config file on disk stays empty until the user opts
    // out, so the diff is minimal.
    const cfg = loadConfig();
    expect(cfg.multiAgent).toBe(true);
    expect(cfg.autoReelect).toBe(true);
  });

  test('enable is a no-op when multi-agent is already on (the default)', () => {
    const msg = enableMultiAgent();
    expect(msg).toMatch(/No change/);
  });

  test('enable after an explicit disable flips multi-agent back on', () => {
    disableMultiAgent();
    expect(loadConfig().multiAgent).toBe(false);
    enableMultiAgent();
    expect(loadConfig().multiAgent).toBe(true);
  });

  test('disable forces multi-agent and auto-reelect off and persists the override', () => {
    disableMultiAgent();
    const cfg = loadConfig();
    expect(cfg.multiAgent).toBe(false);
    // autoReelect gates on multiAgent — when multi-agent is off the effective
    // value is forced to false regardless of any prior explicit value.
    expect(cfg.autoReelect).toBe(false);
  });

  test('disable when already off reports no-change', () => {
    disableMultiAgent();
    const msg = disableMultiAgent();
    expect(msg).toMatch(/No change/);
  });
});

describe('enableAutoReelect / disableAutoReelect', () => {
  test('enabling auto-reelect after multi-agent has been turned off throws', () => {
    disableMultiAgent();
    expect(() => enableAutoReelect()).toThrow(/Cannot enable auto-reelect/);
  });

  test('auto-reelect is on by default whenever multi-agent is on', () => {
    expect(loadConfig().autoReelect).toBe(true);
  });

  test('enabling auto-reelect on the default state is a no-op', () => {
    const msg = enableAutoReelect();
    expect(msg).toMatch(/No change/);
  });

  test('disable auto-reelect leaves multi-agent on and persists the override', () => {
    disableAutoReelect();
    const cfg = loadConfig();
    expect(cfg.multiAgent).toBe(true);
    expect(cfg.autoReelect).toBe(false);
  });

  test('enabling auto-reelect after an explicit disable flips it back on', () => {
    disableAutoReelect();
    enableAutoReelect();
    expect(loadConfig().autoReelect).toBe(true);
  });
});

describe('config normalisation', () => {
  test('autoReelect is forced to false when multi-agent is explicitly disabled', () => {
    disableMultiAgent();
    expect(loadConfig().autoReelect).toBe(false);
  });
});

describe('listMultiAgentStatus', () => {
  test('reports both flags ON by default (fresh install)', () => {
    const out = listMultiAgentStatus();
    expect(out).toContain('Multi-agent settings');
    expect(out).toMatch(/Multi-agent mode\s+on/);
    expect(out).toMatch(/Auto-reelect.*on/);
  });

  test('reports off after an explicit disable', () => {
    disableMultiAgent();
    const out = listMultiAgentStatus();
    expect(out).toMatch(/Multi-agent mode\s+off/);
    expect(out).toMatch(/Auto-reelect.*off/);
  });
});

describe('runMultiAgentCommand integration', () => {
  test('disable → list reflects the explicit override', () => {
    runMultiAgentCommand(['disable']);
    expect(loadConfig().multiAgent).toBe(false);
    const out = runMultiAgentCommand([]);
    expect(out).toMatch(/Multi-agent mode\s+off/);
  });

  test('auto-reelect enable after disabling multi-agent throws', () => {
    runMultiAgentCommand(['disable']);
    expect(() => runMultiAgentCommand(['auto-reelect', 'enable'])).toThrow(
      /Cannot enable auto-reelect/,
    );
  });

  test('rejects unknown actions', () => {
    expect(() => runMultiAgentCommand(['nope'])).toThrow(/Unknown multi-agent action/);
    expect(() => runMultiAgentCommand(['auto-reelect', 'nope'])).toThrow(
      /Unknown auto-reelect action/,
    );
  });
});

describe('i18n (es path)', () => {
  test('listMultiAgentStatus in es uses Spanish labels and reports activado by default', () => {
    const out = listMultiAgentStatus('es');
    expect(out).toContain('Configuración multi-agente');
    expect(out).toContain('Modo multi-agente');
    expect(out).toMatch(/activado/);
  });

  test('error for auto-reelect after disabling multi-agent is in Spanish', () => {
    disableMultiAgent('es');
    expect(() => enableAutoReelect('es')).toThrow(/re-elección automática/);
  });
});
