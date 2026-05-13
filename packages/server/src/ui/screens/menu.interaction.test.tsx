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
});
