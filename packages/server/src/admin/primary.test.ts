import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import { createPrimaryAdminHandlers } from './primary.js';
import type { AdminState } from '../messages.js';

/* The primary's wiring: in-process server rows, live tab count, the update
 * check deferred to the first describe and forced by its button. */

let dataDir: string;
let getDataDirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-admin-primary-'));
  getDataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  getDataDirSpy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

function value(state: AdminState, id: string): unknown {
  return state.sections.flatMap((s) => s.items).find((i) => i.id === id)?.value;
}

describe('createPrimaryAdminHandlers', () => {
  test('describe reports this process as the running server and the live tabs', async () => {
    const checkUpdates = vi.fn(() =>
      Promise.resolve({ current: '0.42.0', latest: '0.43.0', isNewer: true }),
    );
    const admin = createPrimaryAdminHandlers({
      version: '0.42.0',
      tabsConnected: () => 3,
      connectedExtensionVersion: () => '0.42.0',
      checkUpdates,
    });
    const first = await admin.describe();
    expect(value(first, 'status.server')).toBe('running v0.42.0');
    expect(value(first, 'status.pid')).toBe(process.pid);
    expect(value(first, 'status.tabs')).toBe(3);
    expect(value(first, 'status.extension')).toBe('v0.42.0 (aligned)');
    expect(checkUpdates).toHaveBeenCalledWith({});
    // The background check lands for the next describe; it runs only once.
    const second = await admin.describe();
    expect(value(second, 'status.update')).toBe('v0.43.0 available');
    expect(checkUpdates).toHaveBeenCalledTimes(1);
  });

  test('updates.check forces a fresh check and returns its lines', async () => {
    const checkUpdates = vi.fn(() =>
      Promise.resolve({ current: '0.42.0', latest: '0.42.0', isNewer: false }),
    );
    const admin = createPrimaryAdminHandlers({
      version: '0.42.0',
      tabsConnected: () => 0,
      connectedExtensionVersion: () => null,
      checkUpdates,
    });
    const result = await admin.action({ id: 'updates.check' });
    expect(checkUpdates).toHaveBeenCalledWith({ force: true });
    expect(result).toMatchObject({ ok: true, applied: true });
    if (!result.ok || !result.applied) throw new Error('not applied');
    expect(result.output?.join('\n')).toContain('0.42.0');
    expect(value(result.state as AdminState, 'status.update')).toBe('up to date');
  });

  test('describe and action render in the requested language', async () => {
    const admin = createPrimaryAdminHandlers({
      version: '0.42.0',
      tabsConnected: () => 0,
      connectedExtensionVersion: () => null,
      checkUpdates: () => Promise.resolve({ current: '0.42.0', latest: null, isNewer: false }),
      doctor: () => Promise.resolve(['ok']),
    });
    expect((await admin.describe({ language: 'es' })).ui.language).toBe('es');
    expect((await admin.describe()).ui.language).toBe('en');
    const result = await admin.action({ id: 'doctor', language: 'es' });
    if (!result.ok || !result.applied) throw new Error('not applied');
    expect(result.state?.ui.language).toBe('es');
  });

  test('doctor runs only on its button', async () => {
    const doctor = vi.fn(() => Promise.resolve(['all good']));
    const admin = createPrimaryAdminHandlers({
      version: '0.42.0',
      tabsConnected: () => 0,
      connectedExtensionVersion: () => null,
      checkUpdates: () => Promise.resolve({ current: '0.42.0', latest: null, isNewer: false }),
      doctor,
    });
    await admin.describe();
    expect(doctor).not.toHaveBeenCalled();
    expect(await admin.action({ id: 'doctor' })).toMatchObject({ output: ['all good'] });
    expect(doctor).toHaveBeenCalledTimes(1);
  });
});
