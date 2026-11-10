import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import { loadConfig } from '../config.js';
import { applyAdminAction, DEFAULT_ADMIN_HELPERS, type AdminActionDeps } from './actions.js';
import type { AdminInput } from './descriptor.js';
import type { AdminItem, AdminState } from '../messages.js';

/* S2: the admin action allowlist. Config writes go to a throwaway data dir
 * (the one place config.ts asks "where do I live?"), and every writer runs
 * through a spy wrapped around the EXISTING helper, so each test proves the
 * action used the same write path as the CLI. */

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-admin-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Fresh input on every call, re-reading config.json like the real source. */
async function input(): Promise<AdminInput> {
  return {
    config: loadConfig(),
    now: Date.parse('2026-11-09T12:00:00.000Z'),
    version: '0.42.0',
    server: { running: null, installed: '0.42.0', outdated: false },
    tabsConnected: 1,
    ports: { ws: 17529, ipc: 17530 },
    extension: { path: null, connectedVersion: '0.42.0' },
    instructions: [
      { id: 'claude', displayName: 'Claude Code', state: { kind: 'installed', version: '0.42.0' } },
    ],
    clients: [{ id: 'claude', displayName: 'Claude Code', installed: true, registered: false }],
    cdpGrant: { live: false, remainingMs: null },
    update: null,
    toolNames: ['browser.list_tabs', 'browser.evaluate'],
    downloadsDir: '/d',
  };
}

function deps(over: Partial<AdminActionDeps> = {}): AdminActionDeps {
  return {
    input,
    doctor: () => Promise.resolve(['doctor line 1', 'doctor line 2']),
    checkUpdates: () => Promise.resolve(['Current: 0.42.0', 'Latest: 0.42.0']),
    ...over,
  };
}

function itemOf(state: AdminState | undefined, id: string): AdminItem | undefined {
  return state?.sections.flatMap((s) => s.items).find((i) => i.id === id);
}

describe('applyAdminAction — allowlist', () => {
  test('an unknown id is an error', async () => {
    expect(await applyAdminAction({ id: 'nope', confirm: true }, deps())).toEqual({
      ok: false,
      error: 'Unknown admin action: nope',
    });
  });

  test('a tool outside the catalogue is an unknown id, never a disabledTools entry', async () => {
    const disableTools = vi.fn(DEFAULT_ADMIN_HELPERS.disableTools);
    const result = await applyAdminAction(
      { id: 'tools.browser.nope', value: false, confirm: true },
      deps({ helpers: { disableTools } }),
    );
    expect(result).toEqual({ ok: false, error: 'Unknown admin action: tools.browser.nope' });
    expect(disableTools).not.toHaveBeenCalled();
    expect(loadConfig().disabledTools ?? []).toEqual([]);
  });

  test('readouts and process-ending entries are never actions', async () => {
    for (const id of ['status.server', 'stop', 'selfUpdate', 'cdpDirectPort', 'idleTtl', 'repo']) {
      const result = await applyAdminAction({ id, confirm: true }, deps());
      expect(result).toEqual({ ok: false, error: `${id} is read-only` });
    }
  });

  test('the error is localised from config.language', async () => {
    const save = DEFAULT_ADMIN_HELPERS.saveConfig;
    save({ language: 'es' });
    expect(await applyAdminAction({ id: 'nope' }, deps())).toEqual({
      ok: false,
      error: 'Acción de administración desconocida: nope',
    });
  });

  test('a requested language localises errors and previews for that request only', async () => {
    // config.language stays English: the request decides.
    expect(await applyAdminAction({ id: 'nope', language: 'es' }, deps())).toEqual({
      ok: false,
      error: 'Acción de administración desconocida: nope',
    });
    const result = await applyAdminAction(
      { id: 'tools.browser.evaluate', value: false, language: 'es' },
      deps(),
    );
    expect(result).toMatchObject({
      preview: 'Deshabilitar la tool browser.evaluate para todos los agentes',
    });
    expect(loadConfig().language).toBeUndefined();
  });

  test('an applied action returns its fresh state in the requested language', async () => {
    const result = await applyAdminAction({ id: 'doctor', language: 'es' }, deps());
    if (!result.ok || !result.applied) throw new Error('not applied');
    expect(result.state?.ui.language).toBe('es');
  });

  test('without a requested language the configured one still decides', async () => {
    DEFAULT_ADMIN_HELPERS.saveConfig({ language: 'es' });
    const result = await applyAdminAction({ id: 'doctor' }, deps());
    if (!result.ok || !result.applied) throw new Error('not applied');
    expect(result.state?.ui.language).toBe('es');
  });

  test('never throws: a failing source becomes ok:false', async () => {
    const result = await applyAdminAction(
      { id: 'doctor' },
      deps({ input: () => Promise.reject(new Error('disk on fire')) }),
    );
    expect(result).toEqual({ ok: false, error: 'disk on fire' });
  });
});

describe('applyAdminAction — confirm step', () => {
  test('a disk write without confirm returns a localised one-line preview and writes nothing', async () => {
    const disableTools = vi.fn(DEFAULT_ADMIN_HELPERS.disableTools);
    const result = await applyAdminAction(
      { id: 'tools.browser.evaluate', value: false },
      deps({ helpers: { disableTools } }),
    );
    expect(result).toEqual({
      ok: true,
      applied: false,
      needsConfirm: true,
      preview: 'Disable tool browser.evaluate for every agent',
    });
    expect(disableTools).not.toHaveBeenCalled();
    expect(loadConfig().disabledTools ?? []).toEqual([]);
  });

  test('previews for the other writers', async () => {
    const preview = async (id: string, value?: string | boolean): Promise<string | undefined> => {
      const r = await applyAdminAction({ id, ...(value !== undefined ? { value } : {}) }, deps());
      return r.ok && !r.applied ? r.preview : undefined;
    };
    expect(await preview('multiAgent', false)).toBe('Turn off: Multi-agent mode');
    expect(await preview('language', 'es')).toBe('Set Console language to Español');
    expect(await preview('instructions.install.claude')).toBe(
      "Write the browser-link instructions block into Claude Code's file",
    );
    expect(await preview('client.register.claude')).toBe(
      "Register browser-link in Claude Code's MCP config",
    );
  });

  test('es preview', async () => {
    DEFAULT_ADMIN_HELPERS.saveConfig({ language: 'es' });
    const r = await applyAdminAction({ id: 'tools.browser.evaluate', value: false }, deps());
    expect(r).toMatchObject({
      preview: 'Deshabilitar la tool browser.evaluate para todos los agentes',
    });
  });
});

describe('applyAdminAction — apply through the existing helpers', () => {
  test('disabling a tool goes through disableTools and returns the fresh state', async () => {
    const disableTools = vi.fn(DEFAULT_ADMIN_HELPERS.disableTools);
    const result = await applyAdminAction(
      { id: 'tools.browser.evaluate', value: false, confirm: true },
      deps({ helpers: { disableTools } }),
    );
    expect(disableTools).toHaveBeenCalledWith(['browser.evaluate'], 'en');
    expect(loadConfig().disabledTools).toEqual(['browser.evaluate']);
    expect(result).toMatchObject({ ok: true, applied: true });
    if (!result.ok || !result.applied) throw new Error('not applied');
    expect(result.requiresRestart).toBeUndefined();
    expect(itemOf(result.state, 'tools.browser.evaluate')?.value).toBe(false);
  });

  test('enabling a tool goes through enableTools', async () => {
    DEFAULT_ADMIN_HELPERS.saveConfig({ disabledTools: ['browser.evaluate'] });
    const enableTools = vi.fn(DEFAULT_ADMIN_HELPERS.enableTools);
    await applyAdminAction(
      { id: 'tools.browser.evaluate', value: true, confirm: true },
      deps({ helpers: { enableTools } }),
    );
    expect(enableTools).toHaveBeenCalledWith(['browser.evaluate'], 'en');
    expect(loadConfig().disabledTools ?? []).toEqual([]);
  });

  test('multi-agent goes through the multi-agent helpers and requires a restart', async () => {
    const disableMultiAgent = vi.fn(DEFAULT_ADMIN_HELPERS.disableMultiAgent);
    const result = await applyAdminAction(
      { id: 'multiAgent', value: false, confirm: true },
      deps({ helpers: { disableMultiAgent } }),
    );
    expect(disableMultiAgent).toHaveBeenCalledWith('en');
    expect(loadConfig().multiAgent).toBe(false);
    expect(result).toMatchObject({ ok: true, applied: true, requiresRestart: true });
  });

  test('auto-reelect and instructions auto-refresh require a restart', async () => {
    const enableAutoReelect = vi.fn(DEFAULT_ADMIN_HELPERS.enableAutoReelect);
    expect(
      await applyAdminAction(
        { id: 'autoReelect', value: true, confirm: true },
        deps({ helpers: { enableAutoReelect } }),
      ),
    ).toMatchObject({ ok: true, applied: true, requiresRestart: true });
    expect(enableAutoReelect).toHaveBeenCalledWith('en');
    const saveConfig = vi.fn(DEFAULT_ADMIN_HELPERS.saveConfig);
    expect(
      await applyAdminAction(
        { id: 'instructionsAutoRefresh', value: false, confirm: true },
        deps({ helpers: { saveConfig } }),
      ),
    ).toMatchObject({ ok: true, applied: true, requiresRestart: true });
    expect(saveConfig).toHaveBeenCalledWith({ instructionsAutoRefresh: false });
  });

  test('a helper refusal comes back as ok:false with its own message', async () => {
    DEFAULT_ADMIN_HELPERS.saveConfig({ multiAgent: false });
    const result = await applyAdminAction(
      { id: 'autoReelect', value: true, confirm: true },
      deps(),
    );
    expect(result).toEqual({
      ok: false,
      error: 'Cannot enable auto-reelect while multi-agent mode is off. Enable multi-agent first.',
    });
  });

  test('cdp-direct goes through the config command setters', async () => {
    const setCdpDirectEnabled = vi.fn(DEFAULT_ADMIN_HELPERS.setCdpDirectEnabled);
    const setCdpDirectGrantTtl = vi.fn(DEFAULT_ADMIN_HELPERS.setCdpDirectGrantTtl);
    const helpers = { setCdpDirectEnabled, setCdpDirectGrantTtl };
    await applyAdminAction(
      { id: 'cdpDirectEnabled', value: true, confirm: true },
      deps({ helpers }),
    );
    await applyAdminAction(
      { id: 'cdpDirectGrantTtlMinutes', value: '240', confirm: true },
      deps({ helpers }),
    );
    expect(setCdpDirectEnabled).toHaveBeenCalledWith('true', 'en');
    expect(setCdpDirectGrantTtl).toHaveBeenCalledWith('240', 'en');
    expect(loadConfig().cdpDirectEnabled).toBe(true);
    expect(loadConfig().cdpDirectGrantTtlMinutes).toBe(240);
  });

  test('activity toggles write their config key', async () => {
    const saveConfig = vi.fn(DEFAULT_ADMIN_HELPERS.saveConfig);
    await applyAdminAction(
      { id: 'activityRecordPayloads', value: false, confirm: true },
      deps({ helpers: { saveConfig } }),
    );
    expect(saveConfig).toHaveBeenCalledWith({ activityRecordPayloads: false });
    expect(loadConfig().activityRecordPayloads).toBe(false);
  });

  test('the language select saves and the fresh state comes back in that language', async () => {
    const result = await applyAdminAction({ id: 'language', value: 'es', confirm: true }, deps());
    expect(loadConfig().language).toBe('es');
    if (!result.ok || !result.applied) throw new Error('not applied');
    expect(result.state?.ui.language).toBe('es');
  });

  test('instructions install/uninstall go through the instructions helpers', async () => {
    const installInstructionsFor = vi.fn(() => ({
      client: 'claude' as const,
      displayName: 'Claude Code',
      filePath: '/x',
      state: { kind: 'installed' as const, version: '0.42.0' },
      message: 'Installed block.',
      ok: true,
    }));
    const uninstallInstructionsFor = vi.fn(() => ({
      client: 'claude' as const,
      displayName: 'Claude Code',
      filePath: '/x',
      state: { kind: 'installed' as const, version: '0.42.0' },
      message: 'refused',
      ok: false,
    }));
    const helpers = { installInstructionsFor, uninstallInstructionsFor };
    expect(
      await applyAdminAction(
        { id: 'instructions.install.claude', confirm: true },
        deps({ helpers }),
      ),
    ).toMatchObject({ ok: true, applied: true, output: ['Installed block.'] });
    expect(installInstructionsFor).toHaveBeenCalledWith('claude');
    expect(
      await applyAdminAction(
        { id: 'instructions.uninstall.claude', confirm: true },
        deps({ helpers }),
      ),
    ).toEqual({ ok: false, error: 'refused' });
  });

  test('client registration goes through installFor', async () => {
    const installFor = vi.fn(() => ({
      client: 'claude' as const,
      displayName: 'Claude Code',
      installedClient: true,
      message: 'Registered.',
    }));
    const result = await applyAdminAction(
      { id: 'client.register.claude', confirm: true },
      deps({ helpers: { installFor } }),
    );
    expect(installFor).toHaveBeenCalledWith('claude');
    expect(result).toMatchObject({ ok: true, applied: true, output: ['Registered.'] });
  });
});

describe('applyAdminAction — validation', () => {
  test('a toggle needs a boolean', async () => {
    const result = await applyAdminAction(
      { id: 'multiAgent', value: 'yes', confirm: true },
      deps(),
    );
    expect(result).toEqual({ ok: false, error: 'Invalid value for multiAgent' });
    expect(loadConfig().multiAgent).toBe(true);
  });

  test('a select only takes one of its options', async () => {
    expect(await applyAdminAction({ id: 'language', value: 'fr', confirm: true }, deps())).toEqual({
      ok: false,
      error: 'Invalid value for language',
    });
    expect(
      await applyAdminAction(
        { id: 'cdpDirectGrantTtlMinutes', value: '99999', confirm: true },
        deps(),
      ),
    ).toEqual({ ok: false, error: 'Invalid value for cdpDirectGrantTtlMinutes' });
    expect(loadConfig().language).toBeUndefined();
  });

  test('validation runs before the confirm step', async () => {
    expect(await applyAdminAction({ id: 'multiAgent', value: 3 }, deps())).toEqual({
      ok: false,
      error: 'Invalid value for multiAgent',
    });
  });
});

describe('applyAdminAction — read-only buttons', () => {
  test('doctor runs without confirm and returns its lines', async () => {
    const doctor = vi.fn(() => Promise.resolve(['ok 1', 'ok 2']));
    const result = await applyAdminAction({ id: 'doctor' }, deps({ doctor }));
    expect(doctor).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, applied: true, output: ['ok 1', 'ok 2'] });
  });

  test('updates.check runs without confirm and returns its lines', async () => {
    const checkUpdates = vi.fn(() => Promise.resolve(['Latest: 0.43.0']));
    const result = await applyAdminAction({ id: 'updates.check' }, deps({ checkUpdates }));
    expect(checkUpdates).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, applied: true, output: ['Latest: 0.43.0'] });
  });
});
