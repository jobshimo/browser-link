import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../map/db.js';
import { listApps, listInsights, saveInsight } from '../map/queries.js';
import { runMapCommand } from './map.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-map-insights-cmd-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function seed(): void {
  saveInsight({
    origin: 'http://x',
    title: 'My App',
    kind: 'pitfall',
    key: 'p',
    description: 'does not work',
    symptom: 'silent',
  });
  saveInsight({
    origin: 'http://x',
    title: 'My App',
    kind: 'mechanism',
    key: 'm',
    description: 'GET completes it',
  });
}

describe('map show / export / import — mechanisms and pitfalls', () => {
  test('show lists pitfalls and mechanisms', () => {
    seed();
    const out = runMapCommand(['show', 'my-app']);
    expect(out).toMatch(/Pitfalls \(1\)/);
    expect(out).toMatch(/p — does not work/);
    expect(out).toMatch(/silent/);
    expect(out).toMatch(/Mechanisms \(1\)/);
    expect(out).toMatch(/m — GET completes it/);
  });

  test('export includes them and a fresh-DB import restores them', () => {
    seed();
    const file = join(dataDir, 'export.json');
    runMapCommand(['export', '--out', file]);
    closeDb();
    rmSync(join(dataDir, 'map.db'), { force: true });
    rmSync(join(dataDir, 'map.db-wal'), { force: true });
    rmSync(join(dataDir, 'map.db-shm'), { force: true });

    runMapCommand(['import', file]);
    const [app] = listApps();
    expect(listInsights(app!.id, 'pitfall')[0]).toMatchObject({
      key: 'p',
      description: 'does not work',
      symptom: 'silent',
    });
    expect(listInsights(app!.id, 'mechanism')[0]).toMatchObject({ key: 'm' });
  });

  test('importing a pre-existing export file without the new sections still works', () => {
    const file = join(dataDir, 'old.json');
    writeFileSync(
      file,
      JSON.stringify({
        browser_link_map_export: 1,
        exported_at: 'now',
        apps: [
          { origin: 'http://x', app_key: 'a', title: null, notes: null, entries: [], flows: [] },
        ],
      }),
    );
    expect(() => runMapCommand(['import', file])).not.toThrow();
  });

  test('a malformed pitfall aborts the whole import with a readable report', () => {
    const file = join(dataDir, 'bad.json');
    writeFileSync(
      file,
      JSON.stringify({
        browser_link_map_export: 1,
        exported_at: 'now',
        apps: [
          {
            origin: 'http://x',
            app_key: 'a',
            entries: [],
            flows: [],
            pitfalls: [{ key: '', description: 'd' }],
          },
        ],
      }),
    );
    expect(() => runMapCommand(['import', file])).toThrowError(/pitfall #0/);
    expect(listApps()).toEqual([]);
  });
});
