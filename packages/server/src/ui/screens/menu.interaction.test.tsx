import { describe, expect, test } from 'vitest';
import { render } from 'ink-testing-library';
import { MainMenu } from './menu.js';

/*
 * Keyboard interaction tests for MainMenu. Asserts the cursor moves, Enter
 * fires onSelect with the right id, and 'q' fires onQuit.
 */

const ESC = '';
const DOWN = `${ESC}[B`;

const noop = () => undefined;

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('MainMenu — interaction', () => {
  test('Enter on the default-highlighted row fires onSelect with the first id', async () => {
    const selected = [];
    const onSelect = (a) => {
      selected.push(a);
    };
    const { stdin } = render(
      <MainMenu language="en" onSelect={onSelect} onSwapLang={noop} onQuit={noop} />,
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(selected).toEqual(['register']);
  });

  test('Down then Enter fires onSelect with the next id', async () => {
    const selected = [];
    const onSelect = (a) => {
      selected.push(a);
    };
    const { stdin } = render(
      <MainMenu language="en" onSelect={onSelect} onSwapLang={noop} onQuit={noop} />,
    );
    await tick();
    stdin.write(DOWN);
    // CSI sequences round-trip through Ink's input parser; wait past the
    // 20ms pending-escape flush window before sending Enter.
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(selected).toEqual(['instructions']);
  });

  test("'q' fires onQuit", async () => {
    let quitCalls = 0;
    const onQuit = () => {
      quitCalls += 1;
    };
    const { stdin } = render(
      <MainMenu language="en" onSelect={noop} onSwapLang={noop} onQuit={onQuit} />,
    );
    await tick();
    stdin.write('q');
    await tick();
    expect(quitCalls).toBe(1);
  });

  test("'i' from the menu fires onSelect('instructions') as a shortcut to the agent-instructions screen", async () => {
    const selected = [];
    const onSelect = (a) => {
      selected.push(a);
    };
    const { stdin } = render(
      <MainMenu
        language="en"
        onSelect={onSelect}
        onSwapLang={noop}
        onQuit={noop}
        outdatedClientNames={() => []}
      />,
    );
    await tick();
    stdin.write('i');
    await tick();
    expect(selected).toEqual(['instructions']);
  });

  test('outdated banner renders when at least one client is out of date', async () => {
    const { lastFrame } = render(
      <MainMenu
        language="en"
        onSelect={noop}
        onSwapLang={noop}
        onQuit={noop}
        outdatedClientNames={() => ['Claude Code', 'OpenCode']}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    // The banner is rendered with the client list joined by a comma so the
    // user sees exactly which agents are stale.
    expect(frame).toContain('Outdated browser-link block');
    expect(frame).toContain('Claude Code, OpenCode');
    expect(frame).toContain('`i`');
  });

  test('no banner when every client is up to date', async () => {
    const { lastFrame } = render(
      <MainMenu
        language="en"
        onSelect={noop}
        onSwapLang={noop}
        onQuit={noop}
        outdatedClientNames={() => []}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Outdated browser-link block');
  });

  test('ES banner uses Rioplatense copy when language is es', async () => {
    const { lastFrame } = render(
      <MainMenu
        language="es"
        onSelect={noop}
        onSwapLang={noop}
        onQuit={noop}
        outdatedClientNames={() => ['Claude Code']}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('desactualizado');
    expect(frame).toContain('Apretá');
  });

  test('update banner renders when a newer version is available', async () => {
    const { lastFrame } = render(
      <MainMenu
        language="en"
        onSelect={noop}
        onSwapLang={noop}
        onQuit={noop}
        outdatedClientNames={() => []}
        updateState={{ latest: '99.0.0', isNewer: true }}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('v99.0.0 available');
    expect(frame).toContain('npm install -g @jobshimo/browser-link@latest');
  });

  test('update banner hidden when latest equals current (isNewer=false)', async () => {
    const { lastFrame } = render(
      <MainMenu
        language="en"
        onSelect={noop}
        onSwapLang={noop}
        onQuit={noop}
        outdatedClientNames={() => []}
        updateState={{ latest: '0.8.3', isNewer: false }}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('available');
  });

  test('update banner hidden when the registry check failed (latest=null)', async () => {
    const { lastFrame } = render(
      <MainMenu
        language="en"
        onSelect={noop}
        onSwapLang={noop}
        onQuit={noop}
        outdatedClientNames={() => []}
        updateState={{ latest: null, isNewer: false }}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('available');
  });

  test('ES update banner uses Rioplatense copy when language is es', async () => {
    const { lastFrame } = render(
      <MainMenu
        language="es"
        onSelect={noop}
        onSwapLang={noop}
        onQuit={noop}
        outdatedClientNames={() => []}
        updateState={{ latest: '99.0.0', isNewer: true }}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('disponible');
    expect(frame).toContain('corré');
  });
});
