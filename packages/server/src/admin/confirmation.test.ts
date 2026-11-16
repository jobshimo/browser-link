import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { routeRequestMessage } from '../bridge/ws-bridge.js';
import type { AdminActionResult, ServerToExtension } from '../messages.js';
import { applyAdminAction, DEFAULT_ADMIN_HELPERS, type AdminActionDeps } from './actions.js';
import {
  CONFIRMATION_TTL_MS,
  MAX_PENDING_CONFIRMATIONS,
  createConfirmationCodes,
} from './confirmation.js';
import type { AdminInput } from './descriptor.js';
import { createPrimaryAdminHandlers } from './primary.js';

/* D11: the server, not the caller, enforces preview-then-apply. A preview
 * hands out a single-use, short-lived code bound to that action and value;
 * a write happens only with that code. Data dir and HOME are temp dirs; the
 * update check is stubbed (no network). */

const saved = {
  home: process.env.HOME,
  profile: process.env.USERPROFILE,
  data: process.env.BROWSER_LINK_DATA_DIR,
};
let dir: string;
let dataDir: string;
let configPath: string;
const ORIGINAL = JSON.stringify({ language: 'en' }) + '\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'browser-link-admin-confirm-'));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, ORIGINAL, 'utf8');
});

afterEach(() => {
  for (const [key, value] of [
    ['HOME', saved.home],
    ['USERPROFILE', saved.profile],
    ['BROWSER_LINK_DATA_DIR', saved.data],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const STALE =
  'This confirmation is no longer valid: it expired, was already used or was for a different change. Nothing was changed; try again.';

function stubbedCheck() {
  return vi.fn((_opts: { force?: boolean }) =>
    Promise.resolve({ current: '1.0.0', latest: '1.0.0', isNewer: false }),
  );
}

function handlers(checkUpdates = stubbedCheck()) {
  return createPrimaryAdminHandlers({
    version: '1.0.0',
    tabsConnected: () => 0,
    connectedExtensionVersion: () => null,
    checkUpdates: checkUpdates as never,
    doctor: () => Promise.resolve([]),
  });
}

function configBytes(): string {
  return readFileSync(configPath, 'utf8');
}

function codeOf(result: AdminActionResult): string {
  if (!result.ok || result.applied) throw new Error(`not a preview: ${JSON.stringify(result)}`);
  expect(typeof result.code).toBe('string');
  return result.code;
}

function resultOf(reply: ServerToExtension): AdminActionResult {
  if (reply.kind !== 'admin.action.result') throw new Error(`unexpected ${reply.kind}`);
  return reply.result;
}

describe('D11 — no code, nothing written', () => {
  test('a first frame carrying confirm:true is only a preview, through the bridge router', async () => {
    const reply = await routeRequestMessage(
      {
        kind: 'admin.action',
        request_id: 'r1',
        id: 'activityEnabled',
        value: false,
        confirm: true,
      } as never,
      handlers(),
    );
    const result = resultOf(reply as ServerToExtension);
    expect(result).toMatchObject({
      ok: true,
      applied: false,
      needsConfirm: true,
      preview: 'Turn off: Record the activity trail',
    });
    codeOf(result);
    expect(configBytes()).toBe(ORIGINAL);
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('updates.check without a code runs no check and writes nothing', async () => {
    const check = stubbedCheck();
    const result = await handlers(check).action({ id: 'updates.check', confirm: true } as never);
    expect(result).toMatchObject({ ok: true, applied: false, needsConfirm: true });
    codeOf(result);
    expect(check).not.toHaveBeenCalled();
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('an instruction file is not written on confirm:true without a code', async () => {
    const installInstructionsFor = vi.fn(() => ({ ok: true, message: 'Installed block.' }));
    const result = await applyAdminAction(
      { id: 'instructions.install.claude', confirm: true } as never,
      fakeDeps({ helpers: { installInstructionsFor } }),
    );
    expect(result).toMatchObject({ ok: true, applied: false, needsConfirm: true });
    expect(installInstructionsFor).not.toHaveBeenCalled();
  });
});

describe('D11 — a code is bound to its action and value', () => {
  test('a code from a preview of another action writes nothing', async () => {
    const admin = handlers();
    const code = codeOf(await admin.action({ id: 'activityEnabled', value: false }));
    const result = await admin.action({ id: 'activityRecordPayloads', value: false, code });
    expect(result).toEqual({ ok: false, error: STALE });
    expect(configBytes()).toBe(ORIGINAL);
  });

  test('a code from a preview of the same action with another value writes nothing', async () => {
    const admin = handlers();
    const code = codeOf(await admin.action({ id: 'language', value: 'es' }));
    const result = await admin.action({ id: 'language', value: 'en', code });
    expect(result).toEqual({ ok: false, error: STALE });
    expect(configBytes()).toBe(ORIGINAL);
  });

  test('a code made up by the caller writes nothing', async () => {
    const result = await handlers().action({ id: 'activityEnabled', value: false, code: 'x' });
    expect(result).toEqual({ ok: false, error: STALE });
    expect(configBytes()).toBe(ORIGINAL);
  });

  test('the refusal is in the requested language', async () => {
    const result = await handlers().action({
      id: 'activityEnabled',
      value: false,
      code: 'x',
      language: 'es',
    });
    expect(result).toEqual({
      ok: false,
      error:
        'Esta confirmación ya no es válida: caducó, ya se usó o correspondía a otro cambio. No se cambió nada; vuelva a intentarlo.',
    });
  });
});

describe('D11 — single use', () => {
  test('a code applies once; the same code a second time writes nothing', async () => {
    const admin = handlers();
    const code = codeOf(await admin.action({ id: 'activityEnabled', value: false }));
    expect(await admin.action({ id: 'activityEnabled', value: false, code })).toMatchObject({
      ok: true,
      applied: true,
    });
    expect(loadConfig().activityEnabled).toBe(false);
    writeFileSync(configPath, ORIGINAL, 'utf8');
    const again = await admin.action({ id: 'activityEnabled', value: false, code });
    expect(again).toEqual({ ok: false, error: STALE });
    expect(configBytes()).toBe(ORIGINAL);
  });

  test('a code presented for the wrong action is spent too', async () => {
    const admin = handlers();
    const code = codeOf(await admin.action({ id: 'activityEnabled', value: false }));
    await admin.action({ id: 'activityRecordPayloads', value: false, code });
    expect(await admin.action({ id: 'activityEnabled', value: false, code })).toEqual({
      ok: false,
      error: STALE,
    });
    expect(configBytes()).toBe(ORIGINAL);
  });
});

/** Static facts for applyAdminAction, re-reading config.json like the real source. */
async function input(): Promise<AdminInput> {
  return {
    config: loadConfig(),
    now: Date.parse('2026-11-16T12:00:00.000Z'),
    version: '1.0.0',
    server: { running: null, installed: '1.0.0', outdated: false },
    tabsConnected: 1,
    ports: { ws: 17529, ipc: 17530 },
    extension: { path: null, connectedVersion: '1.0.0' },
    instructions: [
      { id: 'claude', displayName: 'Claude Code', state: { kind: 'installed', version: '1.0.0' } },
    ],
    clients: [],
    cdpGrant: { live: false, remainingMs: null },
    update: null,
    toolNames: [],
    downloadsDir: '/d',
  };
}

function fakeDeps(over: Partial<AdminActionDeps> = {}): AdminActionDeps {
  return {
    input,
    doctor: () => Promise.resolve([]),
    checkUpdates: () => Promise.resolve([]),
    confirmations: createConfirmationCodes(),
    ...over,
  };
}

describe('confirmation store bounds', () => {
  test('past the cap the oldest outstanding code is dropped', () => {
    const codes = createConfirmationCodes();
    const binding = { id: 'activityEnabled', value: false };
    const first = codes.issue(binding);
    const rest = Array.from({ length: MAX_PENDING_CONFIRMATIONS }, () => codes.issue(binding));
    expect(codes.redeem(first, binding)).toBe(false);
    expect(codes.redeem(rest[rest.length - 1] ?? '', binding)).toBe(true);
  });

  test('a boolean value and the same text as a string are different actions', () => {
    const codes = createConfirmationCodes();
    const code = codes.issue({ id: 'activityEnabled', value: false });
    expect(codes.redeem(code, { id: 'activityEnabled', value: 'false' })).toBe(false);
  });
});

describe('D11 — short-lived', () => {
  test('a code past its lifetime writes nothing; one just inside it applies', async () => {
    let now = 1_000_000;
    const confirmations = createConfirmationCodes({ now: () => now });
    const saveConfig = vi.fn(DEFAULT_ADMIN_HELPERS.saveConfig);
    const deps = fakeDeps({ confirmations, helpers: { saveConfig } });

    const late = codeOf(await applyAdminAction({ id: 'activityEnabled', value: false }, deps));
    now += CONFIRMATION_TTL_MS + 1;
    expect(
      await applyAdminAction({ id: 'activityEnabled', value: false, code: late }, deps),
    ).toEqual({ ok: false, error: STALE });
    expect(saveConfig).not.toHaveBeenCalled();
    expect(configBytes()).toBe(ORIGINAL);

    const inTime = codeOf(await applyAdminAction({ id: 'activityEnabled', value: false }, deps));
    now += CONFIRMATION_TTL_MS;
    expect(
      await applyAdminAction({ id: 'activityEnabled', value: false, code: inTime }, deps),
    ).toMatchObject({ ok: true, applied: true });
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });
});

describe('D11 — the valid path', () => {
  test('preview then apply writes the config once', async () => {
    const admin = handlers();
    const preview = await admin.action({ id: 'activityEnabled', value: false });
    expect(configBytes()).toBe(ORIGINAL);
    const result = await admin.action({
      id: 'activityEnabled',
      value: false,
      code: codeOf(preview),
    });
    expect(result).toMatchObject({ ok: true, applied: true, requiresRestart: true });
    expect(configBytes()).toBe(
      JSON.stringify({ language: 'en', activityEnabled: false }, null, 2) + '\n',
    );
  });

  test('preview then apply installs the instruction block once', async () => {
    const installInstructionsFor = vi.fn(() => ({ ok: true, message: 'Installed block.' }));
    const deps = fakeDeps({ helpers: { installInstructionsFor } });
    const code = codeOf(await applyAdminAction({ id: 'instructions.install.claude' }, deps));
    expect(installInstructionsFor).not.toHaveBeenCalled();
    expect(await applyAdminAction({ id: 'instructions.install.claude', code }, deps)).toMatchObject(
      { ok: true, applied: true, output: ['Installed block.'] },
    );
    expect(installInstructionsFor).toHaveBeenCalledTimes(1);
    expect(installInstructionsFor).toHaveBeenCalledWith('claude');
  });

  test('updates.check previews, then runs the forced check once with its code', async () => {
    const check = stubbedCheck();
    const admin = handlers(check);
    const preview = await admin.action({ id: 'updates.check' });
    expect(preview).toMatchObject({
      preview:
        'Ask the npm registry for the latest version now and save the answer in update-check.json',
    });
    const result = await admin.action({ id: 'updates.check', code: codeOf(preview) });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({ force: true });
  });
});
