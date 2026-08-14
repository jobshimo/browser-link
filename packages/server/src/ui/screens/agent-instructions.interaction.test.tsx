import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { render } from 'ink-testing-library';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentInstructionsView } from './agent-instructions.js';
import { BEGIN_PREFIX } from '../../agent-instructions/content.js';

/*
 * Real keyboard interaction tests for AgentInstructionsView. ink-testing-library
 * exposes a fake stdin we can drive via stdin.write(...). Each test sets up
 * a fake HOME so install/uninstall actually touch tmp files, not the host.
 */

const ESC = '';
const DOWN = `${ESC}[B`;

let fakeHome;
let originalEnvHome;
let originalUserprofile;
let originalBrowserLinkDataDir;
let originalCopilotHome;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-instr-it-'));
  originalEnvHome = process.env.HOME;
  originalUserprofile = process.env.USERPROFILE;
  originalBrowserLinkDataDir = process.env.BROWSER_LINK_DATA_DIR;
  originalCopilotHome = process.env.COPILOT_HOME;
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
  process.env.BROWSER_LINK_DATA_DIR = fakeHome;
  delete process.env.COPILOT_HOME;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  if (originalEnvHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnvHome;
  if (originalUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserprofile;
  if (originalBrowserLinkDataDir === undefined) delete process.env.BROWSER_LINK_DATA_DIR;
  else process.env.BROWSER_LINK_DATA_DIR = originalBrowserLinkDataDir;
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilotHome;
});

const noop = () => undefined;

// ink renders asynchronously; useInput callbacks run on the next event-loop
// tick after stdin emits a chunk. Wait two ticks to be safe — one for the
// emit, one for the React render that follows the state update.
async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('AgentInstructionsView — interaction', () => {
  test('Enter on the first row installs the block; badge flips and message appears', async () => {
    const { stdin, lastFrame } = render(<AgentInstructionsView language="en" onBack={noop} />);
    await tick();
    expect(lastFrame() ?? '').toMatch(/no file yet/i);

    stdin.write('\r');
    await tick();
    await tick();

    const frame = lastFrame() ?? '';
    const claudeFile = join(fakeHome, '.claude', 'CLAUDE.md');
    expect(existsSync(claudeFile)).toBe(true);
    expect(readFileSync(claudeFile, 'utf8')).toContain(BEGIN_PREFIX);
    expect(frame).toMatch(/installed/i);
    expect(frame).toMatch(/Done\./);
  });

  test("'u' after install removes the block; badge flips back", async () => {
    const { stdin, lastFrame } = render(<AgentInstructionsView language="en" onBack={noop} />);
    await tick();

    stdin.write('\r');
    await tick();
    await tick();
    stdin.write('u');
    await tick();
    await tick();

    const frame = lastFrame() ?? '';
    const claudeFile = join(fakeHome, '.claude', 'CLAUDE.md');
    expect(existsSync(claudeFile)).toBe(true);
    expect(readFileSync(claudeFile, 'utf8')).not.toContain(BEGIN_PREFIX);
    expect(frame).toMatch(/Removed/);
  });

  test('down down Enter installs on the third client (Copilot)', async () => {
    const { stdin, lastFrame } = render(<AgentInstructionsView language="en" onBack={noop} />);
    await tick();

    stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const frame = lastFrame() ?? '';
    // Claude is the first client and not the one we targeted; its file
    // must NOT have been created. That asserts the cursor actually moved
    // off the first row before Enter fired.
    const claudeFile = join(fakeHome, '.claude', 'CLAUDE.md');
    expect(existsSync(claudeFile)).toBe(false);
    expect(frame).toMatch(/GitHub Copilot CLI/);
    expect(frame).toMatch(/Done\./);
  });

  test('Esc calls onBack', async () => {
    let backCalls = 0;
    const onBack = () => {
      backCalls += 1;
    };
    const { stdin } = render(<AgentInstructionsView language="en" onBack={onBack} />);
    await tick();
    stdin.write(ESC);
    // Ink defers the lone ESC byte by ~20ms to disambiguate it from a longer
    // escape sequence (arrow keys etc). Wait past that flush before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backCalls).toBe(1);
  });
});
