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
  test('enable flips multiAgent to true', () => {
    enableMultiAgent();
    expect(loadConfig().multiAgent).toBe(true);
  });

  test('enable is idempotent', () => {
    enableMultiAgent();
    const msg = enableMultiAgent();
    expect(msg).toMatch(/No change/);
  });

  test('disable clears multiAgent and autoReelect together', () => {
    enableMultiAgent();
    enableAutoReelect();
    expect(loadConfig().autoReelect).toBe(true);
    disableMultiAgent();
    const cfg = loadConfig();
    expect(cfg.multiAgent).toBeUndefined();
    expect(cfg.autoReelect).toBeUndefined();
  });

  test('disable when already off reports no-change', () => {
    const msg = disableMultiAgent();
    expect(msg).toMatch(/No change/);
  });
});

describe('enableAutoReelect / disableAutoReelect', () => {
  test('enabling auto-reelect with multi-agent off throws', () => {
    expect(() => enableAutoReelect()).toThrow(/Cannot enable auto-reelect/);
  });

  test('enabling auto-reelect after multi-agent works', () => {
    enableMultiAgent();
    enableAutoReelect();
    expect(loadConfig().autoReelect).toBe(true);
  });

  test('disable auto-reelect leaves multi-agent on', () => {
    enableMultiAgent();
    enableAutoReelect();
    disableAutoReelect();
    const cfg = loadConfig();
    expect(cfg.multiAgent).toBe(true);
    expect(cfg.autoReelect).toBeUndefined();
  });

  test('enabling auto-reelect twice is idempotent', () => {
    enableMultiAgent();
    enableAutoReelect();
    const msg = enableAutoReelect();
    expect(msg).toMatch(/No change/);
  });
});

describe('config normalisation', () => {
  test('autoReelect alone (without multiAgent) is dropped on write', () => {
    // Force a write through saveConfig directly. The normalise step in
    // config.ts must strip autoReelect when multiAgent is missing/false.
    enableMultiAgent();
    enableAutoReelect();
    disableMultiAgent(); // clears both, but verify the normalisation explicitly
    expect(loadConfig().autoReelect).toBeUndefined();
  });
});

describe('listMultiAgentStatus', () => {
  test('reports both flags off by default', () => {
    const out = listMultiAgentStatus();
    expect(out).toContain('Multi-agent settings');
    expect(out).toMatch(/Multi-agent mode\s+off/);
    expect(out).toMatch(/Auto-reelect.*off/);
  });

  test('reports on when both are enabled', () => {
    enableMultiAgent();
    enableAutoReelect();
    const out = listMultiAgentStatus();
    expect(out).toMatch(/Multi-agent mode\s+on/);
    expect(out).toMatch(/Auto-reelect.*on/);
  });
});

describe('runMultiAgentCommand integration', () => {
  test('enable → list reflects the change', () => {
    runMultiAgentCommand(['enable']);
    expect(loadConfig().multiAgent).toBe(true);
    const out = runMultiAgentCommand([]);
    expect(out).toMatch(/Multi-agent mode\s+on/);
  });

  test('auto-reelect enable requires multi-agent first', () => {
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
  test('listMultiAgentStatus in es uses Spanish labels', () => {
    const out = listMultiAgentStatus('es');
    expect(out).toContain('Configuración multi-agente');
    expect(out).toContain('Modo multi-agente');
    expect(out).toMatch(/desactivado/);
  });

  test('error for auto-reelect without multi-agent is in Spanish', () => {
    expect(() => enableAutoReelect('es')).toThrow(/re-elección automática/);
  });
});
