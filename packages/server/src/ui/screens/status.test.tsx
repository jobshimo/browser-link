import { describe, expect, test } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusView } from './status.js';
import type { MenuAction } from './menu.js';
import type { AdminInput } from '../../admin/descriptor.js';

/* S4: the console's first screen. It renders the `status` section of the
 * admin descriptor (one source with the popup) above the existing menu rows,
 * with the same hotkeys, so every screen stays one key away. The input is
 * injected: no primary is probed and no client file is read. */

const noop = (): void => undefined;
const NO_UPDATE = { latest: null, isNewer: false };

function input(over: Partial<AdminInput> = {}): AdminInput {
  return {
    config: {},
    now: Date.parse('2026-11-09T12:00:00.000Z'),
    version: '0.42.0',
    server: {
      running: { version: '0.42.0', pid: 4242, startedAt: '2026-11-09T11:00:00.000Z' },
      installed: '0.42.0',
      outdated: false,
    },
    tabsConnected: null,
    ports: { ws: 17529, ipc: 17530 },
    extension: { path: null, connectedVersion: null },
    instructions: [],
    clients: [],
    cdpGrant: { live: false, remainingMs: null },
    update: null,
    toolNames: [],
    downloadsDir: '/d',
    ...over,
  };
}

async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function view(
  props: {
    language?: 'en' | 'es';
    loadInput?: () => Promise<AdminInput>;
    onSelect?: (a: MenuAction) => void;
    onOpenMenu?: () => void;
    onQuit?: () => void;
  } = {},
) {
  return render(
    <StatusView
      language={props.language ?? 'en'}
      loadInput={props.loadInput ?? (() => Promise.resolve(input()))}
      onSelect={props.onSelect ?? noop}
      onOpenMenu={props.onOpenMenu ?? noop}
      onSwapLang={noop}
      onQuit={props.onQuit ?? noop}
      outdatedClientNames={() => []}
      updateState={NO_UPDATE}
    />,
  );
}

describe('StatusView', () => {
  test('renders the server rows from the descriptor above every menu row', async () => {
    const { lastFrame } = view();
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('browser-link — status');
    expect(frame).toContain('Server');
    expect(frame).toContain('running v0.42.0');
    expect(frame).toContain('4242');
    expect(frame).toContain('1h 0m');
    expect(frame).toContain('WS 17529 · IPC 17530');
    expect(frame).toContain('Register browser-link with an MCP client');
    expect(frame).toContain('Multi-agent');
    expect(frame).toContain('Quit');
    expect(frame.indexOf('running v0.42.0')).toBeLessThan(frame.indexOf('Register browser-link'));
  });

  test('with no primary answering, the server rows say so', async () => {
    const { lastFrame } = view({
      loadInput: () =>
        Promise.resolve(input({ server: { running: null, installed: '0.42.0', outdated: false } })),
    });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('not running');
    expect(frame).toContain('Your MCP client starts it');
  });

  test('labels follow the console language', async () => {
    const { lastFrame } = view({ language: 'es' });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('browser-link — estado');
    expect(frame).toContain('Servidor');
    expect(frame).toContain('en marcha v0.42.0');
    expect(frame).toContain('Registrar browser-link en un cliente MCP');
  });

  test('menu rows keep their hotkeys and Enter', async () => {
    const selected: MenuAction[] = [];
    const { stdin } = view({ onSelect: (a) => selected.push(a) });
    await tick();
    stdin.write('m');
    await tick();
    stdin.write('d');
    await tick();
    stdin.write('\r');
    await tick();
    expect(selected).toEqual(['multiAgent', 'doctor', 'register']);
  });

  test('Tab opens the full menu and q quits', async () => {
    let menu = 0;
    let quit = 0;
    const { stdin } = view({
      onOpenMenu: () => (menu += 1),
      onQuit: () => (quit += 1),
    });
    await tick();
    stdin.write('\t');
    await tick();
    stdin.write('q');
    await tick();
    expect(menu).toBe(1);
    expect(quit).toBe(1);
  });
});
