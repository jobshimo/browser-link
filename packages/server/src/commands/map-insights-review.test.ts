import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../map/db.js';
import { listApps, listInsights, saveInsight } from '../map/queries.js';
import { runMapCommand } from './map.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-map-insights-review-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const base = { origin: 'http://x', title: 'My App' };

function seed(): number {
  const { app } = saveInsight({ ...base, kind: 'pitfall', key: 'p', description: 'does not work' });
  saveInsight({ ...base, kind: 'mechanism', key: 'm', description: 'GET completes it' });
  return app.id;
}

function writeExport(name: string, app: Record<string, unknown>): string {
  const file = join(dataDir, name);
  writeFileSync(
    file,
    JSON.stringify({
      browser_link_map_export: 1,
      exported_at: 'now',
      apps: [{ origin: 'http://x', app_key: 'a', entries: [], flows: [], ...app }],
    }),
  );
  return file;
}

describe('map ls / forget count insights (W1)', () => {
  test('ls shows an insights column', () => {
    seed();
    const out = runMapCommand(['ls']);
    expect(out).toMatch(/INSIGHTS/);
    expect(out).toMatch(/my-app\s+http:\/\/x\s+0\s+0\s+2/);
  });

  test('the forget dry-run mentions the pitfalls and mechanisms it would delete', () => {
    seed();
    const out = runMapCommand(['forget', 'my-app']);
    expect(out).toMatch(/0 entries and 0 flows/);
    expect(out).toMatch(/2 pitfalls\/mechanisms/);
    expect(listApps()).toHaveLength(1);
  });

  test('the dry-run text is unchanged for an app without insights', () => {
    saveInsight({ ...base, kind: 'pitfall', key: 'p', description: 'd' });
    const id = listApps()[0]!.id;
    runMapCommand(['forget', 'my-app', '--pitfall', 'p']);
    expect(listInsights(id, 'pitfall')).toEqual([]);
    expect(runMapCommand(['forget', 'my-app'])).not.toMatch(/pitfalls\/mechanisms/);
  });

  test('--yes reports the deleted insights', () => {
    seed();
    expect(runMapCommand(['forget', 'my-app', '--yes'])).toMatch(/2 pitfalls\/mechanisms/);
    expect(listApps()).toEqual([]);
  });
});

describe('map forget --pitfall / --mechanism (W2)', () => {
  test('deletes just that insight', () => {
    const id = seed();
    const out = runMapCommand(['forget', 'my-app', '--pitfall', 'p']);
    expect(out).toMatch(/Deleted pitfall "p"/);
    expect(listInsights(id, 'pitfall')).toEqual([]);
    expect(listInsights(id, 'mechanism')).toHaveLength(1);
    runMapCommand(['forget', 'my-app', '--mechanism', 'm']);
    expect(listInsights(id, 'mechanism')).toEqual([]);
  });

  test('a valueless flag and an unknown key are clear errors', () => {
    seed();
    expect(() => runMapCommand(['forget', 'my-app', '--pitfall'])).toThrow(/--pitfall requires/);
    expect(() => runMapCommand(['forget', 'my-app', '--mechanism', 'nope'])).toThrow(
      /No mechanism named "nope"/,
    );
  });

  test('an ambiguous app_key needs --yes, like --flow', () => {
    saveInsight({ origin: 'http://a', title: 'Same', kind: 'pitfall', key: 'p', description: 'd' });
    saveInsight({ origin: 'http://b', title: 'Same', kind: 'pitfall', key: 'p', description: 'd' });
    expect(runMapCommand(['forget', 'same', '--pitfall', 'p'])).toMatch(/Nothing was deleted/);
    expect(runMapCommand(['forget', 'same', '--pitfall', 'p', '--yes'])).toMatch(/Deleted pitfall/);
  });
});

describe('import validates insights with the save rules (W3)', () => {
  test.each([
    ['key longer than 100', { pitfalls: [{ key: 'k'.repeat(101), description: 'd' }] }],
    ['description longer than 1000', { mechanisms: [{ key: 'k', description: 'x'.repeat(1001) }] }],
    ['symptom on a mechanism', { mechanisms: [{ key: 'k', description: 'd', symptom: 's' }] }],
    [
      'symptom longer than 1000',
      { pitfalls: [{ key: 'k', description: 'd', symptom: 's'.repeat(1001) }] },
    ],
    ['non-string symptom', { pitfalls: [{ key: 'k', description: 'd', symptom: 4 }] }],
  ])('aborts on %s', (_name, extra) => {
    const file = writeExport('bad.json', extra);
    expect(() => runMapCommand(['import', file])).toThrowError(/Import aborted/);
    expect(listApps()).toEqual([]);
  });

  test('a symptom: null on a mechanism (as exported) is accepted, key is trimmed', () => {
    const file = writeExport('ok.json', {
      mechanisms: [{ key: '  m  ', description: 'd', symptom: null }],
    });
    runMapCommand(['import', file]);
    expect(listInsights(listApps()[0]!.id, 'mechanism')[0]?.key).toBe('m');
  });

  test('caps the number of insights per file', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ key: `k${i}`, description: 'd' }));
    const file = writeExport('many.json', { pitfalls: many });
    expect(() => runMapCommand(['import', file])).toThrowError(/too many insights/);
  });

  test('the summary reports imported pitfalls and mechanisms, and stays unchanged without them', () => {
    const file = writeExport('ok.json', {
      pitfalls: [{ key: 'p', description: 'd' }],
      mechanisms: [{ key: 'm', description: 'd' }],
    });
    expect(runMapCommand(['import', file])).toMatch(/1 pitfall, 1 mechanism\./);
    closeDb();
    rmSync(join(dataDir, 'map.db'), { force: true });
    rmSync(join(dataDir, 'map.db-wal'), { force: true });
    rmSync(join(dataDir, 'map.db-shm'), { force: true });
    const plain = writeExport('plain.json', {});
    expect(runMapCommand(['import', plain])).toMatch(/0 entries, 0 flows\.$/);
  });
});
