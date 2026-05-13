import { describe, expect, test } from 'vitest';
import { formatDoctor, type DoctorReport } from './doctor.js';

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
