import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, unreadableConfigMessage, type UnreadableConfig } from '../config.js';
import { formatDoctor, runDoctor } from './doctor.js';

/* S6.6: `browser-link doctor` reports an unreadable config.json as a failed
 * check with the path, the error and the two ways out, and never shows the
 * defaults as the settings in effect. HOME and the data dir are temp dirs;
 * every slow probe is injected. */

const saved = {
  home: process.env.HOME,
  profile: process.env.USERPROFILE,
  data: process.env.BROWSER_LINK_DATA_DIR,
};
let dir: string;
let dataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'browser-link-doctor-config-'));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const [key, value] of [
    ['HOME', saved.home],
    ['USERPROFILE', saved.profile],
    ['BROWSER_LINK_DATA_DIR', saved.data],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const probes = {
  checkPort: async () => ({ listening: false, detail: 'no MCP server running' }),
  detectSilentDebugger: async () => ({ detected: null }),
  probeVersion: async () => ({ kind: 'none' }) as never,
  listBridgeProcesses: async () => [],
  readInstalledVersion: () => '1.0.0',
};

/** The text without its ANSI colour codes. */
function plain(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g'), '');
}

function writeConfig(contents: string): void {
  writeFileSync(join(dataDir, 'config.json'), contents, 'utf8');
}

function problem(): UnreadableConfig {
  const read = readConfig();
  if (read.state !== 'unreadable') throw new Error('config is not unreadable');
  return read;
}

describe('doctor with an unreadable config.json', () => {
  test('runDoctor resolves, with the config reported unreadable and the other checks present', async () => {
    writeConfig('{ "multiAgent": false,');
    const report = await runDoctor(probes);
    const p = problem();
    expect(report.config).toEqual({ state: 'unreadable', path: p.path, error: p.error });
    expect(report.multiAgent).toEqual({ enabled: null, autoReelect: null });
    expect(report.clients.length).toBeGreaterThan(0);
    expect(report.ws.port).toBe(17529);
  });

  test('English: a failed check with the path, the error and both ways out', async () => {
    writeConfig('[]');
    const out = plain(formatDoctor(await runDoctor(probes), 'en'));
    const p = problem();
    expect(out).toContain(`Config file:  ✗ cannot be read: ${p.path}`);
    expect(out).toContain(`  error: ${p.error}`);
    expect(out).toContain(
      '  browser-link refuses to work until it is fixed: no tool call runs and no browser connects.',
    );
    expect(out).toContain(
      '  Two ways out: fix the file by hand so it holds one JSON object, or run `browser-link config restore-defaults`.',
    );
    expect(out).toContain('  ✗ every WS connection is refused while config.json cannot be read.');
    expect(out).toContain('  Mode             unknown (config.json cannot be read)');
    expect(out).not.toContain('Strict path mode');
    expect(out).toContain('Chrome extension assets:');
  });

  test('Spanish: the same check and ways out', async () => {
    writeConfig('"x"');
    const out = plain(formatDoctor(await runDoctor(probes), 'es'));
    const p = problem();
    expect(out).toContain(`Archivo de config:  ✗ no se puede leer: ${p.path}`);
    expect(out).toContain(`  error: ${p.error}`);
    expect(out).toContain(
      '  browser-link se niega a funcionar hasta que se arregle: no corre ninguna llamada a tools y no se conecta ningún navegador.',
    );
    expect(out).toContain(
      '  Dos salidas: arreglá el archivo a mano para que tenga un objeto JSON, o corré `browser-link config restore-defaults`.',
    );
    expect(out).toContain('  ✗ se rechaza toda conexión WS mientras no se pueda leer config.json.');
    expect(out).toContain('  Modo             desconocido (no se puede leer config.json)');
  });

  test('the message used elsewhere names the same file and error', () => {
    writeConfig('nope');
    const p = problem();
    expect(unreadableConfigMessage(p)).toContain(p.path);
  });
});

describe('doctor with a missing or valid config.json (unchanged)', () => {
  test.each([
    ['missing', null],
    ['valid', '{"multiAgent":false}'],
  ])('a %s config adds no config section and keeps the multi-agent rows', async (_l, c) => {
    if (c !== null) writeConfig(c);
    const report = await runDoctor(probes);
    expect(report.config?.state).toBe(c === null ? 'missing' : 'ok');
    const out = formatDoctor(report, 'en');
    expect(out).not.toContain('Config file:');
    expect(out).toContain(`  Mode             ${c === null ? 'on' : 'off'}`);
    expect(out).toContain('Strict path mode (peerExecutablePaths): off');
  });
});
