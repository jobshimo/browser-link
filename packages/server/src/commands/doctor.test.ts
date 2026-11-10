import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import {
  buildServerStatus,
  checkPort,
  formatDoctor,
  runDoctor,
  type DoctorReport,
} from './doctor.js';

/**
 * Doctor format-layer tests. v0.8.3 escalates outdated agent-instructions
 * blocks to red (ANSI \x1b[31m) and adds an explanatory subline below the
 * status. Yellow was the previous treatment but users were ignoring it.
 *
 * The runtime `runDoctor()` does live filesystem and network probes; we
 * only need to exercise the formatter here, so we hand it a synthetic
 * report.
 */

function makeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ws: { listening: false, detail: 'no MCP server running', host: '127.0.0.1', port: 17529 },
    ipc: { listening: false, detail: 'no MCP server running', host: '127.0.0.1', port: 17530 },
    multiAgent: { enabled: true, autoReelect: true },
    clients: [
      {
        id: 'claude',
        displayName: 'Claude Code',
        installed: true,
        registered: true,
        configPath: '/tmp/claude.json',
        instructions: {
          state: { kind: 'installed-outdated', version: '0.8.1' },
          filePath: '/tmp/CLAUDE.md',
        },
      },
    ],
    extension: { path: null },
    map: { dbPath: '/tmp/map.db', exists: false, sizeBytes: 0, apps: 0 },
    security: { allowedBrowsers: [] },
    silentDebugger: { detected: null },
    ...overrides,
  };
}

const RED = '[31m';

describe('formatDoctor — outdated agent-instructions block', () => {
  test('wraps the outdated label in the ANSI red SGR sequence', () => {
    const out = formatDoctor(makeReport());
    // The outdated label uses the ⚠ marker and is wrapped in RED.
    expect(out).toContain(`${RED}⚠ outdated (v0.8.1)`);
  });

  test('renders an explanatory subline naming the installed version', () => {
    const out = formatDoctor(makeReport());
    expect(out).toContain('outdated since v0.8.1 — refresh recommended.');
  });

  test('legacy (version null) renders "outdated since legacy"', () => {
    const report = makeReport({
      clients: [
        {
          id: 'claude',
          displayName: 'Claude Code',
          installed: true,
          registered: true,
          configPath: '/tmp/claude.json',
          instructions: {
            state: { kind: 'installed-outdated', version: null },
            filePath: '/tmp/CLAUDE.md',
          },
        },
      ],
    });
    const out = formatDoctor(report);
    expect(out).toContain('outdated since legacy — refresh recommended.');
    // No "outdated since v" with no version after it.
    expect(out).not.toMatch(/outdated since v\s/);
  });

  test('no red wrapping when the block is up to date', () => {
    const report = makeReport({
      clients: [
        {
          id: 'claude',
          displayName: 'Claude Code',
          installed: true,
          registered: true,
          configPath: '/tmp/claude.json',
          instructions: {
            state: { kind: 'installed', version: '0.8.3' },
            filePath: '/tmp/CLAUDE.md',
          },
        },
      ],
    });
    const out = formatDoctor(report);
    expect(out).not.toContain(RED);
    expect(out).not.toContain('refresh recommended');
  });

  test('ES copy uses Rioplatense subline', () => {
    const out = formatDoctor(makeReport(), 'es');
    expect(out).toContain('desactualizadas desde v0.8.1 — se recomienda refrescar.');
  });
});

describe('formatDoctor — Chrome debugger infobar detection', () => {
  test('detected:true renders the suppressed-infobar confirmation', () => {
    const out = formatDoctor(makeReport({ silentDebugger: { detected: true } }));
    expect(out).toContain('--silent-debugger-extension-api detected');
  });

  test('detected:false renders the "will show" note, not an error', () => {
    const out = formatDoctor(makeReport({ silentDebugger: { detected: false } }));
    expect(out).toContain('not detected — Chrome will show');
  });

  test('detected:null degrades to a neutral informational line, no ✗', () => {
    const out = formatDoctor(makeReport({ silentDebugger: { detected: null } }));
    expect(out).toContain('could not determine');
  });

  test('ES copy renders the neutral Rioplatense line for detected:null', () => {
    const out = formatDoctor(makeReport({ silentDebugger: { detected: null } }), 'es');
    expect(out).toContain('no se pudo determinar');
  });
});

describe('formatDoctor — running X / installed Y (S3a)', () => {
  const outdated: Partial<DoctorReport> = {
    server: {
      running: { version: '0.37.0', pid: 40296, startedAt: '2026-11-09T01:00:00.000Z' },
      installed: '0.41.0',
      outdated: true,
    },
    processes: [
      { pid: 40296, startedAt: '2026-11-09T01:00:00.000Z', command: 'node browser-link' },
      { pid: 51044, startedAt: null, command: 'node browser-link start' },
    ],
  };

  test('outdated: running, pid, installed and what to do', () => {
    const out = formatDoctor(makeReport(outdated));
    expect(out).toContain(
      'running 0.37.0 (pid 40296) / installed 0.41.0 → outdated, run `browser-link stop` and restart your agent',
    );
  });

  test('lists every live browser-link process', () => {
    const out = formatDoctor(makeReport(outdated));
    expect(out).toContain('Live browser-link processes:');
    expect(out).toMatch(/PID 40296 {2}node browser-link {2}\(started 2026-11-09T01:00:00\.000Z\)/);
    expect(out).toMatch(/PID 51044 {2}node browser-link start/);
  });

  test('up to date: no outdated warning', () => {
    const out = formatDoctor(
      makeReport({
        server: {
          running: { version: '0.41.0', pid: 7, startedAt: '2026-11-09T01:00:00.000Z' },
          installed: '0.41.0',
          outdated: false,
        },
        processes: [],
      }),
    );
    expect(out).toContain('running 0.41.0 (pid 7) / installed 0.41.0');
    expect(out).not.toContain('→ outdated');
    expect(out).toContain('Live browser-link processes: none');
  });

  test('no server answering /version: installed only', () => {
    const out = formatDoctor(
      makeReport({
        server: { running: null, installed: '0.41.0', outdated: false },
        processes: [],
      }),
    );
    expect(out).toContain(
      'running: no /version answer (none, or older than 0.41.0) / installed 0.41.0',
    );
  });

  test('ES copy', () => {
    const out = formatDoctor(makeReport(outdated), 'es');
    expect(out).toContain(
      'corriendo 0.37.0 (pid 40296) / instalado 0.41.0 → desactualizado, corré `browser-link stop` y reiniciá tu agente',
    );
    expect(out).toContain('Procesos browser-link vivos:');
  });

  test('a report without the new fields renders as before', () => {
    const out = formatDoctor(makeReport());
    expect(out).not.toContain('running ');
    expect(out).not.toContain('Live browser-link processes');
  });
});

describe('buildServerStatus', () => {
  test('outdated when the running version is older than the installed one', () => {
    expect(
      buildServerStatus(
        {
          kind: 'version',
          info: {
            name: '@jobshimo/browser-link',
            version: '0.37.0',
            pid: 40296,
            startedAt: '2026-11-09T01:00:00.000Z',
            installedVersion: '0.41.0',
          },
        },
        '0.41.0',
      ),
    ).toEqual({
      running: { version: '0.37.0', pid: 40296, startedAt: '2026-11-09T01:00:00.000Z' },
      installed: '0.41.0',
      outdated: true,
    });
  });

  test('not outdated without a /version answer or an installed version', () => {
    expect(buildServerStatus({ kind: 'no-endpoint' }, '0.41.0')).toEqual({
      running: null,
      installed: '0.41.0',
      outdated: false,
    });
  });
});

describe('runDoctor — concurrency (S1)', () => {
  test('starts both port probes, the version probe and both process scans before awaiting any', async () => {
    const log: string[] = [];
    const releases: (() => void)[] = [];
    function deferred<T>(name: string, value: T): () => Promise<T> {
      return () => {
        log.push(`start:${name}`);
        return new Promise<T>((resolve) => {
          releases.push(() => {
            log.push(`end:${name}`);
            resolve(value);
          });
        });
      };
    }
    const pending = runDoctor({
      checkPort: (host, port) =>
        deferred(`port:${port}`, { listening: false, detail: 'no MCP server running' })(),
      detectSilentDebugger: deferred('silent', { detected: false }),
      probeVersion: deferred('version', { kind: 'unreachable' } as const),
      listBridgeProcesses: deferred('processes', [
        { pid: 7, ppid: 1, startedAt: 0, command: 'node /usr/local/bin/browser-link' },
      ]),
      readInstalledVersion: () => '0.43.0',
      collectLocal: () => ({
        multiAgent: { enabled: false, autoReelect: false },
        clients: [],
        extension: { path: null },
        map: { dbPath: '/tmp/map.db', exists: false, sizeBytes: 0, apps: 0 },
        security: { allowedBrowsers: [] },
      }),
    });
    await Promise.resolve();
    expect(log).toEqual([
      'start:port:17529',
      'start:port:17530',
      'start:silent',
      'start:version',
      'start:processes',
    ]);
    for (const release of releases) release();
    const report = await pending;
    expect(report.ws).toEqual({
      listening: false,
      detail: 'no MCP server running',
      host: '127.0.0.1',
      port: 17529,
    });
    expect(report.ipc.port).toBe(17530);
    expect(report.silentDebugger).toEqual({ detected: false });
    expect(report.server).toEqual({ running: null, installed: '0.43.0', outdated: false });
    expect(report.processes).toEqual([
      { pid: 7, startedAt: '1970-01-01T00:00:00.000Z', command: 'node browser-link' },
    ]);
    expect(report.map.dbPath).toBe('/tmp/map.db');
  });
});

describe('formatDoctor — process binding: same OS user, names, strict mode', () => {
  const security = (peerExecutablePaths?: string[]): DoctorReport['security'] => ({
    allowedBrowsers: ['chrome.exe', 'msedge.exe'],
    ...(peerExecutablePaths === undefined ? {} : { peerExecutablePaths }),
  });

  test('says the check covers the same OS user plus the browser name', () => {
    const out = formatDoctor(makeReport({ security: security() }));
    expect(out).toContain('your OS user');
    expect(out).toContain('2 known browser binaries');
    expect(formatDoctor(makeReport({ security: security() }), 'es')).toContain('tu usuario del SO');
  });

  test('strict path mode off when peerExecutablePaths is absent', () => {
    expect(formatDoctor(makeReport({ security: security() }))).toContain(
      'Strict path mode (peerExecutablePaths): off',
    );
  });

  test('strict path mode on lists the paths in effect', () => {
    const out = formatDoctor(makeReport({ security: security(['C:\\a\\chrome.exe']) }));
    expect(out).toContain('Strict path mode (peerExecutablePaths): on, 1 path');
    expect(out).toContain('C:\\a\\chrome.exe');
  });

  test('strict path mode on with no valid path says every peer is refused', () => {
    const out = formatDoctor(makeReport({ security: security([]) }), 'es');
    expect(out).toContain('Modo estricto por ruta (peerExecutablePaths): activado');
    expect(out).toContain('se rechaza todo');
  });
});

describe('checkPort — a stalled event loop is not a closed port (S1)', () => {
  test('a connect that completed during a synchronous stall still counts as listening', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const pending = checkPort('127.0.0.1', port, 50);
      // The concurrent doctor does synchronous work (process spawns, local
      // file reads) while the probe is in flight: block past the timeout.
      const until = Date.now() + 250;
      while (Date.now() < until) {
        /* busy */
      }
      expect(await pending).toEqual({
        listening: true,
        detail: `something is listening on 127.0.0.1:${port}`,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
