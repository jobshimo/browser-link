import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every module the CLI can dispatch to is mocked. Each factory records that
// its module was loaded, so a test can assert which modules a command pulled
// in (the point of the lazy dispatch: a command loads only its own module).
const h = vi.hoisted(() => {
  const loaded = new Set<string>();
  const language: { value: 'en' | 'es' } = { value: 'en' };
  const spies = {
    loadConfig: vi.fn(() => ({ language: language.value })),
    runServer: vi.fn(async () => {}),
    runDoctor: vi.fn(async () => ({})),
    formatDoctor: vi.fn(() => 'doctor-report'),
    installAll: vi.fn(() => [{ installedClient: true, displayName: 'Claude', message: 'ok' }]),
    installFor: vi.fn(() => ({ installedClient: true, displayName: 'Claude', message: 'ok' })),
    uninstallAll: vi.fn(() => [{ displayName: 'Claude', message: 'removed' }]),
    uninstallFor: vi.fn(() => ({ displayName: 'Claude', message: 'removed' })),
    printExtensionInstructions: vi.fn(),
    printAbout: vi.fn(),
    checkUpdates: vi.fn(async () => ({ latest: '9.9.9', error: null as string | null })),
    formatUpdate: vi.fn(() => 'update-report'),
    runToolsCommand: vi.fn(() => 'tools-report'),
    runMultiAgentCommand: vi.fn(() => 'multi-agent-report'),
    runFreePort: vi.fn(() => ({ ok: true, message: 'freed' })),
    runConfigCommand: vi.fn(async () => 'config-report'),
    runCdpCommand: vi.fn(async () => 'cdp-report'),
    runMapCommand: vi.fn(() => 'map-report'),
    runActivityCommand: vi.fn(() => 'activity-report'),
    formatStatus: vi.fn(() => 'instructions-status'),
    statusAll: vi.fn(() => []),
    statusFor: vi.fn(() => ({})),
    installInstructionsAll: vi.fn(() => []),
    installInstructionsFor: vi.fn(() => ({})),
    uninstallInstructionsAll: vi.fn(() => []),
    uninstallInstructionsFor: vi.fn(() => ({})),
  };
  return { loaded, language, spies };
});

function registerModuleMocks(): void {
  vi.doMock('./config.js', () => {
    h.loaded.add('config');
    return { loadConfig: h.spies.loadConfig };
  });
  vi.doMock('./server.js', () => {
    h.loaded.add('server');
    return { runServer: h.spies.runServer };
  });
  vi.doMock('./commands/doctor.js', () => {
    h.loaded.add('doctor');
    return { runDoctor: h.spies.runDoctor, formatDoctor: h.spies.formatDoctor };
  });
  vi.doMock('./commands/install.js', () => {
    h.loaded.add('install');
    return { installAll: h.spies.installAll, installFor: h.spies.installFor };
  });
  vi.doMock('./commands/uninstall.js', () => {
    h.loaded.add('uninstall');
    return { uninstallAll: h.spies.uninstallAll, uninstallFor: h.spies.uninstallFor };
  });
  vi.doMock('./commands/extension.js', () => {
    h.loaded.add('extension');
    return { printExtensionInstructions: h.spies.printExtensionInstructions };
  });
  vi.doMock('./commands/about.js', () => {
    h.loaded.add('about');
    return { printAbout: h.spies.printAbout };
  });
  vi.doMock('./commands/updates.js', () => {
    h.loaded.add('updates');
    return { checkUpdates: h.spies.checkUpdates, formatUpdate: h.spies.formatUpdate };
  });
  vi.doMock('./commands/tools.js', () => {
    h.loaded.add('tools');
    return { runToolsCommand: h.spies.runToolsCommand };
  });
  vi.doMock('./commands/multi-agent.js', () => {
    h.loaded.add('multi-agent');
    return { runMultiAgentCommand: h.spies.runMultiAgentCommand };
  });
  vi.doMock('./commands/free-port.js', () => {
    h.loaded.add('free-port');
    return { runFreePort: h.spies.runFreePort };
  });
  vi.doMock('./commands/config.js', () => {
    h.loaded.add('config-command');
    return { runConfigCommand: h.spies.runConfigCommand };
  });
  vi.doMock('./commands/cdp.js', () => {
    h.loaded.add('cdp');
    return { runCdpCommand: h.spies.runCdpCommand };
  });
  vi.doMock('./commands/map.js', () => {
    h.loaded.add('map');
    return { runMapCommand: h.spies.runMapCommand };
  });
  vi.doMock('./commands/activity.js', () => {
    h.loaded.add('activity');
    return { runActivityCommand: h.spies.runActivityCommand };
  });
  vi.doMock('./commands/instructions.js', () => {
    h.loaded.add('instructions');
    return {
      formatStatus: h.spies.formatStatus,
      statusAll: h.spies.statusAll,
      statusFor: h.spies.statusFor,
      installInstructionsAll: h.spies.installInstructionsAll,
      installInstructionsFor: h.spies.installInstructionsFor,
      uninstallInstructionsAll: h.spies.uninstallInstructionsAll,
      uninstallInstructionsFor: h.spies.uninstallInstructionsFor,
    };
  });
  vi.doMock('./ui/start.js', () => {
    h.loaded.add('ui');
    return { startUI: vi.fn() };
  });
}

const COMMAND_MODULES = [
  'server',
  'doctor',
  'install',
  'uninstall',
  'extension',
  'about',
  'updates',
  'tools',
  'multi-agent',
  'free-port',
  'config-command',
  'cdp',
  'map',
  'activity',
  'instructions',
  'ui',
];

const here = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (
  JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }
).version;

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

let logs: string[];
let errors: string[];

async function loadDispatch(): Promise<(argv: string[]) => Promise<void>> {
  const mod = await import('./cli.js');
  return mod.dispatch;
}

function commandModulesLoaded(): string[] {
  return COMMAND_MODULES.filter((m) => h.loaded.has(m));
}

beforeEach(() => {
  vi.resetModules();
  registerModuleMocks();
  h.loaded.clear();
  h.language.value = 'en';
  for (const spy of Object.values(h.spies)) spy.mockClear();
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitCalled(code === null || code === undefined ? undefined : Number(code));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cli dispatch: version', () => {
  it.each(['version', '-v', '--version'])(
    '%s prints the package version without loading config or any command module',
    async (flag) => {
      const dispatch = await loadDispatch();
      await dispatch([flag]);
      expect(logs).toEqual([PKG_VERSION]);
      expect(errors).toEqual([]);
      expect(h.spies.loadConfig).not.toHaveBeenCalled();
      expect(h.loaded.has('config')).toBe(false);
      expect(commandModulesLoaded()).toEqual([]);
    },
  );
});

describe('cli dispatch: help', () => {
  it.each(['help', '-h', '--help'])(
    '%s prints the English help without importing any command module',
    async (flag) => {
      const dispatch = await loadDispatch();
      await dispatch([flag]);
      expect(logs).toHaveLength(1);
      expect(logs[0].startsWith(`browser-link ${PKG_VERSION} — bridge any MCP client`)).toBe(true);
      expect(logs[0]).toContain('browser-link help             This message.');
      expect(commandModulesLoaded()).toEqual([]);
    },
  );

  it('prints the Spanish help when the configured language is es', async () => {
    h.language.value = 'es';
    const dispatch = await loadDispatch();
    await dispatch(['help']);
    expect(logs[0]).toMatch(/^browser-link \S+ — puente entre cualquier cliente MCP/);
    expect(commandModulesLoaded()).toEqual([]);
  });
});

describe('cli dispatch: unknown command (pinned from the 0.38.0 build)', () => {
  it('prints the error, a blank line and the help to stderr, then exits 2', async () => {
    const dispatch = await loadDispatch();
    await expect(dispatch(['nosuchcmd'])).rejects.toEqual(new ExitCalled(2));
    expect(errors[0]).toBe('Unknown command: nosuchcmd');
    expect(errors[1]).toBe('');
    expect(errors[2]).toMatch(/^browser-link \S+ — bridge any MCP client/);
    expect(errors).toHaveLength(3);
    expect(logs).toEqual([]);
    expect(commandModulesLoaded()).toEqual([]);
  });

  it('uses the Spanish message when the configured language is es', async () => {
    h.language.value = 'es';
    const dispatch = await loadDispatch();
    await expect(dispatch(['nosuchcmd'])).rejects.toEqual(new ExitCalled(2));
    expect(errors[0]).toBe('Comando desconocido: nosuchcmd');
    expect(errors[2]).toMatch(/^browser-link \S+ — puente entre cualquier cliente MCP/);
  });
});

describe('cli dispatch: every command reaches its handler and loads only its module', () => {
  const cases: {
    argv: string[];
    module: string;
    handler: keyof typeof h.spies;
    stdout?: string[];
  }[] = [
    { argv: [], module: 'server', handler: 'runServer' },
    { argv: ['start'], module: 'server', handler: 'runServer' },
    {
      argv: ['install'],
      module: 'install',
      handler: 'installAll',
      stdout: [
        '✓ Claude: ok',
        '',
        'Restart the MCP client so it picks up the registration.',
        'Next: install the Chrome extension — run `browser-link extension`.',
      ],
    },
    { argv: ['install', '--client', 'claude'], module: 'install', handler: 'installFor' },
    {
      argv: ['uninstall'],
      module: 'uninstall',
      handler: 'uninstallAll',
      stdout: ['· Claude: removed'],
    },
    { argv: ['uninstall', '--client', 'opencode'], module: 'uninstall', handler: 'uninstallFor' },
    { argv: ['extension'], module: 'extension', handler: 'printExtensionInstructions' },
    { argv: ['doctor'], module: 'doctor', handler: 'runDoctor', stdout: ['doctor-report'] },
    { argv: ['about'], module: 'about', handler: 'printAbout' },
    { argv: ['updates'], module: 'updates', handler: 'checkUpdates', stdout: ['update-report'] },
    {
      argv: ['tools', 'disable', 'x'],
      module: 'tools',
      handler: 'runToolsCommand',
      stdout: ['tools-report', '', 'Restart your MCP client so it picks up the change.'],
    },
    {
      argv: ['multi-agent'],
      module: 'multi-agent',
      handler: 'runMultiAgentCommand',
      stdout: ['multi-agent-report'],
    },
    {
      argv: ['config', 'get'],
      module: 'config-command',
      handler: 'runConfigCommand',
      stdout: ['config-report'],
    },
    { argv: ['cdp', 'status'], module: 'cdp', handler: 'runCdpCommand', stdout: ['cdp-report'] },
    { argv: ['map'], module: 'map', handler: 'runMapCommand', stdout: ['map-report'] },
    {
      argv: ['activity', '--limit', '1'],
      module: 'activity',
      handler: 'runActivityCommand',
      stdout: ['activity-report'],
    },
    {
      argv: ['instructions'],
      module: 'instructions',
      handler: 'statusAll',
      stdout: ['instructions-status'],
    },
    {
      argv: ['instructions', 'install'],
      module: 'instructions',
      handler: 'installInstructionsAll',
    },
    {
      argv: ['instructions', 'uninstall', '--client', 'copilot'],
      module: 'instructions',
      handler: 'uninstallInstructionsFor',
    },
    { argv: ['stop'], module: 'free-port', handler: 'runFreePort', stdout: ['freed'] },
  ];

  it.each(cases)('$argv -> $handler', async ({ argv, module, handler, stdout }) => {
    const dispatch = await loadDispatch();
    await dispatch(argv);
    expect(h.spies[handler]).toHaveBeenCalledTimes(1);
    expect(commandModulesLoaded()).toEqual([module]);
    if (stdout) expect(logs).toEqual(stdout);
  });

  it('passes the remaining arguments and the language through unchanged', async () => {
    h.language.value = 'es';
    const dispatch = await loadDispatch();
    await dispatch(['map', 'show', 'example.com', '--yes']);
    expect(h.spies.runMapCommand).toHaveBeenCalledWith(['show', 'example.com', '--yes'], 'es');
  });

  it('rejects an unknown --client value before running the installer', async () => {
    const dispatch = await loadDispatch();
    await expect(dispatch(['install', '--client', 'nope'])).rejects.toThrow(
      'Unknown --client value: nope. Use claude, opencode or copilot.',
    );
    expect(h.spies.installAll).not.toHaveBeenCalled();
    expect(h.spies.installFor).not.toHaveBeenCalled();
  });

  it('exits 2 on an unknown instructions action', async () => {
    const dispatch = await loadDispatch();
    await expect(dispatch(['instructions', 'bogus'])).rejects.toEqual(new ExitCalled(2));
    expect(errors).toEqual([
      'Unknown instructions action: bogus. Use install, uninstall or no arg for status.',
    ]);
  });

  it('exits 2 when the update check could not reach the registry', async () => {
    h.spies.checkUpdates.mockResolvedValueOnce({ latest: '', error: 'offline' });
    const dispatch = await loadDispatch();
    await expect(dispatch(['updates'])).rejects.toEqual(new ExitCalled(2));
  });
});
