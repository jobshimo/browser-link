import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { UpdatesView } from './updates.js';
import type { UpdateInfo } from '../../commands/updates.js';

/* The update screen's three outcomes, from an injected checker: no
 * registry is queried. The real checker is mocked to record a call, so a
 * screen that ignored the injected one fails here instead of hitting npm. */

const realCheck = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../commands/updates.js', () => ({
  checkUpdates: () => {
    realCheck.calls++;
    return new Promise<never>(() => {});
  },
}));

const noop = (): void => undefined;

async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  realCheck.calls = 0;
});

function renderWith(info: UpdateInfo) {
  const check = vi.fn(async () => info);
  const view = render(<UpdatesView language="en" onBack={noop} checkUpdates={check} />);
  return { ...view, check };
}

describe('UpdatesView', () => {
  test('up to date: the current version and the up-to-date line', async () => {
    const { lastFrame, check, unmount } = renderWith({
      current: '0.48.0',
      latest: '0.48.0',
      newer: false,
    });
    await tick();
    const frame = lastFrame() ?? '';
    expect(check).toHaveBeenCalledOnce();
    expect(realCheck.calls).toBe(0);
    expect(frame).toContain('Current version: 0.48.0');
    expect(frame).toMatch(/Latest on npm\s+: 0\.48\.0/);
    expect(frame).toContain('You are on the latest published version.');
    expect(frame).not.toContain('A newer version is available.');
    unmount();
  });

  test('update available: the newer version, the badge and the manual command', async () => {
    const { lastFrame, unmount } = renderWith({
      current: '0.47.0',
      latest: '0.48.0',
      newer: true,
    });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Current version: 0.47.0');
    expect(frame).toMatch(/Latest on npm\s+: 0\.48\.0/);
    expect(frame).toContain('newer');
    expect(frame).toContain('A newer version is available.');
    expect(frame).toContain('npm install -g @jobshimo/browser-link@latest');
    unmount();
  });

  test('check failed: the error line with its reason', async () => {
    const { lastFrame, unmount } = renderWith({
      current: '0.48.0',
      latest: null,
      newer: null,
      error: 'getaddrinfo ENOTFOUND registry.npmjs.org',
    });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Current version: 0.48.0');
    expect(frame).toContain(
      'Could not check the registry: getaddrinfo ENOTFOUND registry.npmjs.org',
    );
    expect(frame).not.toContain('Latest on npm');
    unmount();
  });

  test('shows the spinner line while the check is in flight', () => {
    const view = render(
      <UpdatesView
        language="en"
        onBack={noop}
        checkUpdates={() => new Promise<UpdateInfo>(() => {})}
      />,
    );
    expect(view.lastFrame()).toContain('Checking the npm registry…');
    view.unmount();
  });

  test('r re-runs the injected check', async () => {
    const { stdin, check, unmount } = renderWith({
      current: '0.48.0',
      latest: '0.48.0',
      newer: false,
    });
    await tick();
    stdin.write('r');
    await tick();
    expect(check).toHaveBeenCalledTimes(2);
    unmount();
  });
});
