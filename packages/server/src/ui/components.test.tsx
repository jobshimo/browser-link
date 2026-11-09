import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { Frame } from './components.js';

// Pass-through spy so the status-bar test can count config reads.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

/* Frame's header (LiveStatusBar) projects every installer's detect() into
 * the status strip. These tests point HOME at a temp dir so the three
 * client configs are whatever the test writes there. */

let fakeHome: string;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-frame-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  vi.mocked(fs.readFileSync).mockClear();
});

afterEach(() => {
  process.env.HOME = savedEnv.HOME;
  process.env.USERPROFILE = savedEnv.USERPROFILE;
  rmSync(fakeHome, { recursive: true, force: true });
});

const claudeConfig = () => join(fakeHome, '.claude.json');

function frame(body = 'body') {
  return (
    <Frame title="Title" footer="footer">
      <Text>{body}</Text>
    </Frame>
  );
}

describe('Frame header (LiveStatusBar)', () => {
  test('a malformed ~/.claude.json renders the client as unreadable instead of crashing', () => {
    writeFileSync(claudeConfig(), '{ "mcpServers": ', 'utf8');
    const { lastFrame } = render(frame());
    const out = lastFrame() ?? '';
    expect(out).toContain('Claude Code');
    // The 100-column test terminal wraps the label inside its column.
    expect(out).toContain('Claude Code · unknown (config');
    expect(out).toContain('unreadable)');
    expect(out).toContain('body');
  });

  test('a valid config still shows the client as registered', () => {
    writeFileSync(
      claudeConfig(),
      JSON.stringify({ mcpServers: { 'browser-link': { command: 'node', args: [] } } }),
      'utf8',
    );
    const { lastFrame } = render(frame());
    expect(lastFrame() ?? '').toContain('Claude Code · registered');
  });

  test('re-renders (keystrokes) do not re-read the client configs', () => {
    writeFileSync(claudeConfig(), JSON.stringify({ mcpServers: {} }), 'utf8');
    const { rerender, lastFrame } = render(frame('a'));
    rerender(frame('b'));
    rerender(frame('c'));
    rerender(frame('d'));
    expect(lastFrame() ?? '').toContain('d');
    const claudeReads = vi
      .mocked(fs.readFileSync)
      .mock.calls.filter((c) => String(c[0]) === claudeConfig());
    expect(claudeReads).toHaveLength(1);
  });

  test('a fresh mount (navigation to another screen) reads the configs again', () => {
    writeFileSync(claudeConfig(), JSON.stringify({ mcpServers: {} }), 'utf8');
    const first = render(frame());
    expect(first.lastFrame() ?? '').toContain('Claude Code · not registered');
    first.unmount();
    writeFileSync(
      claudeConfig(),
      JSON.stringify({ mcpServers: { 'browser-link': { command: 'node', args: [] } } }),
      'utf8',
    );
    const second = render(frame());
    expect(second.lastFrame() ?? '').toContain('Claude Code · registered');
  });
});
