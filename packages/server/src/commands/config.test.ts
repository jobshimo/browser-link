import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import {
  getFlowRecordingLine,
  getIdleTtlLine,
  listConfig,
  runConfigCommand,
  setFlowRecording,
  setIdleTtl,
} from './config.js';
import { loadConfig } from '../config.js';
import { IpcServer } from '../bridge/server.js';
import { generateToken, writeToken } from '../bridge/token.js';
import type { DispatchDeps } from '../bridge/dispatch.js';
import type { PeerProcess } from '../auth/process-identity.js';

const TEST_PEER_LOOKUP = (): Promise<PeerProcess> =>
  Promise.resolve({ pid: process.pid, binaryName: 'node' });

const STUB_DEPS: DispatchDeps = {
  browserTools: {
    listTabs: () => [],
    callBrowserTool: () => Promise.reject(new Error('not used in this test')),
  },
  disabledTools: () => [],
};

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-config-cmd-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('getIdleTtlLine / listConfig', () => {
  test('reports "not set via CLI" for a fresh install', () => {
    expect(getIdleTtlLine()).toMatch(/not set via CLI/);
    expect(listConfig()).toContain('browser-link config');
  });

  test('reports minutes after a set', async () => {
    await setIdleTtl('15');
    expect(getIdleTtlLine()).toMatch(/15 min/);
  });

  test('reports "never" after set to 0', async () => {
    await setIdleTtl('never');
    expect(getIdleTtlLine()).toMatch(/never/);
  });

  test('es locale uses Spanish labels', async () => {
    await setIdleTtl('20', 'es');
    expect(getIdleTtlLine('es')).toMatch(/20 min/);
    expect(listConfig('es')).toContain('Configuración de browser-link');
  });
});

describe('setIdleTtl parsing + clamping', () => {
  test('accepts "never" and persists 0', async () => {
    await setIdleTtl('never');
    expect(loadConfig().idleTtlMinutes).toBe(0);
  });

  test('accepts "0" as an alias for never', async () => {
    await setIdleTtl('0');
    expect(loadConfig().idleTtlMinutes).toBe(0);
  });

  test('accepts an in-range integer unchanged', async () => {
    await setIdleTtl('45');
    expect(loadConfig().idleTtlMinutes).toBe(45);
  });

  test('clamps an out-of-range integer to the boundary and notes it', async () => {
    const msg = await setIdleTtl('99999');
    expect(loadConfig().idleTtlMinutes).toBe(1440);
    expect(msg).toMatch(/clamped from 99999 to 1440/);
  });

  test('clamps a value below the minimum up to 1', async () => {
    await setIdleTtl('-5');
    expect(loadConfig().idleTtlMinutes).toBe(1);
  });

  test('rejects a non-numeric value with a clear error, without persisting', async () => {
    await expect(setIdleTtl('soon')).rejects.toThrow(/Invalid idle-ttl value/);
    expect(loadConfig().idleTtlMinutes).toBeUndefined();
  });

  test('rejects a decimal value', async () => {
    await expect(setIdleTtl('12.5')).rejects.toThrow(/Invalid idle-ttl value/);
  });

  test('every set stamps a fresh idleTtlUpdatedAt', async () => {
    const before = Date.now();
    await setIdleTtl('10');
    const cfg = loadConfig();
    expect(cfg.idleTtlUpdatedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('setIdleTtl without a running primary', () => {
  test('reports the value was saved and will apply on next connect', async () => {
    const msg = await setIdleTtl('10');
    expect(msg).toMatch(/Idle-disconnect TTL set to 10 min/);
    expect(msg).toMatch(/apply the next time a tab connects/);
  });
});

describe('setIdleTtl with a running primary (live push)', () => {
  let server: IpcServer | null = null;
  let notifiedCalls: Array<{ idleTtlMinutes: number; updatedAt: number }> = [];

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    notifiedCalls = [];
  });

  test('pushes to connected tabs and reports the count', async () => {
    server = new IpcServer(STUB_DEPS, {
      port: 0,
      peerLookup: TEST_PEER_LOOKUP,
      pushSettings: (settings) => {
        notifiedCalls.push(settings);
        return 2; // pretend two tabs were notified
      },
    });
    await server.start();
    const { host, port } = server.boundAddress();

    const msg = await setIdleTtl('25', 'en', { host, port });
    expect(msg).toMatch(/Pushed immediately to 2 connected tab\(s\)/);
    expect(notifiedCalls).toHaveLength(1);
    expect(notifiedCalls[0]?.idleTtlMinutes).toBe(25);
  });

  test('reports zero-tabs-connected distinctly from unreachable', async () => {
    server = new IpcServer(STUB_DEPS, {
      port: 0,
      peerLookup: TEST_PEER_LOOKUP,
      pushSettings: () => 0,
    });
    await server.start();
    const { host, port } = server.boundAddress();

    const msg = await setIdleTtl('25', 'en', { host, port });
    expect(msg).toMatch(/No tabs are currently connected/);
  });

  test('reports a token rejection distinctly from an unreachable primary', async () => {
    server = new IpcServer(STUB_DEPS, {
      port: 0,
      peerLookup: TEST_PEER_LOOKUP,
      pushSettings: () => 1,
    });
    await server.start();
    // Desync the on-disk token from the one the running primary rotated at
    // startup — the situation after a primary restarts mid-command. The
    // hello then gets an explicit hello-reject, which must NOT be reported
    // as "no primary running / multi-agent off".
    writeToken(generateToken());
    const { host, port } = server.boundAddress();

    const msg = await setIdleTtl('25', 'en', { host, port });
    expect(msg).toMatch(/rejected the push/);
    expect(msg).not.toMatch(/Could not reach/);
    // The value itself is still persisted regardless of the push outcome.
    expect(loadConfig().idleTtlMinutes).toBe(25);
  });
});

describe('getFlowRecordingLine / listConfig', () => {
  test('reports "not set via CLI" for a fresh install', () => {
    expect(getFlowRecordingLine()).toMatch(/not set via CLI/);
    expect(listConfig()).toContain('flow-recording');
  });

  test('reports enabled after set to on', async () => {
    await setFlowRecording('on');
    expect(getFlowRecordingLine()).toMatch(/^\s*flow-recording\s+enabled$/);
  });

  test('reports disabled after set to off', async () => {
    await setFlowRecording('off');
    expect(getFlowRecordingLine()).toMatch(/^\s*flow-recording\s+disabled$/);
  });

  test('es locale uses Spanish labels', async () => {
    await setFlowRecording('on', 'es');
    expect(getFlowRecordingLine('es')).toMatch(/habilitado/);
  });
});

describe('setFlowRecording parsing', () => {
  test.each(['on', 'true', 'enabled', 'enable', '1'])('accepts "%s" as enabled', async (raw) => {
    await setFlowRecording(raw);
    expect(loadConfig().flowRecordingEnabled).toBe(true);
  });

  test.each(['off', 'false', 'disabled', 'disable', '0'])(
    'accepts "%s" as disabled',
    async (raw) => {
      await setFlowRecording(raw);
      expect(loadConfig().flowRecordingEnabled).toBe(false);
    },
  );

  test('is case-insensitive and trims whitespace', async () => {
    await setFlowRecording('  ON  ');
    expect(loadConfig().flowRecordingEnabled).toBe(true);
  });

  test('rejects an unrecognized value with a clear error, without persisting', async () => {
    await expect(setFlowRecording('maybe')).rejects.toThrow(/Invalid flow-recording value/);
    expect(loadConfig().flowRecordingEnabled).toBeUndefined();
  });

  test('every set stamps a fresh flowRecordingUpdatedAt', async () => {
    const before = Date.now();
    await setFlowRecording('on');
    const cfg = loadConfig();
    expect(cfg.flowRecordingUpdatedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('setFlowRecording without a running primary', () => {
  test('reports the value was saved and will apply on next connect', async () => {
    const msg = await setFlowRecording('on');
    expect(msg).toMatch(/Flow recording set to enabled/);
    expect(msg).toMatch(/apply the next time a tab connects/);
  });
});

describe('setFlowRecording with a running primary (live push)', () => {
  let server: IpcServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  test('pushes to connected tabs and reports the count', async () => {
    const notifiedCalls: unknown[] = [];
    server = new IpcServer(STUB_DEPS, {
      port: 0,
      peerLookup: TEST_PEER_LOOKUP,
      pushSettings: (settings) => {
        notifiedCalls.push(settings);
        return 3;
      },
    });
    await server.start();
    const { host, port } = server.boundAddress();

    const msg = await setFlowRecording('on', 'en', { host, port });
    expect(msg).toMatch(/Pushed immediately to 3 connected tab\(s\)/);
    expect(notifiedCalls).toHaveLength(1);
    expect((notifiedCalls[0] as { flowRecordingEnabled?: boolean }).flowRecordingEnabled).toBe(
      true,
    );
  });
});

describe('runConfigCommand dispatch', () => {
  test('bare "get" lists everything', async () => {
    const out = await runConfigCommand([]);
    expect(out).toContain('browser-link config');
  });

  test('"get idle-ttl" returns just the one line', async () => {
    const out = await runConfigCommand(['get', 'idle-ttl']);
    expect(out).toMatch(/idle-ttl/);
  });

  test('"get" with an unknown key throws', async () => {
    await expect(runConfigCommand(['get', 'bogus'])).rejects.toThrow(/Unknown config key/);
  });

  test('"set idle-ttl <value>" round-trips through loadConfig', async () => {
    await runConfigCommand(['set', 'idle-ttl', '5']);
    expect(loadConfig().idleTtlMinutes).toBe(5);
  });

  test('"set" without a value throws a usage error', async () => {
    await expect(runConfigCommand(['set', 'idle-ttl'])).rejects.toThrow(/Usage/);
  });

  test('"set" with an unknown key throws', async () => {
    await expect(runConfigCommand(['set', 'bogus', '5'])).rejects.toThrow(/Unknown config key/);
  });

  test('an unknown action throws', async () => {
    await expect(runConfigCommand(['bogus'])).rejects.toThrow(/Unknown config action/);
  });

  test('"get flow-recording" returns just the one line', async () => {
    const out = await runConfigCommand(['get', 'flow-recording']);
    expect(out).toMatch(/flow-recording/);
  });

  test('"set flow-recording <value>" round-trips through loadConfig', async () => {
    await runConfigCommand(['set', 'flow-recording', 'on']);
    expect(loadConfig().flowRecordingEnabled).toBe(true);
  });

  test('"set flow-recording" without a value throws a usage error', async () => {
    await expect(runConfigCommand(['set', 'flow-recording'])).rejects.toThrow(/Usage/);
  });
});
