import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { uninstallAll, uninstallFor } from './uninstall.js';

/* `uninstallAll` runs every client. A refused client must not hide what the
 * others did, and must make the command fail (exit code 1). */

let home: string;
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  COPILOT_HOME: process.env.COPILOT_HOME,
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

const ENTRY = '{"mcpServers": {"browser-link": {"command": "x"}}}\n';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'browser-link-uninstallall-'));
  if (process.platform === 'win32') process.env.USERPROFILE = home;
  else process.env.HOME = home;
  delete process.env.COPILOT_HOME;
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

describe('uninstallAll', () => {
  test('all clients succeed: the reports are as before and the exit code is untouched', () => {
    const p = paths();
    put(p.claude, ENTRY);
    put(p.copilot, '{"mcpServers": {}}\n');
    expect(uninstallAll()).toEqual([
      {
        client: 'claude',
        displayName: 'Claude Code',
        message: `Removed browser-link entry from ${p.claude} (user + project scopes).`,
      },
      {
        client: 'opencode',
        displayName: 'OpenCode',
        message: `No OpenCode config at ${p.opencode}; nothing to remove.`,
      },
      {
        client: 'copilot',
        displayName: 'GitHub Copilot CLI',
        message: `browser-link was not registered in ${p.copilot}.`,
      },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  test('a refused client is reported with its reason, the others still run, exit code 1', () => {
    const p = paths();
    put(p.claude, '{ not json\n');
    put(p.copilot, ENTRY);
    const reports = uninstallAll();
    expect(reports).toHaveLength(3);
    expect(reports[0]).toMatchObject({ client: 'claude', refused: true });
    expect(reports[0].message).toMatch(/^Refused, nothing written: Could not parse Claude config/);
    expect(reports[2].message).toBe(`Removed browser-link entry from ${p.copilot}.`);
    expect(readFileSync(p.claude, 'utf8')).toBe('{ not json\n');
    expect(readFileSync(p.copilot, 'utf8')).not.toContain('browser-link');
    expect(process.exitCode).toBe(1);
  });

  test('uninstallFor on one refused client still throws its reason (previous behaviour)', () => {
    put(paths().claude, '{ not json\n');
    expect(() => uninstallFor('claude')).toThrow('Could not parse Claude config');
  });
});
