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
    statusFor: vi.fn(() => ({ state: { kind: 'no-file' } })),
    installInstructionsAll: vi.fn(() => []),
    installInstructionsFor: vi.fn(() => ({})),
    uninstallInstructionsAll: vi.fn(() => []),
    uninstallInstructionsFor: vi.fn(() => ({})),
  };
  return { loaded, language, spies };
});

function registerModuleMocks(): void {
  vi.doMock('./config.js', async () => {
    const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
    h.loaded.add('config');
    return { loadConfig: h.spies.loadConfig, ConfigUnreadableError: actual.ConfigUnreadableError };
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
    // D9 regression guards: every valid spelling that worked before still
    // reaches its handler.
    { argv: ['instructions', 'status'], module: 'instructions', handler: 'statusAll' },
    {
      argv: ['instructions', 'status', '--client', 'claude'],
      module: 'instructions',
      handler: 'statusFor',
    },
    {
      argv: ['instructions', 'install', '--client', 'opencode'],
      module: 'instructions',
      handler: 'installInstructionsFor',
    },
    { argv: ['tools'], module: 'tools', handler: 'runToolsCommand' },
    { argv: ['tools', 'enable', 'a', 'b', 'c'], module: 'tools', handler: 'runToolsCommand' },
    { argv: ['tools', 'preset', 'readonly'], module: 'tools', handler: 'runToolsCommand' },
    {
      argv: ['multi-agent', 'auto-reelect', 'enable'],
      module: 'multi-agent',
      handler: 'runMultiAgentCommand',
    },
    {
      argv: ['config', 'set', 'idle-ttl', '15'],
      module: 'config-command',
      handler: 'runConfigCommand',
    },
    {
      argv: ['config', 'restore-defaults', '--yes'],
      module: 'config-command',
      handler: 'runConfigCommand',
    },
    { argv: ['cdp', 'allow', '--minutes', '5'], module: 'cdp', handler: 'runCdpCommand' },
    {
      argv: ['map', 'forget', 'my-app', '--flow', 'login', '--yes'],
      module: 'map',
      handler: 'runMapCommand',
    },
    { argv: ['map', 'forget', '--yes', 'my-app'], module: 'map', handler: 'runMapCommand' },
    {
      argv: ['map', 'export', 'my-app', '--out', 'f.json'],
      module: 'map',
      handler: 'runMapCommand',
    },
    { argv: ['map', 'import', 'f.json', '--replace'], module: 'map', handler: 'runMapCommand' },
    {
      argv: ['activity', 'export', '--out', 'a.csv', '--format', 'csv', '--redact'],
      module: 'activity',
      handler: 'runActivityCommand',
    },
    {
      argv: ['activity', 'clear', '--from', '2026-01-01', '--to', '2026-01-02', '--yes'],
      module: 'activity',
      handler: 'runActivityCommand',
    },
    {
      argv: ['activity', 'report', '--since', '7d'],
      module: 'activity',
      handler: 'runActivityCommand',
    },
    { argv: ['feedback', '--limit', '5'], module: 'feedback', handler: 'runFeedbackCommand' },
    { argv: ['feedback', 'issue', '3'], module: 'feedback', handler: 'runFeedbackCommand' },
    { argv: ['map', 'bogus'], module: 'map', handler: 'runMapCommand' },
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
    await dispatch(['map', 'forget', 'example.com', '--yes']);
    expect(h.spies.runMapCommand).toHaveBeenCalledWith(['forget', 'example.com', '--yes'], 'es');
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

/* D9 (owner decision): `--help` or `-h` in any position prints that
 * command's help and does nothing else; an unknown or malformed option, or
 * one missing its value, makes the command refuse and touch nothing;
 * `--option=value` and `--option value` are the same everywhere. These run
 * the real dispatch with every command module mocked, so a command that
 * would act is observed through its spy, never run. */
describe('cli D9: --help or -h in any position prints help and does nothing else', () => {
  const cases: { argv: string[]; handler: keyof typeof h.spies; usage: string }[] = [
    { argv: ['start', '--help'], handler: 'runServer', usage: '  browser-link        ' },
    { argv: ['install', '--help'], handler: 'installAll', usage: '  browser-link install' },
    { argv: ['install', '--client', 'claude', '-h'], handler: 'installFor', usage: 'install' },
    { argv: ['uninstall', '--help'], handler: 'uninstallAll', usage: '  browser-link uninstall' },
    { argv: ['uninstall', '-h', '--client', 'claude'], handler: 'uninstallFor', usage: 'uninst' },
    { argv: ['stop', '--help'], handler: 'runFreePort', usage: '  browser-link stop' },
    { argv: ['stop', '-h'], handler: 'runFreePort', usage: '  browser-link stop' },
    { argv: ['doctor', '--help'], handler: 'runDoctor', usage: '  browser-link doctor' },
    { argv: ['updates', '--help'], handler: 'checkUpdates', usage: '  browser-link updates' },
    {
      argv: ['extension', '--help'],
      handler: 'printExtensionInstructions',
      usage: '  browser-link extension',
    },
    { argv: ['about', '-h'], handler: 'printAbout', usage: '  browser-link about' },
    {
      argv: ['instructions', 'install', '--help'],
      handler: 'installInstructionsAll',
      usage: '  browser-link instructions install',
    },
    {
      argv: ['instructions', 'install', '--with-core', '-h'],
      handler: 'installerInstall',
      usage: '  browser-link instructions install --with-core',
    },
    {
      argv: ['instructions', 'uninstall', '--help'],
      handler: 'uninstallInstructionsAll',
      usage: '  browser-link instructions uninstall',
    },
    {
      argv: ['instructions', '--help'],
      handler: 'statusAll',
      usage: '  browser-link instructions',
    },
    {
      argv: ['cdp', 'allow', '--help'],
      handler: 'runCdpCommand',
      usage: '  browser-link cdp allow',
    },
    { argv: ['cdp', '-h', 'revoke'], handler: 'runCdpCommand', usage: '  browser-link cdp revoke' },
    {
      argv: ['tools', 'disable', 'browser.click', '--help'],
      handler: 'runToolsCommand',
      usage: '  browser-link tools disable',
    },
    {
      argv: ['multi-agent', 'enable', '--help'],
      handler: 'runMultiAgentCommand',
      usage: '  browser-link multi-agent enable',
    },
    {
      argv: ['config', 'set', 'idle-ttl', '5', '--help'],
      handler: 'runConfigCommand',
      usage: '  browser-link config set idle-ttl',
    },
    {
      argv: ['map', 'forget', 'my-app', '--yes', '--help'],
      handler: 'runMapCommand',
      usage: '  browser-link map forget <app>',
    },
  ];

  it.each(cases)(
    '$argv prints the help and never calls $handler',
    async ({ argv, handler, usage }) => {
      const dispatch = await loadDispatch();
      await dispatch(argv);
      expect(h.spies[handler]).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(usage);
      expect(logs[0].startsWith('Usage:')).toBe(true);
    },
  );

  it('the command help shows only that command, not the whole help', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['stop', '--help']);
    expect(logs[0]).toContain('  browser-link stop ');
    expect(logs[0]).not.toContain('browser-link install');
    expect(logs[0]).not.toContain('Environment:');
  });

  it('the command help is in Spanish when the configured language is es', async () => {
    h.language.value = 'es';
    const dispatch = await loadDispatch();
    await dispatch(['uninstall', '--help']);
    expect(logs[0].startsWith('Uso:')).toBe(true);
    expect(logs[0]).toContain('Elimina todos los registros.');
    expect(h.spies.uninstallAll).not.toHaveBeenCalled();
  });

  it('version --help prints the version help, not the version', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['version', '--help']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('  browser-link version');
  });

  it.each([
    ['activity', 'clear', '--yes', '--help'],
    ['feedback', 'issue', '3', '-h'],
  ])('%j hands the help to the command, which owns its usage text', async (...argv) => {
    const dispatch = await loadDispatch();
    await dispatch(argv);
    const spy = argv[0] === 'activity' ? h.spies.runActivityCommand : h.spies.runFeedbackCommand;
    expect(spy).toHaveBeenCalledWith(argv.slice(1), 'en');
  });
});

describe('cli D9: an unknown, malformed or valueless option refuses and touches nothing', () => {
  const refusals: { argv: string[]; handler: keyof typeof h.spies; error: string }[] = [
    {
      argv: ['uninstall', '--client'],
      handler: 'uninstallAll',
      error: 'browser-link uninstall: option --client needs a value',
    },
    {
      argv: ['install', '--client'],
      handler: 'installAll',
      error: 'browser-link install: option --client needs a value',
    },
    {
      argv: ['install', '--client', '--yes'],
      handler: 'installAll',
      error: 'browser-link install: option --client needs a value',
    },
    {
      argv: ['uninstall', '--dry-run'],
      handler: 'uninstallAll',
      error: 'browser-link uninstall: unknown option --dry-run',
    },
    {
      argv: ['install', '--client=claude', '--client', 'opencode'],
      handler: 'installFor',
      error: 'browser-link install: option --client was given more than once',
    },
    {
      argv: ['stop', 'now'],
      handler: 'runFreePort',
      error: 'browser-link stop: unexpected argument now',
    },
    {
      argv: ['stop', '--dry-run'],
      handler: 'runFreePort',
      error: 'browser-link stop: unknown option --dry-run',
    },
    { argv: ['start', '-x'], handler: 'runServer', error: 'browser-link start: unknown option -x' },
    {
      argv: ['doctor', '--nonsense'],
      handler: 'runDoctor',
      error: 'browser-link doctor: unknown option --nonsense',
    },
    {
      argv: ['instructions', 'uninstall', '--client'],
      handler: 'uninstallInstructionsAll',
      error: 'browser-link instructions uninstall: option --client needs a value',
    },
    {
      argv: ['instructions', 'install', '--with-core=yes'],
      handler: 'installerInstall',
      error:
        'browser-link instructions install: option --with-core does not take a value (got --with-core=yes)',
    },
    {
      argv: ['cdp', 'allow', '--minutes'],
      handler: 'runCdpCommand',
      error: 'browser-link cdp allow: option --minutes needs a value',
    },
    {
      argv: ['map', 'forget', 'my-app', '--flow', '--yes'],
      handler: 'runMapCommand',
      error: 'browser-link map forget: option --flow needs a value',
    },
    {
      argv: ['map', 'import', 'f.json', '--replace=true'],
      handler: 'runMapCommand',
      error: 'browser-link map import: option --replace does not take a value (got --replace=true)',
    },
    {
      argv: ['activity', 'clear', '--older-than', '--yes'],
      handler: 'runActivityCommand',
      error: 'browser-link activity clear: option --older-than needs a value',
    },
    {
      argv: ['activity', 'clear', '--from', '--yes'],
      handler: 'runActivityCommand',
      error: 'browser-link activity clear: option --from needs a value',
    },
    {
      argv: ['activity', 'clear', '--older-than=', '--yes'],
      handler: 'runActivityCommand',
      error: 'browser-link activity clear: option --older-than needs a value',
    },
    {
      argv: ['tools', 'enable', '--all'],
      handler: 'runToolsCommand',
      error: 'browser-link tools enable: unknown option --all',
    },
    {
      argv: ['multi-agent', 'enable', 'now'],
      handler: 'runMultiAgentCommand',
      error: 'browser-link multi-agent enable: unexpected argument now',
    },
    {
      argv: ['config', 'restore-defaults', '--force'],
      handler: 'runConfigCommand',
      error: 'browser-link config restore-defaults: unknown option --force',
    },
    {
      argv: ['feedback', '--limit'],
      handler: 'runFeedbackCommand',
      error: 'browser-link feedback: option --limit needs a value',
    },
    {
      argv: ['map', 'forget', 'my-app', '---flow', 'x'],
      handler: 'runMapCommand',
      error: 'browser-link map forget: could not read ---flow as an option',
    },
  ];

  it.each(refusals)(
    '$argv exits 2, says what it did not understand and never calls $handler',
    async ({ argv, handler, error }) => {
      const dispatch = await loadDispatch();
      await expect(dispatch(argv)).rejects.toEqual(new ExitCalled(2));
      expect(h.spies[handler]).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
      expect(errors[0]).toBe(error);
      expect(errors[1]).toBe(`Nothing was done. See: browser-link ${argv[0]} --help`);
    },
  );

  it('the refusal is in Spanish when the configured language is es', async () => {
    h.language.value = 'es';
    const dispatch = await loadDispatch();
    await expect(dispatch(['uninstall', '--client'])).rejects.toEqual(new ExitCalled(2));
    expect(errors).toEqual([
      'browser-link uninstall: la opción --client necesita un valor',
      'No se hizo nada. Consulte: browser-link uninstall --help',
    ]);
    expect(h.spies.uninstallAll).not.toHaveBeenCalled();
  });

  it('version with an unknown option refuses instead of printing the version', async () => {
    const dispatch = await loadDispatch();
    await expect(dispatch(['--version', '--json'])).rejects.toEqual(new ExitCalled(2));
    expect(errors[0]).toBe('browser-link version: unknown option --json');
    expect(logs).toEqual([]);
  });
});

describe('cli D9: --option=value and --option value are the same', () => {
  it.each([[['uninstall', '--client=opencode']], [['uninstall', '--client', 'opencode']]])(
    '%j removes only the named client',
    async (argv) => {
      const dispatch = await loadDispatch();
      await dispatch(argv);
      expect(h.spies.uninstallFor).toHaveBeenCalledWith('opencode');
      expect(h.spies.uninstallAll).not.toHaveBeenCalled();
    },
  );

  it('install --client=claude registers only claude', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['install', '--client=claude']);
    expect(h.spies.installFor).toHaveBeenCalledWith('claude');
    expect(h.spies.installAll).not.toHaveBeenCalled();
  });

  it('uninstall --client=x is an unknown client, rejected before anything runs', async () => {
    const dispatch = await loadDispatch();
    await expect(dispatch(['uninstall', '--client=x'])).rejects.toThrow(
      'Unknown --client value: x. Use claude, opencode or copilot.',
    );
    expect(h.spies.uninstallAll).not.toHaveBeenCalled();
    expect(h.spies.uninstallFor).not.toHaveBeenCalled();
  });

  it('instructions install --client=claude --with-core writes only claude, with the core', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['instructions', 'install', '--client=claude', '--with-core']);
    expect(h.spies.installerInstall).toHaveBeenCalledTimes(1);
    expect(h.spies.installInstructionsAll).not.toHaveBeenCalled();
  });

  it('instructions uninstall --client=copilot removes only copilot', async () => {
    const dispatch = await loadDispatch();
    await dispatch(['instructions', 'uninstall', '--client=copilot']);
    expect(h.spies.uninstallInstructionsFor).toHaveBeenCalledWith('copilot');
    expect(h.spies.uninstallInstructionsAll).not.toHaveBeenCalled();
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
