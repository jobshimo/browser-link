import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsView } from './permissions.js';

/*
 * Keyboard interaction tests for PermissionsView. We point the config at a
 * fake home so save() doesn't touch the host. The tests do NOT call save —
 * they only assert that Space marks the toggle as dirty (shows "Unsaved")
 * and that Esc invokes onBack.
 */

const ESC = '';

let fakeHome;
let originalEnvHome;
let originalUserprofile;
let originalBrowserLinkDataDir;
let originalConfigHome;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-perm-it-'));
  originalEnvHome = process.env.HOME;
  originalUserprofile = process.env.USERPROFILE;
  originalBrowserLinkDataDir = process.env.BROWSER_LINK_DATA_DIR;
  originalConfigHome = process.env.XDG_CONFIG_HOME;
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
  process.env.BROWSER_LINK_DATA_DIR = fakeHome;
  process.env.XDG_CONFIG_HOME = fakeHome;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  if (originalEnvHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnvHome;
  if (originalUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserprofile;
  if (originalBrowserLinkDataDir === undefined) delete process.env.BROWSER_LINK_DATA_DIR;
  else process.env.BROWSER_LINK_DATA_DIR = originalBrowserLinkDataDir;
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
});

const noop = () => undefined;

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('PermissionsView — interaction', () => {
  test('renders the catalogue with bridge + map headers', async () => {
    const { lastFrame } = render(<PermissionsView language="en" onBack={noop} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Browser bridge/);
    expect(frame).toMatch(/Persistent UI map/);
  });

  test('Space on a tool row marks the form as dirty (Unsaved appears)', async () => {
    const { stdin, lastFrame } = render(<PermissionsView language="en" onBack={noop} />);
    await tick();
    // The default cursor lands on the first preset (a "preset" row); Space
    // only toggles "tool" rows. Walk down past the presets and the bridge
    // header until the cursor reaches a tool row, then press Space.
    const DOWN = `[B`;
    for (let i = 0; i < 8; i++) {
      stdin.write(DOWN);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    stdin.write(' ');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Unsaved/);
  });

  test('Esc calls onBack', async () => {
    let backCalls = 0;
    const onBack = () => {
      backCalls += 1;
    };
    const { stdin } = render(<PermissionsView language="en" onBack={onBack} />);
    await tick();
    stdin.write(ESC);
    // Lone ESC is buffered ~20ms by Ink's input parser; wait past the flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backCalls).toBe(1);
  });
});
