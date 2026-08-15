import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
