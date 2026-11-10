import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import { loadConfig } from '../config.js';
import * as toolsCommand from '../commands/tools.js';
import * as configCommand from '../commands/config.js';
import * as installCommand from '../commands/install.js';
import {
  applyAdminAction,
  DEFAULT_ADMIN_HELPERS,
  type AdminActionDeps,
  type AdminHelpers,
} from './actions.js';
import type { AdminInput } from './descriptor.js';

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

describe('applyAdminAction — allowlist', () => {
  test('an unknown id is an error', async () => {
    expect(await applyAdminAction({ id: 'nope', confirm: true }, deps())).toEqual({
      ok: false,
      error: 'Unknown admin action: nope',
    });
  });

  test('a tool outside the catalogue is an unknown id, never a disabledTools entry', async () => {
    const result = await applyAdminAction(
      { id: 'tools.browser.nope', value: false, confirm: true },
      deps(),
    );
    expect(result).toEqual({ ok: false, error: 'Unknown admin action: tools.browser.nope' });
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
      { id: 'multiAgent', value: false, language: 'es' },
      deps(),
    );
    expect(result).toMatchObject({ preview: 'Desactivar: Modo multi-agente' });
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

/** Every injectable helper wrapped in a spy, plus spies on the CLI writers the
 * console keeps for the elevating settings (tools, cdp-direct, registration). */
function spyEverything() {
  const helpers = Object.fromEntries(
    Object.entries(DEFAULT_ADMIN_HELPERS).map(([k, fn]) => [k, vi.fn(fn as never)]),
  ) as unknown as AdminHelpers;
  const cli = [
    vi.spyOn(toolsCommand, 'enableTools'),
    vi.spyOn(toolsCommand, 'disableTools'),
    vi.spyOn(configCommand, 'setCdpDirectEnabled'),
    vi.spyOn(configCommand, 'setCdpDirectGrantTtl'),
    vi.spyOn(installCommand, 'installFor'),
  ];
  const doctor = vi.fn(() => Promise.resolve(['doctor']));
  const checkUpdates = vi.fn(() => Promise.resolve(['updates']));
  const all = [...Object.values(helpers), ...cli, doctor, checkUpdates] as Array<{
    mock: { calls: unknown[] };
  }>;
  return {
    deps: deps({ helpers, doctor, checkUpdates }),
    calls: () => all.reduce((n, spy) => n + spy.mock.calls.length, 0),
    restore: () => {
      for (const spy of cli) spy.mockRestore();
    },
  };
}

describe('applyAdminAction — elevating settings are console-only (arch ask-3 condition 2)', () => {
  const cases: Array<[string, string | boolean]> = [
    ['cdpDirectEnabled', true],
    ['cdpDirectGrantTtlMinutes', '240'],
    ['tools.browser.evaluate', false],
    ['client.register.claude', true],
  ];
  for (const [id, value] of cases) {
    test(`${id} with confirm:true is refused and calls no helper`, async () => {
      const spies = spyEverything();
      const before = loadConfig();
      try {
        const result = await applyAdminAction({ id, value, confirm: true }, spies.deps);
        expect(result).toEqual({ ok: false, error: `${id} is read-only` });
        expect(spies.calls()).toBe(0);
        expect(loadConfig()).toEqual(before);
      } finally {
        spies.restore();
      }
    });
  }
});

describe('applyAdminAction — confirm step', () => {
  test('a disk write without confirm returns a localised one-line preview and writes nothing', async () => {
    const disableMultiAgent = vi.fn(DEFAULT_ADMIN_HELPERS.disableMultiAgent);
    const result = await applyAdminAction(
      { id: 'multiAgent', value: false },
      deps({ helpers: { disableMultiAgent } }),
    );
    expect(result).toEqual({
      ok: true,
      applied: false,
      needsConfirm: true,
      preview: 'Turn off: Multi-agent mode',
    });
    expect(disableMultiAgent).not.toHaveBeenCalled();
    expect(loadConfig().multiAgent).toBe(true);
  });

  test('previews for the other writers', async () => {
    const preview = async (id: string, value?: string | boolean): Promise<string | undefined> => {
      const r = await applyAdminAction({ id, ...(value !== undefined ? { value } : {}) }, deps());
      return r.ok && !r.applied ? r.preview : undefined;
    };
    expect(await preview('language', 'es')).toBe('Set Console language to Español');
    expect(await preview('instructions.install.claude')).toBe(
      "Write the browser-link instructions block into Claude Code's file",
    );
    expect(await preview('instructions.uninstall.claude')).toBe(
      "Remove the browser-link instructions block from Claude Code's file",
    );
  });

  test('es preview', async () => {
    DEFAULT_ADMIN_HELPERS.saveConfig({ language: 'es' });
    const r = await applyAdminAction({ id: 'instructions.install.claude' }, deps());
    expect(r).toMatchObject({
      preview: 'Escribir el bloque de instrucciones de browser-link en el archivo de Claude Code',
    });
  });
});

describe('applyAdminAction — apply through the existing helpers', () => {
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

  test('activity toggles write their config key', async () => {
    const saveConfig = vi.fn(DEFAULT_ADMIN_HELPERS.saveConfig);
    await applyAdminAction(
      { id: 'activityRecordPayloads', value: false, confirm: true },
      deps({ helpers: { saveConfig } }),
    );
    expect(saveConfig).toHaveBeenCalledWith({ activityRecordPayloads: false });
    expect(loadConfig().activityRecordPayloads).toBe(false);
    expect(
      await applyAdminAction(
        { id: 'activityEnabled', value: false, confirm: true },
        deps({ helpers: { saveConfig } }),
      ),
    ).toMatchObject({ ok: true, applied: true, requiresRestart: true });
    expect(loadConfig().activityEnabled).toBe(false);
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
