import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    runFeedbackCommand: vi.fn(async (_argv: string[], _lang: string) => 0),
    installerInstall: vi.fn((_opts?: { withCore?: boolean }) => 'Inserted the block.'),
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
  vi.doMock('./commands/feedback.js', () => {
    h.loaded.add('feedback');
    return { runFeedbackCommand: h.spies.runFeedbackCommand };
  });
  vi.doMock('./agent-instructions/index.js', () => {
    h.loaded.add('agent-instructions');
    const installer = {
      id: 'claude',
      displayName: 'Claude Code',
      filePath: () => '/home/u/.claude/CLAUDE.md',
      detect: () => ({
        filePath: '/home/u/.claude/CLAUDE.md',
        state: { kind: 'installed', version: '9.9.9', mode: 'core' },
      }),
      install: h.spies.installerInstall,
    };
    return {
      INSTRUCTIONS_INSTALLERS: [installer],
      getInstructionsInstaller: () => installer,
    };
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
  'feedback',
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
    { argv: ['feedback'], module: 'feedback', handler: 'runFeedbackCommand', stdout: [] },
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

describe('cli: version help text (S2f)', () => {
  it('says in both languages that version does not load the config', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['help']);
    expect(logs[0]).toContain('does not load the config');
    h.language.value = 'es';
    logs = [];
    await dispatch(['help']);
    expect(logs[0]).toContain('no lee la configuración');
  });
});

describe('cli: compile cache guard (S2c)', () => {
  it('imports without throwing when node:module has no enableCompileCache (older Node)', async () => {
    vi.doMock('node:module', () => ({ enableCompileCache: undefined }));
    const mod = await import('./cli.js');
    expect(typeof mod.dispatch).toBe('function');
    vi.doUnmock('node:module');
  });

  it('calls enableCompileCache only when it is a function', async () => {
    const { enableCompileCacheIfAvailable } = await import('./cli.js');
    expect(enableCompileCacheIfAvailable({})).toBe(false);
    expect(enableCompileCacheIfAvailable({ enableCompileCache: 'nope' })).toBe(false);
    const enable = vi.fn();
    expect(enableCompileCacheIfAvailable({ enableCompileCache: enable })).toBe(true);
    expect(enable).toHaveBeenCalledTimes(1);
  });
});

describe('cli: entry-point heuristic (S2d)', () => {
  let dir: string;
  let self: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'browser-link-entry-'));
    self = join(dir, 'cli.js');
    writeFileSync(self, '');
    writeFileSync(join(dir, 'other.js'), '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the real entry script matches', async () => {
    const { isEntryScript } = await import('./cli.js');
    expect(isEntryScript(self, self)).toBe(true);
  });

  it('an entry given without the .js extension matches through the fallback', async () => {
    const { isEntryScript } = await import('./cli.js');
    expect(isEntryScript(join(dir, 'cli'), self)).toBe(true);
  });

  it('a different entry (the module merely imported) does not match', async () => {
    const { isEntryScript } = await import('./cli.js');
    expect(isEntryScript(join(dir, 'other.js'), self)).toBe(false);
    expect(isEntryScript(join(dir, 'missing.js'), self)).toBe(false);
    expect(isEntryScript(undefined, self)).toBe(false);
  });

  it('importing the CLI under a test runner is not the entry point', async () => {
    const mod = await import('./cli.js');
    expect(
      mod.isEntryScript(process.argv.at(1), fileURLToPath(new URL('./cli.ts', import.meta.url))),
    ).toBe(false);
  });
});

describe('cli: feedback (S12)', () => {
  it('passes the arguments and the language, and exits with the command code', async () => {
    h.language.value = 'es';
    const dispatch = await loadDispatch();
    await dispatch(['feedback', 'issue', '3']);
    expect(h.spies.runFeedbackCommand).toHaveBeenCalledWith(['issue', '3'], 'es');
    h.spies.runFeedbackCommand.mockResolvedValueOnce(2);
    await expect(dispatch(['feedback', 'issue', 'x'])).rejects.toEqual(new ExitCalled(2));
  });

  it('the help names the feedback command in both languages', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['help']);
    expect(logs[0]).toContain('  browser-link feedback [--limit <n>]');
    expect(logs[0]).toContain('  browser-link feedback issue <id>');
    expect(logs[0]).toContain('only after you type y');
    h.language.value = 'es';
    logs = [];
    await dispatch(['help']);
    expect(logs[0]).toContain('  browser-link feedback issue <id>');
    expect(logs[0]).toContain('solo después de que escribas y');
  });
});

describe('cli: instructions install --with-core (S13)', () => {
  it('default install keeps the trigger-only path', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['instructions', 'install']);
    expect(h.spies.installInstructionsAll).toHaveBeenCalledTimes(1);
    expect(h.spies.installerInstall).not.toHaveBeenCalled();
  });

  it('--with-core installs the trigger plus the core through each installer', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['instructions', 'install', '--with-core', '--client', 'claude']);
    expect(h.spies.installerInstall).toHaveBeenCalledWith({ withCore: true });
    expect(h.spies.installInstructionsAll).not.toHaveBeenCalled();
    expect(h.spies.installInstructionsFor).not.toHaveBeenCalled();
    expect(logs).toEqual([
      '· Claude Code: Inserted the block.',
      '',
      'Restart your MCP client so it picks up the new instructions on its next session.',
    ]);
  });

  it('a failing installer is reported, not thrown', async () => {
    h.spies.installerInstall.mockImplementationOnce(() => {
      throw new Error('refused: symlink');
    });
    const dispatch = await loadDispatch();
    await dispatch(['instructions', 'install', '--with-core']);
    expect(logs[0]).toBe('· Claude Code: refused: symlink');
  });

  it('status shows the mode of each installed block, in both languages', async () => {
    h.spies.statusAll.mockReturnValueOnce([
      {
        client: 'claude',
        displayName: 'Claude Code',
        filePath: 'x',
        state: { kind: 'installed', version: '9.9.9', mode: 'core' },
        ok: true,
      },
      {
        client: 'opencode',
        displayName: 'OpenCode',
        filePath: 'y',
        state: { kind: 'installed-outdated', version: '0.1.0' },
        ok: true,
      },
      {
        client: 'copilot',
        displayName: 'GitHub Copilot CLI',
        filePath: 'z',
        state: { kind: 'no-file' },
        ok: true,
      },
    ] as never);
    const dispatch = await loadDispatch();
    await dispatch(['instructions']);
    expect(logs).toEqual([
      'instructions-status',
      '',
      'Block contents:',
      '  Claude Code  trigger + core rules (installed with --with-core)',
      '  OpenCode     trigger only (the rules arrive with the first browser call)',
    ]);
    h.language.value = 'es';
    h.spies.statusAll.mockReturnValueOnce([
      {
        client: 'claude',
        displayName: 'Claude Code',
        filePath: 'x',
        state: { kind: 'installed', version: '9.9.9', mode: 'trigger' },
        ok: true,
      },
    ] as never);
    logs = [];
    await dispatch(['instructions']);
    expect(logs.slice(1)).toEqual([
      '',
      'Contenido del bloque:',
      '  Claude Code  solo el disparador (las reglas llegan con la primera llamada al navegador)',
    ]);
  });

  it('the help names --with-core in both languages', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['help']);
    expect(logs[0]).toContain('  browser-link instructions install --with-core');
    expect(logs[0]).toContain('the first browser call returns the rules');
    h.language.value = 'es';
    logs = [];
    await dispatch(['help']);
    expect(logs[0]).toContain('  browser-link instructions install --with-core');
    expect(logs[0]).toContain('la primera llamada al navegador devuelve las reglas');
  });
});
