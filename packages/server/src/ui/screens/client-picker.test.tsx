import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { ClientPicker } from './client-picker.js';
import type { ClientId } from '../../installers/index.js';

/* The picker's rows come from every installer's detect(). HOME points at a
 * temp dir so the client configs are whatever each test writes there. */

let fakeHome: string;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-picker-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(() => {
  process.env.HOME = savedEnv.HOME;
  process.env.USERPROFILE = savedEnv.USERPROFILE;
  rmSync(fakeHome, { recursive: true, force: true });
});

const claudeConfig = () => join(fakeHome, '.claude.json');
const noop = (): void => undefined;

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ClientPicker with a malformed client config', () => {
  test('renders, marking the unreadable client, and the row can still be picked', async () => {
    writeFileSync(claudeConfig(), '{ "mcpServers": ', 'utf8');
    const picked: ClientId[] = [];
    const { lastFrame, stdin } = render(
      <ClientPicker language="en" onPick={(id) => picked.push(id)} onBack={noop} />,
    );
    await tick();
    const out = lastFrame() ?? '';
    expect(out).toContain('Which MCP client?');
    expect(out).toContain('Claude Code');
    expect(out).toContain('unknown (config unreadable)');
    expect(out).toContain('OpenCode');
    stdin.write('\r');
    await tick();
    expect(picked).toEqual(['claude']);
  });

  test('a valid config still shows the client as detected (registered)', () => {
    writeFileSync(
      claudeConfig(),
      JSON.stringify({ mcpServers: { 'browser-link': { command: 'node', args: [] } } }),
      'utf8',
    );
    const { lastFrame } = render(<ClientPicker language="en" onPick={noop} onBack={noop} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('Claude Code');
    expect(out).toContain('registered');
    expect(out).not.toContain('unreadable');
  });
});
