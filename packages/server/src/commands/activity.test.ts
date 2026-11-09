import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeActivityDb } from '../activity/db.js';
import { countInRange, record } from '../activity/queries.js';
import { localDayToUtc, parseDuration, runActivityCommand } from './activity.js';
import type { ActivityInput } from '../activity/types.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-activity-cli-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeActivityDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function row(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    tool: 'browser.click',
    tabId: 'tab_1',
    transport: 'extension',
    url: 'https://example.com/a',
    title: 'A',
    agent: 'claude-code',
    agentPid: 1,
    selector: '#go',
    payload: null,
    outcome: 'ok',
    error: null,
    durationMs: 10,
    flowId: null,
    ...over,
  };
}

/**
 * The storage/display contract, pinned.
 *
 * The DB stores UTC. Everything the operator types is their LOCAL calendar day
 * and everything they read is their LOCAL time. These tests exist because the
 * CLI and the extension window originally disagreed about that — the same
 * `--to 2026-07-31` selected different rows in each — and a mismatch like that
 * is invisible until it silently spares or deletes a day of history.
 */
describe('local-day → UTC boundary', () => {
  test('start and end of a local day bracket that whole day', () => {
    const start = localDayToUtc('2026-07-31', 'start');
    const end = localDayToUtc('2026-07-31', 'end');
    expect(new Date(start).getTime()).toBeLessThan(new Date(end).getTime());
    // Exactly one day minus the final millisecond.
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(86_400_000 - 1);
  });

  test('the boundaries are the LOCAL day, not the UTC one', () => {
    const start = new Date(localDayToUtc('2026-07-31', 'start'));
    // Whatever the host offset is, midnight local on the 31st is what was asked
    // for — and a naive `${day}T00:00:00.000Z` would only agree at UTC+0.
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6);
    expect(start.getDate()).toBe(31);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });

  test('an end-of-day bound includes an action recorded during that day', () => {
    const stored = record(row());
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    // The row was written moments ago, so "everything up to the end of today,
    // local" must include it. With a UTC-anchored bound this is the assertion
    // that fails for anyone west of Greenwich late in the day.
    expect(countInRange({ to: localDayToUtc(day, 'end') })).toBe(1);
    expect(stored).not.toBeNull();
  });
});

describe('runActivityCommand', () => {
  test('an empty trail says so rather than printing a bare table', () => {
    expect(runActivityCommand([])).toContain('No activity recorded yet.');
  });

  test('lists recorded actions newest first', () => {
    record(row({ selector: '#first' }));
    record(row({ selector: '#second' }));
    const out = runActivityCommand([]);
    expect(out.indexOf('#second')).toBeLessThan(out.indexOf('#first'));
  });

  test('--failed narrows to errors', () => {
    record(row({ selector: '#ok' }));
    record(row({ selector: '#bad', outcome: 'error', error: 'boom' }));
    const out = runActivityCommand(['--failed']);
    expect(out).toContain('#bad');
    expect(out).not.toContain('#ok');
  });

  test('stats reports rows and a size', () => {
    record(row());
    const out = runActivityCommand(['stats']);
    expect(out).toContain('Actions stored');
    expect(out).toContain('Size on disk');
  });

  test('clear over a range counts first and refuses without --yes', () => {
    record(row());
    const out = runActivityCommand(['clear', '--to', '2999-01-01']);
    expect(out).toContain('permanently delete');
    expect(out).toContain('--yes');
    // Nothing was deleted by the refusal.
    expect(countInRange({})).toBe(1);
  });

  test('clear over a range with --yes deletes', () => {
    record(row());
    expect(runActivityCommand(['clear', '--to', '2999-01-01', '--yes'])).toContain('Removed');
    expect(countInRange({})).toBe(0);
  });

  test('wiping everything still demands --yes', () => {
    record(row());
    expect(runActivityCommand(['clear'])).toContain('--yes');
    expect(countInRange({})).toBe(1);
  });

  test('help is available in both languages', () => {
    expect(runActivityCommand(['help'])).toContain('browser-link activity');
    expect(runActivityCommand(['help'], 'es')).toContain('Acciones recientes');
  });
});

describe('parseDuration', () => {
  test.each([
    ['30m', 1_800_000],
    ['12h', 43_200_000],
    ['7d', 604_800_000],
  ])('%s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  test.each(['', '7', 'd', '0d', '-3d', '7w', '03/04'])('rejects %s', (input) => {
    expect(parseDuration(input)).toBeNull();
  });
});

describe('activity report', () => {
  function seedReport(): void {
    record(row({ selector: '.done', tool: 'browser.wait_for', flag: 'unmatched', agentId: 's-1' }));
    record(
      row({
        tool: 'browser.evaluate',
        selector: null,
        outcome: 'error',
        error: "Tool 'browser.evaluate' timed out after 30000ms",
        flag: 'timeout',
        agentId: 's-1',
      }),
    );
    record(row({ agent: 'opencode', agentId: 's-2' }));
  }

  test('prints the friction report in English', () => {
    seedReport();
    expect(runActivityCommand(['report'])).toBe(
      [
        'Friction report: 3 actions, 1 errors, 1 timeouts, 1 evaluate calls',
        '',
        'Flags',
        '  timeout             1',
        '  unmatched           1',
        '',
        'Errors by tool',
        '  browser.evaluate    1',
        '',
        'Top failing targets',
        '  TARGET                          TOOL                      COUNT   LAST FLAG',
        '  .done                           browser.wait_for          1       unmatched',
        '',
        'Sessions',
        '  SESSION                               AGENT           ACTIONS   ERRORS   FLAGS',
        '  s-2                                   opencode        1         0        —',
        '  s-1                                   claude-code     2         1        timeout 1, unmatched 1',
        '',
        'Cost and map usage',
        '  result bytes            0 B',
        '  evaluate share          33%',
        '  list_tabs calls         0',
        '  map.recall calls        0',
        '  readers run             0',
      ].join('\n'),
    );
  });

  test('prints the friction report in Spanish', () => {
    seedReport();
    expect(runActivityCommand(['report'], 'es')).toBe(
      [
        'Informe de fricción: 3 acciones, 1 errores, 1 timeouts, 1 llamadas a evaluate',
        '',
        'Señales',
        '  timeout             1',
        '  unmatched           1',
        '',
        'Errores por herramienta',
        '  browser.evaluate    1',
        '',
        'Objetivos que más fallan',
        '  OBJETIVO                        HERRAMIENTA               VECES   ÚLTIMA SEÑAL',
        '  .done                           browser.wait_for          1       unmatched',
        '',
        'Sesiones',
        '  SESIÓN                                AGENTE          ACCIONES  ERRORES  SEÑALES',
        '  s-2                                   opencode        1         0        —',
        '  s-1                                   claude-code     2         1        timeout 1, unmatched 1',
        '',
        'Coste y uso del mapa',
        '  bytes de resultados     0 B',
        '  cuota de evaluate       33%',
        '  llamadas a list_tabs    0',
        '  llamadas a map.recall   0',
        '  lectores ejecutados     0',
      ].join('\n'),
    );
  });

  test('prints result bytes by tool and the map counters, in both languages', () => {
    record(row({ tool: 'browser.evaluate', selector: null, resultBytes: 3000 }));
    record(row({ tool: 'browser.map.recall', tabId: null, selector: null, resultBytes: 200 }));
    record(row({ tool: 'browser.list_tabs', tabId: null, selector: null, resultBytes: 100 }));
    record(row({ tool: 'browser.read', selector: null, resultBytes: 50 }));
    const en = runActivityCommand(['report']).split('\n');
    expect(en.slice(en.indexOf('Cost and map usage'))).toEqual([
      'Cost and map usage',
      '  result bytes            3.3 KB',
      '  evaluate share          25%',
      '  list_tabs calls         1',
      '  map.recall calls        1',
      '  readers run             1',
      '',
      'Result bytes by tool',
      '  browser.evaluate        2.9 KB',
      '  browser.map.recall      200 B',
      '  browser.list_tabs       100 B',
      '  browser.read            50 B',
    ]);
    const es = runActivityCommand(['report'], 'es').split('\n');
    expect(es.slice(es.indexOf('Bytes de resultados por herramienta'))).toEqual([
      'Bytes de resultados por herramienta',
      '  browser.evaluate        2.9 KB',
      '  browser.map.recall      200 B',
      '  browser.list_tabs       100 B',
      '  browser.read            50 B',
    ]);
  });

  test('--agent narrows to one session id', () => {
    seedReport();
    const out = runActivityCommand(['report', '--agent', 's-2']);
    expect(out).toContain('Friction report: 1 actions, 0 errors');
    expect(out).not.toContain('s-1');
  });

  test('--since accepts a duration and an ISO date', () => {
    seedReport();
    expect(runActivityCommand(['report', '--since', '1h'])).toContain('3 actions');
    expect(runActivityCommand(['report', '--since', '2999-01-01T00:00:00Z'])).toContain(
      'No activity recorded yet.',
    );
  });

  test('an unreadable --since is refused, not ignored', () => {
    expect(runActivityCommand(['report', '--since', 'yesterday'])).toContain(
      'Could not read "yesterday"',
    );
  });

  test('an empty trail says so', () => {
    expect(runActivityCommand(['report'])).toContain('No activity recorded yet.');
  });

  test('help documents the report in both languages', () => {
    expect(runActivityCommand(['help'])).toContain('browser-link activity report');
    expect(runActivityCommand(['help'], 'es')).toContain('browser-link activity report');
  });
});

describe('existing subcommands keep their output', () => {
  test('list renders the same columns, ignoring flag and agent id', () => {
    record(row({ selector: '#a', flag: 'unsettled', agentId: 's-1' }));
    const out = runActivityCommand([]);
    expect(out.split('\n')[0]).toMatch(/^WHEN\s+AGENT\s+TOOL\s+TARGET\s+RESULT$/);
    expect(out).toContain('#a');
    expect(out).toContain('ok 10ms');
    expect(out).not.toContain('unsettled');
    expect(out).toContain('Showing 1 of 1 recorded actions.');
  });

  test('csv export keeps exactly the previous columns', () => {
    record(row({ flag: 'timeout', agentId: 's-1', resultBytes: 42 }));
    const out = join(dataDir, 'out.csv');
    runActivityCommand(['export', '--format', 'csv', '--out', out]);
    expect(readFileSync(out, 'utf8').split('\n')[0]).toBe(
      'id,at,tool,tabId,transport,url,title,agent,agentPid,selector,payload,outcome,error,durationMs,flowId',
    );
  });
});
