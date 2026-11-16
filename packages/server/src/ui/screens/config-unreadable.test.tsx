import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, readConfig, type UnreadableConfig } from '../../config.js';
import { formatRestoreResult } from '../../commands/config.js';
import { App } from '../app.js';
import { ConfigUnreadableView } from './config-unreadable.js';
import { DoctorView } from './doctor.js';
import { MultiAgentView } from './multi-agent.js';
import { PermissionsView } from './permissions.js';
import type { DoctorReport } from '../../commands/doctor.js';

/* S6.5: the console opens on its own screen while config.json is
 * unreadable. Enter by reflex never restores; `r` does, and shows what the
 * CLI shows. The data dir is a temp dir. */

const ESC = String.fromCharCode(27);
const ENTER = '\r';
const ARROW_DOWN = `${ESC}[B`;

let dataDir: string;
let configPath: string;
const savedData = process.env.BROWSER_LINK_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-ui-config-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  configPath = join(dataDir, 'config.json');
});

afterEach(() => {
  if (savedData === undefined) delete process.env.BROWSER_LINK_DATA_DIR;
  else process.env.BROWSER_LINK_DATA_DIR = savedData;
  rmSync(dataDir, { recursive: true, force: true });
});

const BROKEN = '{ "disabledTools": [ ';
const noop = (): void => undefined;

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function problem(): UnreadableConfig {
  const read = readConfig();
  if (read.state !== 'unreadable') throw new Error('config is not unreadable');
  return read;
}

/** The frame with Ink's line wrapping undone, so long sentences match. */
function flat(frame: string | undefined): string {
  return (frame ?? '').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
}

const RESTORED = {
  restored: true as const,
  path: '/d/config.json',
  error: 'bad',
  backupPath: '/d/config.json.unreadable-x',
  inEffect: defaultSettings(),
};

describe('ConfigUnreadableView', () => {
  test.each([
    [
      'en',
      [
        'config.json cannot be read',
        'browser-link refuses to work while its config file cannot be read.',
        'Two ways out:',
        'Restore the default settings.',
        'Quit and fix the file by hand',
      ],
    ],
    [
      'es',
      [
        'No se puede leer config.json',
        'browser-link se niega a funcionar mientras no se pueda leer su archivo de config.',
        'Dos salidas:',
        'Restaurar la configuración por defecto.',
        'Salir y arreglar el archivo a mano',
      ],
    ],
  ] as const)(
    '%s: what is wrong, the file, the error and both choices',
    async (language, texts) => {
      const p = { path: '/data/config.json', error: 'Unexpected end of JSON input' };
      const { lastFrame, unmount } = render(
        <ConfigUnreadableView
          language={language}
          problem={p}
          onContinue={noop}
          onQuit={noop}
          restore={() => RESTORED}
        />,
      );
      await tick();
      const frame = flat(lastFrame());
      for (const text of texts) expect(frame).toContain(text);
      expect(frame).toContain('/data/config.json');
      expect(frame).toContain('Unexpected end of JSON input');
      unmount();
    },
  );

  test('Enter (and any key but r) does not restore', async () => {
    const restore = vi.fn(() => RESTORED);
    const { stdin, unmount } = render(
      <ConfigUnreadableView
        language="en"
        problem={{ path: '/d', error: 'e' }}
        onContinue={noop}
        onQuit={noop}
        restore={restore}
      />,
    );
    await tick();
    for (const key of [ENTER, ENTER, ' ', 'y', ARROW_DOWN]) {
      stdin.write(key);
      await tick();
    }
    expect(restore).not.toHaveBeenCalled();
    unmount();
  });

  test.each(['en', 'es'] as const)(
    '%s: r restores and shows the same report as the CLI; Enter then continues',
    async (language) => {
      const restore = vi.fn(() => RESTORED);
      const onContinue = vi.fn();
      const { stdin, lastFrame, unmount } = render(
        <ConfigUnreadableView
          language={language}
          problem={{ path: '/d/config.json', error: 'bad' }}
          onContinue={onContinue}
          onQuit={noop}
          restore={restore}
        />,
      );
      await tick();
      stdin.write('r');
      await tick();
      expect(restore).toHaveBeenCalledOnce();
      const frame = flat(lastFrame());
      for (const line of formatRestoreResult(RESTORED, language).split('\n')) {
        if (line.trim().length > 0) expect(frame).toContain(line.trim().replace(/\s+/g, ' '));
      }
      expect(onContinue).not.toHaveBeenCalled();
      stdin.write(ENTER);
      await tick();
      expect(onContinue).toHaveBeenCalledOnce();
      unmount();
    },
  );

  test('q quits without restoring', async () => {
    const restore = vi.fn(() => RESTORED);
    const onQuit = vi.fn();
    const { stdin, unmount } = render(
      <ConfigUnreadableView
        language="en"
        problem={{ path: '/d', error: 'e' }}
        onContinue={noop}
        onQuit={onQuit}
        restore={restore}
      />,
    );
    await tick();
    stdin.write('q');
    await tick();
    expect(onQuit).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    unmount();
  });

  test('a restore that throws shows the error and nothing else happens', async () => {
    const { stdin, lastFrame, unmount } = render(
      <ConfigUnreadableView
        language="en"
        problem={{ path: '/d', error: 'e' }}
        onContinue={noop}
        onQuit={noop}
        restore={() => {
          throw new Error('Could not keep a copy. Nothing was changed.');
        }}
      />,
    );
    await tick();
    stdin.write('r');
    await tick();
    const frame = flat(lastFrame());
    expect(frame).toContain('The restore failed:');
    expect(frame).toContain('Could not keep a copy. Nothing was changed.');
    unmount();
  });
});

describe('App with an unreadable config.json', () => {
  test('opens on the config screen instead of the notice; Enter changes nothing on disk', async () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    const { stdin, lastFrame, unmount } = render(
      <App
        initialLanguage="en"
        skipWelcome={false}
        noticeAcknowledged={false}
        configProblem={problem()}
      />,
    );
    await tick();
    expect(flat(lastFrame())).toContain('config.json cannot be read');
    stdin.write(ENTER);
    await tick();
    expect(flat(lastFrame())).toContain('config.json cannot be read');
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
    unmount();
  });

  test('r restores on disk, then Enter goes on to the notice of a fresh config', async () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    const { stdin, lastFrame, unmount } = render(
      <App
        initialLanguage="en"
        skipWelcome={false}
        noticeAcknowledged={false}
        configProblem={problem()}
      />,
    );
    await tick();
    stdin.write('r');
    await tick();
    expect(flat(lastFrame())).toContain('Restored the default settings.');
    expect(readFileSync(configPath, 'utf8')).toBe('{}\n');
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('config.json.unreadable-'));
    expect(backups).toHaveLength(1);
    stdin.write(ENTER);
    await tick();
    expect(flat(lastFrame())).toContain('I understand');
    unmount();
  });

  test('a write from the notice while the file breaks shows the config screen, not a crash', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App initialLanguage="en" skipWelcome={false} noticeAcknowledged={false} />,
    );
    await tick();
    writeFileSync(configPath, BROKEN, 'utf8');
    stdin.write(ENTER);
    await tick();
    expect(flat(lastFrame())).toContain('config.json cannot be read');
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
    unmount();
  });

  test('a valid config still opens on the notice (unchanged)', async () => {
    writeFileSync(configPath, '{}', 'utf8');
    const { lastFrame, unmount } = render(
      <App initialLanguage="en" skipWelcome={false} noticeAcknowledged={false} />,
    );
    await tick();
    expect(flat(lastFrame())).toContain('I understand');
    unmount();
  });
});

describe('the console write screens refuse an unreadable config.json (S6.3)', () => {
  test('Permissions: saving after the file broke reports it and writes nothing', async () => {
    writeFileSync(configPath, '{}', 'utf8');
    const onConfigUnreadable = vi.fn();
    const { stdin, unmount } = render(
      <PermissionsView language="en" onBack={noop} onConfigUnreadable={onConfigUnreadable} />,
    );
    await tick();
    writeFileSync(configPath, BROKEN, 'utf8');
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('s');
    await tick();
    expect(onConfigUnreadable).toHaveBeenCalledWith({ path: configPath, error: problem().error });
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
    unmount();
  });

  test('Multi-agent: saving after the file broke reports it and writes nothing', async () => {
    writeFileSync(configPath, '{}', 'utf8');
    const onConfigUnreadable = vi.fn();
    const { stdin, unmount } = render(
      <MultiAgentView language="en" onBack={noop} onConfigUnreadable={onConfigUnreadable} />,
    );
    await tick();
    writeFileSync(configPath, BROKEN, 'utf8');
    stdin.write(' ');
    await tick();
    stdin.write('s');
    await tick();
    expect(onConfigUnreadable).toHaveBeenCalledWith({ path: configPath, error: problem().error });
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
    unmount();
  });

  test('Permissions with a valid file still saves as before (unchanged)', async () => {
    writeFileSync(configPath, '{"language":"es"}', 'utf8');
    const { stdin, unmount } = render(<PermissionsView language="en" onBack={noop} />);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('s');
    await tick();
    const saved = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(saved.language).toBe('es');
    expect(Array.isArray(saved.disabledTools)).toBe(true);
    unmount();
  });
});

describe('the Doctor screen shows the unreadable config (S6.6)', () => {
  const REPORT: DoctorReport = {
    ws: { listening: false, detail: 'no MCP server running', host: '127.0.0.1', port: 17529 },
    ipc: { listening: false, detail: 'no MCP server running', host: '127.0.0.1', port: 17530 },
    multiAgent: { enabled: null, autoReelect: null },
    clients: [],
    extension: { path: null },
    map: { dbPath: '/tmp/map.db', exists: false, sizeBytes: 0, apps: 0 },
    security: { allowedBrowsers: ['chrome'], allowedExtensionIds: [] },
    silentDebugger: { detected: null },
    config: { state: 'unreadable', path: '/data/config.json', error: 'Unexpected end' },
  };

  test.each([
    ['en', 'Config file:', 'Two ways out:'],
    ['es', 'Archivo de config:', 'Dos salidas:'],
  ] as const)('%s', async (language, header, waysOut) => {
    const { lastFrame, unmount } = render(
      <DoctorView language={language} onBack={noop} runDoctor={async () => REPORT} />,
    );
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = flat(lastFrame());
    expect(frame).toContain(header);
    expect(frame).toContain('/data/config.json');
    expect(frame).toContain('Unexpected end');
    expect(frame).toContain(waysOut);
    expect(frame).toContain('browser-link config restore-defaults');
    unmount();
  });
});
