import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installAll, installFor } from './install.js';

/* `installAll` runs every client. A refused client must not hide what the
 * others did, and must make the command fail (exit code 1). */

let home: string;
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  COPILOT_HOME: process.env.COPILOT_HOME,
  BROWSER_LINK_BIN: process.env.BROWSER_LINK_BIN,
};

const paths = () => ({
  claude: join(home, '.claude.json'),
  opencode: join(home, '.config', 'opencode', 'opencode.json'),
  copilot: join(home, '.copilot', 'mcp-config.json'),
});

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'browser-link-installall-'));
  if (process.platform === 'win32') process.env.USERPROFILE = home;
  else process.env.HOME = home;
  delete process.env.COPILOT_HOME;
  delete process.env.BROWSER_LINK_BIN;
  process.exitCode = undefined;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('installAll', () => {
  test('all clients succeed: the reports are as before and the exit code is untouched', () => {
    const p = paths();
    put(p.claude, '{}\n');
    put(p.opencode, '{"$schema": "https://opencode.ai/config.json"}\n');
    put(p.copilot, '{"mcpServers": {"browser-link": {}}}\n');
    expect(installAll()).toEqual([
      {
        client: 'claude',
        displayName: 'Claude Code',
        installedClient: true,
        message: `Added browser-link entry (user scope) to ${p.claude}.`,
      },
      {
        client: 'opencode',
        displayName: 'OpenCode',
        installedClient: true,
        message: `Added browser-link entry to ${p.opencode}.`,
      },
      {
        client: 'copilot',
        displayName: 'GitHub Copilot CLI',
        installedClient: true,
        message: `Updated browser-link entry in ${p.copilot}.`,
      },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  test('a client that is not installed is reported and is not a failure (previous behaviour)', () => {
    const p = paths();
    put(p.claude, '{}\n');
    const reports = installAll();
    expect(reports.map((r) => r.installedClient)).toEqual([true, false, false]);
    expect(reports[1].message).toBe(
      `OpenCode config not found at ${p.opencode}. Install OpenCode first.`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  test('a refused client is reported with its reason, the others still run, exit code 1', () => {
    const p = paths();
    put(p.claude, '{}\n');
    put(p.opencode, '{ not json\n');
    put(p.copilot, '{}\n');
    const reports = installAll();
    expect(reports).toHaveLength(3);
    expect(reports[0]).toMatchObject({
      installedClient: true,
      message: expect.stringMatching(/^Added/),
    });
    expect(reports[1]).toMatchObject({ client: 'opencode', installedClient: false, refused: true });
    expect(reports[1].message).toMatch(
      new RegExp(`^Refused, nothing written: Could not parse OpenCode config at `),
    );
    expect(reports[2]).toMatchObject({
      installedClient: true,
      message: expect.stringMatching(/^Added/),
    });
    expect(readFileSync(p.opencode, 'utf8')).toBe('{ not json\n');
    expect(readFileSync(p.copilot, 'utf8')).toContain('"browser-link"');
    expect(process.exitCode).toBe(1);
  });

  test('installFor on one refused client still throws its reason (previous behaviour)', () => {
    put(paths().claude, '[]\n');
    expect(() => installFor('claude')).toThrow('is not in the expected shape');
  });
});
