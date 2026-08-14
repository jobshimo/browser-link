import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../map/db.js';
import {
  listApps,
  listEntries,
  listFlows,
  recordUse,
  restoreFlow,
  saveEntry,
  saveFlow,
  upsertApp,
} from '../map/queries.js';
import { formatRelative, runMapCommand } from './map.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-map-cmd-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const STEPS = [{ find: { text: '<QUERY>', role: 'textbox' } }, { click: {} }];

describe('map ls', () => {
  test('reports the empty state and points at browser.map.save', () => {
    const out = runMapCommand(['ls']);
    expect(out).toMatch(/No apps known yet/);
    expect(out).toMatch(/browser\.map\.save/);
  });

  test('bare "map" (no subcommand) behaves like ls', () => {
    expect(runMapCommand([])).toBe(runMapCommand(['ls']));
  });

  test('lists app_key, origin, entry/flow counts and a header row', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    saveFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS });

    const out = runMapCommand(['ls']);
    expect(out).toMatch(/APP_KEY/);
    expect(out).toMatch(/ORIGIN/);
    expect(out).toMatch(/my-app/);
    expect(out).toMatch(/http:\/\/x/);
    // one entry, one flow
    expect(out).toMatch(/my-app\s+http:\/\/x\s+1\s+1/);
  });
});

describe('map show', () => {
  test('resolves by app_key and prints entries + flows', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'open dialog',
      payload: { selector: '#a' },
    });
    saveFlow({
      origin: 'http://x',
      title: 'My App',
      name: 'login',
      description: 'logs in',
      steps: STEPS,
    });

    const out = runMapCommand(['show', 'my-app']);
    expect(out).toMatch(/my-app/);
    expect(out).toMatch(/http:\/\/x/);
    expect(out).toMatch(/open dialog/);
    expect(out).toMatch(/#a/);
    expect(out).toMatch(/login \(2 steps, used 0×\) — logs in/);
  });

  test('resolves by canonicalized origin', () => {
    saveEntry({
      origin: 'https://myapp.example.com',
      title: 'My App',
      url_pattern: '/a',
      kind: 'gotcha',
      purpose: 'p',
      payload: { body: 'x' },
    });
    const out = runMapCommand(['show', 'https://myapp.example.com/']);
    expect(out).toMatch(/my-app/);
  });

  test('shows verified vs failed status on entries', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    const out = runMapCommand(['show', 'my-app']);
    expect(out).toMatch(/\(verified\)/);
  });

  test('prints app-level and entry-level notes when present', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
      notes: 'flaky on first load',
    });
    upsertApp({ origin: 'http://x', app_key: 'my-app', notes: 'internal tool, no public URL' });

    const out = runMapCommand(['show', 'my-app']);
    expect(out).toMatch(/notes: internal tool, no public URL/);
    expect(out).toMatch(/notes: flaky on first load/);
  });

  test('omits the notes line entirely when neither app nor entry has notes', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });

    const out = runMapCommand(['show', 'my-app']);
    expect(out).not.toMatch(/notes:/);
  });

  test('not found lists available app_keys', () => {
    upsertApp({ origin: 'http://x', title: 'Known App' });
    expect(() => runMapCommand(['show', 'nope'])).toThrowError(/known-app/);
  });

  test('not found on an empty map says the map is empty', () => {
    expect(() => runMapCommand(['show', 'nope'])).toThrowError(/map is empty/);
  });

  test('missing argument throws a usage error', () => {
    expect(() => runMapCommand(['show'])).toThrowError(/Usage/);
  });
});

describe('map forget', () => {
  test('without --yes prints a dry run and deletes nothing', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    const out = runMapCommand(['forget', 'my-app']);
    expect(out).toMatch(/This would delete app "my-app"/);
    expect(out).toMatch(/--yes/);
    expect(listApps()).toHaveLength(1);
  });

  test('with --yes deletes the app and its entries', () => {
    const { app } = saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    const out = runMapCommand(['forget', 'my-app', '--yes']);
    expect(out).toMatch(/Deleted app "my-app"/);
    expect(listApps().find((a) => a.id === app.id)).toBeUndefined();
  });

  test('--flow <name> deletes just that flow, no --yes required when unambiguous', () => {
    const { app } = saveFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS });
    saveFlow({ origin: 'http://x', title: 'My App', name: 'logout', steps: STEPS });

    const out = runMapCommand(['forget', 'my-app', '--flow', 'login']);
    expect(out).toMatch(/Deleted flow "login"/);
    // The message names the resolved origin so a wrong resolution is visible.
    expect(out).toMatch(/http:\/\/x/);
    const remaining = listFlows(app.id).map((f) => f.name);
    expect(remaining).toEqual(['logout']);
    // The app itself and its other flow survive.
    expect(listApps()).toHaveLength(1);
  });

  test('--flow with an unknown name throws, naming the resolved origin', () => {
    saveFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS });
    expect(() => runMapCommand(['forget', 'my-app', '--flow', 'nope'])).toThrowError(
      /No flow named "nope" on app "my-app" \(http:\/\/x\)/,
    );
  });

  test('unknown app throws a helpful error', () => {
    expect(() => runMapCommand(['forget', 'nope', '--yes'])).toThrowError(/map is empty/);
  });

  test('--flow with no value throws a usage error instead of widening to a whole-app dry run', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    expect(() => runMapCommand(['forget', 'my-app', '--flow'])).toThrowError(
      /--flow requires a flow name/,
    );
    // Nothing was deleted, and the whole-app dry-run text never printed —
    // there's nothing to assert it against since the call throws, but the
    // app must still be intact.
    expect(listApps()).toHaveLength(1);
  });

  test('--flow with no value followed by another flag still throws (does not swallow --yes as the value)', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    expect(() => runMapCommand(['forget', 'my-app', '--flow', '--yes'])).toThrowError(
      /--flow requires a flow name/,
    );
    expect(listApps()).toHaveLength(1);
  });

  test('--flow <name> still works after the fix (regression guard)', () => {
    saveFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS });
    const out = runMapCommand(['forget', 'my-app', '--flow', 'login']);
    expect(out).toMatch(/Deleted flow "login"/);
  });

  test('--yes before the positional works the same as after it', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    const out = runMapCommand(['forget', '--yes', 'my-app']);
    expect(out).toMatch(/Deleted app "my-app"/);
    expect(listApps()).toHaveLength(0);
  });
});

describe('map forget --flow on an ambiguous app_key (same key, two origins)', () => {
  /** The reviewer's repro: two DIFFERENT apps share the app_key "shared";
   * http://b is seen more recently, so the identifier "shared" resolves
   * there. Deleting a flow through that silent resolution used to hit the
   * wrong origin with no confirmation and no origin in the output. */
  function seedAmbiguous(): void {
    saveFlow({ origin: 'http://a', app_key: 'shared', name: 'login', steps: STEPS });
    saveFlow({ origin: 'http://b', app_key: 'shared', name: 'login', steps: STEPS });
  }

  function flowCount(origin: string): number {
    const app = listApps().find((a) => a.origin === origin);
    return app ? listFlows(app.id).length : 0;
  }

  test('without --yes prints a dry run naming the resolved origin and deletes nothing', () => {
    seedAmbiguous();
    const out = runMapCommand(['forget', 'shared', '--flow', 'login']);
    expect(out).toMatch(/matches 2 apps/);
    expect(out).toMatch(/"shared" \(http:\/\/b\)/); // resolved target, visible
    expect(out).toMatch(/--yes/);
    expect(flowCount('http://a')).toBe(1);
    expect(flowCount('http://b')).toBe(1);
  });

  test('with --yes deletes only from the resolved origin and names it', () => {
    seedAmbiguous();
    const out = runMapCommand(['forget', 'shared', '--flow', 'login', '--yes']);
    expect(out).toMatch(/Deleted flow "login" from "shared" \(http:\/\/b\)/);
    expect(flowCount('http://a')).toBe(1);
    expect(flowCount('http://b')).toBe(0);
  });

  test('an origin identifier disambiguates without needing --yes', () => {
    seedAmbiguous();
    const out = runMapCommand(['forget', 'http://a', '--flow', 'login']);
    expect(out).toMatch(/Deleted flow "login" from "shared" \(http:\/\/a\)/);
    expect(flowCount('http://a')).toBe(0);
    expect(flowCount('http://b')).toBe(1);
  });
});

describe('map export / import round trip', () => {
  function seedApp(): void {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'open dialog',
      payload: { selector: '#a' },
    });
    saveFlow({
      origin: 'http://x',
      title: 'My App',
      name: 'login',
      description: 'logs in',
      steps: STEPS,
    });
  }

  test('export to stdout produces parseable JSON with a version field', () => {
    seedApp();
    const out = runMapCommand(['export']);
    const parsed = JSON.parse(out) as { browser_link_map_export: number; apps: unknown[] };
    expect(parsed.browser_link_map_export).toBe(1);
    expect(parsed.apps).toHaveLength(1);
  });

  test('export <app> filters to one app', () => {
    seedApp();
    saveEntry({
      origin: 'http://y',
      title: 'Other',
      url_pattern: '/b',
      kind: 'gotcha',
      purpose: 'p',
      payload: { body: 'x' },
    });
    const parsed = JSON.parse(runMapCommand(['export', 'my-app'])) as {
      apps: { app_key: string }[];
    };
    expect(parsed.apps).toHaveLength(1);
    expect(parsed.apps[0]?.app_key).toBe('my-app');
  });

  test('export --out writes the file and prints a privacy reminder', () => {
    seedApp();
    const outFile = join(dataDir, 'export.json');
    const out = runMapCommand(['export', '--out', outFile]);
    expect(out).toMatch(/Wrote 1 app/);
    expect(out).toMatch(/review it before sharing/);
    const written = JSON.parse(readFileSync(outFile, 'utf8')) as { apps: unknown[] };
    expect(written.apps).toHaveLength(1);
  });

  test('merge import round-trips entries and flows into a fresh map', () => {
    seedApp();
    const exported = runMapCommand(['export']);
    closeDb();

    // Fresh DB.
    const freshDir = mkdtempSync(join(tmpdir(), 'browser-link-map-cmd-fresh-'));
    process.env.BROWSER_LINK_DATA_DIR = freshDir;
    try {
      const file = join(freshDir, 'in.json');
      writeFileSync(file, exported, 'utf8');
      const summary = runMapCommand(['import', file]);
      expect(summary).toMatch(/Imported 1 app/);
      expect(summary).toMatch(/1 entry/);
      expect(summary).toMatch(/1 flow/);

      const apps = listApps();
      expect(apps).toHaveLength(1);
      expect(listEntries(apps[0]!.id)).toHaveLength(1);
      expect(listFlows(apps[0]!.id)).toHaveLength(1);
    } finally {
      closeDb();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test('merge import skips an exact-duplicate entry on re-import', () => {
    seedApp();
    const exported = runMapCommand(['export']);
    const file = join(dataDir, 'roundtrip.json');
    writeFileSync(file, exported, 'utf8');

    const summary = runMapCommand(['import', file]);
    expect(summary).toMatch(/1 duplicate skipped/);

    const apps = listApps();
    expect(listEntries(apps[0]!.id)).toHaveLength(1);
  });

  test('merge import overwrites an entry that shares (url_pattern, kind, purpose) but not the payload', () => {
    seedApp();
    const exported = JSON.parse(runMapCommand(['export'])) as {
      apps: {
        entries: { url_pattern: string; kind: string; purpose: string; payload: unknown }[];
      }[];
    };
    // Same identity key (url_pattern/kind/purpose) as seedApp's entry, but a
    // different payload — this must overwrite in place, not skip as a
    // duplicate and not append a second row.
    const entry = exported.apps[0]!.entries[0]!;
    expect(entry.url_pattern).toBe('/a');
    entry.payload = { selector: '#a-updated' };

    const file = join(dataDir, 'overwrite.json');
    writeFileSync(file, JSON.stringify(exported), 'utf8');

    const summary = runMapCommand(['import', file]);
    expect(summary).toMatch(/Imported 1 app.*1 entry/);
    expect(summary).not.toMatch(/duplicate skipped/);

    const apps = listApps();
    const entries = listEntries(apps[0]!.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({ selector: '#a-updated' });
  });

  test("--replace wipes the app's existing data before importing fresh", () => {
    seedApp();
    const exported = runMapCommand(['export']);

    // Mutate the live map so replace has something to blow away.
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/stale',
      kind: 'gotcha',
      purpose: 'stale note',
      payload: { body: 'old' },
    });
    const apps = listApps();
    expect(listEntries(apps[0]!.id)).toHaveLength(2);

    const file = join(dataDir, 'replace.json');
    writeFileSync(file, exported, 'utf8');
    const summary = runMapCommand(['import', file, '--replace']);
    expect(summary).toMatch(/1 replaced/);

    const after = listApps();
    expect(after).toHaveLength(1);
    // Only the entry from the export survives — the stale one is gone.
    expect(listEntries(after[0]!.id)).toHaveLength(1);
  });

  test('import aborts and writes nothing when a flow fails validation', () => {
    const badExport = {
      browser_link_map_export: 1,
      exported_at: new Date().toISOString(),
      apps: [
        {
          origin: 'http://x',
          app_key: 'my-app',
          title: 'My App',
          notes: null,
          entries: [],
          flows: [{ name: 'broken', description: null, steps: [], use_count: 0 }],
        },
      ],
    };
    const file = join(dataDir, 'bad.json');
    writeFileSync(file, JSON.stringify(badExport), 'utf8');

    expect(() => runMapCommand(['import', file])).toThrowError(/Import aborted/);
    expect(listApps()).toHaveLength(0);
  });

  test('import rejects a file missing the version/apps marker', () => {
    const file = join(dataDir, 'not-an-export.json');
    writeFileSync(file, JSON.stringify({ hello: 'world' }), 'utf8');
    expect(() => runMapCommand(['import', file])).toThrowError(/not a browser-link map export/);
  });

  test('import of a missing file throws a clear error', () => {
    expect(() => runMapCommand(['import', join(dataDir, 'does-not-exist.json')])).toThrowError(
      /Could not read/,
    );
  });

  test('--replace before the file positional works the same as after it', () => {
    seedApp();
    const exported = runMapCommand(['export']);
    const file = join(dataDir, 'flag-first.json');
    writeFileSync(file, exported, 'utf8');
    const summary = runMapCommand(['import', '--replace', file]);
    expect(summary).toMatch(/1 replaced/);
  });
});

describe('import restore fidelity (verified_at / failed_at / use_count)', () => {
  test('a FAILED entry stays failed through an export → fresh-DB import round trip', () => {
    const { entry } = saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    recordUse({ entry_id: entry.id, ok: false });
    const before = listEntries(entry.app_id)[0]!;
    expect(before.failed_at).toBeTruthy();

    const exported = runMapCommand(['export']);
    closeDb();

    const freshDir = mkdtempSync(join(tmpdir(), 'browser-link-map-cmd-fidelity-'));
    process.env.BROWSER_LINK_DATA_DIR = freshDir;
    try {
      const file = join(freshDir, 'in.json');
      writeFileSync(file, exported, 'utf8');
      runMapCommand(['import', file]);

      const restored = listEntries(listApps()[0]!.id)[0]!;
      // The track record survives — import must NOT re-stamp verified_at
      // or clear failed_at the way a live browser.map.save does.
      expect(restored.failed_at).toBe(before.failed_at);
      expect(restored.verified_at).toBe(before.verified_at);
    } finally {
      closeDb();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test('a flow use_count survives an export → fresh-DB import round trip', () => {
    restoreFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS, use_count: 5 });
    const exported = runMapCommand(['export']);
    closeDb();

    const freshDir = mkdtempSync(join(tmpdir(), 'browser-link-map-cmd-usecount-'));
    process.env.BROWSER_LINK_DATA_DIR = freshDir;
    try {
      const file = join(freshDir, 'in.json');
      writeFileSync(file, exported, 'utf8');
      runMapCommand(['import', file]);

      const flows = listFlows(listApps()[0]!.id);
      expect(flows[0]?.use_count).toBe(5);
    } finally {
      closeDb();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test('a merge import never lowers a locally-earned use_count', () => {
    restoreFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS, use_count: 5 });
    const importFile = {
      browser_link_map_export: 1,
      exported_at: new Date().toISOString(),
      apps: [
        {
          origin: 'http://x',
          app_key: 'my-app',
          title: 'My App',
          notes: null,
          entries: [],
          flows: [{ name: 'login', description: null, steps: STEPS, use_count: 2 }],
        },
      ],
    };
    const file = join(dataDir, 'lower.json');
    writeFileSync(file, JSON.stringify(importFile), 'utf8');
    runMapCommand(['import', file]);

    expect(listFlows(listApps()[0]!.id)[0]?.use_count).toBe(5);
  });
});

describe('import pre-write validation (clean aggregated abort, never a SqliteError)', () => {
  function writeImportFile(apps: unknown[]): string {
    const file = join(dataDir, 'validate.json');
    writeFileSync(
      file,
      JSON.stringify({
        browser_link_map_export: 1,
        exported_at: new Date().toISOString(),
        apps,
      }),
      'utf8',
    );
    return file;
  }

  test('a flow missing its name aborts cleanly with nothing written', () => {
    const file = writeImportFile([
      {
        origin: 'http://x',
        app_key: 'my-app',
        title: null,
        notes: null,
        entries: [],
        flows: [{ description: null, steps: STEPS, use_count: 0 }],
      },
    ]);
    expect(() => runMapCommand(['import', file])).toThrowError(
      /Import aborted[\s\S]*name must be a non-empty string/,
    );
    expect(listApps()).toHaveLength(0);
  });

  test('an entry with an invalid kind aborts cleanly with nothing written', () => {
    const file = writeImportFile([
      {
        origin: 'http://x',
        app_key: 'my-app',
        title: null,
        notes: null,
        entries: [{ url_pattern: '/a', kind: 'bogus', purpose: 'p', payload: { selector: '#a' } }],
        flows: [],
      },
    ]);
    expect(() => runMapCommand(['import', file])).toThrowError(
      /Import aborted[\s\S]*kind must be one of selector \| flow \| gotcha/,
    );
    expect(listApps()).toHaveLength(0);
  });

  test('an entry missing url_pattern / purpose / payload aborts with one error per problem', () => {
    const file = writeImportFile([
      {
        origin: 'http://x',
        app_key: 'my-app',
        title: null,
        notes: null,
        entries: [{ kind: 'selector' }],
        flows: [],
      },
    ]);
    expect(() => runMapCommand(['import', file])).toThrowError(
      /url_pattern must be a non-empty string[\s\S]*purpose must be a non-empty string[\s\S]*payload is required/,
    );
    expect(listApps()).toHaveLength(0);
  });

  test('a newer export version is rejected with a clean unsupported-version error', () => {
    const file = join(dataDir, 'newer.json');
    writeFileSync(
      file,
      JSON.stringify({ browser_link_map_export: 2, exported_at: '', apps: [] }),
      'utf8',
    );
    expect(() => runMapCommand(['import', file])).toThrowError(
      /Unsupported export version 2 \(this binary supports up to 1\)/,
    );
  });

  test('an oversized payload trips the 1 MiB sanity cap', () => {
    const file = writeImportFile([
      {
        origin: 'http://x',
        app_key: 'my-app',
        title: null,
        notes: null,
        entries: [
          {
            url_pattern: '/a',
            kind: 'gotcha',
            purpose: 'p',
            payload: { body: 'x'.repeat(1_048_577) },
          },
        ],
        flows: [],
      },
    ]);
    expect(() => runMapCommand(['import', file])).toThrowError(/payload exceeds 1048576 bytes/);
    expect(listApps()).toHaveLength(0);
  });

  test('too many flows in one file trips the per-file cap', () => {
    const flows = Array.from({ length: 1_001 }, (_, i) => ({
      name: `flow-${i}`,
      description: null,
      steps: STEPS,
      use_count: 0,
    }));
    const file = writeImportFile([
      { origin: 'http://x', app_key: 'my-app', title: null, notes: null, entries: [], flows },
    ]);
    expect(() => runMapCommand(['import', file])).toThrowError(/too many flows.*1001.*max 1000/);
    expect(listApps()).toHaveLength(0);
  });

  test('too many apps in one file trips the per-file cap', () => {
    const apps = Array.from({ length: 501 }, (_, i) => ({
      origin: `http://app-${i}.example`,
      app_key: `app-${i}`,
      title: null,
      notes: null,
      entries: [],
      flows: [],
    }));
    const file = writeImportFile(apps);
    expect(() => runMapCommand(['import', file])).toThrowError(/too many apps.*501.*max 500/);
    expect(listApps()).toHaveLength(0);
  });
});

describe('map export --out failure', () => {
  test('an unwritable path produces a friendly error, not a raw ENOENT throw', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    const badPath = join(dataDir, 'no-such-dir', 'deep', 'export.json');
    expect(() => runMapCommand(['export', '--out', badPath])).toThrowError(/Could not write/);
  });
});

describe('unknown map action', () => {
  test('throws a helpful error naming the valid actions', () => {
    expect(() => runMapCommand(['bogus'])).toThrowError(/Unknown map action/);
  });
});

describe('es locale', () => {
  test('uses Spanish labels for ls empty state and forget dry run', () => {
    expect(runMapCommand(['ls'], 'es')).toMatch(/Todavía no hay apps/);

    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    const out = runMapCommand(['forget', 'my-app'], 'es');
    expect(out).toMatch(/Esto eliminaría la app "my-app"/);
  });

  test('"--flow" with no value throws the Spanish usage error', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    expect(() => runMapCommand(['forget', 'my-app', '--flow'], 'es')).toThrowError(
      /--flow requiere un nombre de flow/,
    );
    expect(listApps()).toHaveLength(1);
  });

  test('"map show" prints notes under the Spanish "notas:" label', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
      notes: 'se rompe en el primer load',
    });
    const out = runMapCommand(['show', 'my-app'], 'es');
    expect(out).toMatch(/notas: se rompe en el primer load/);
  });
});

describe('formatRelative', () => {
  const NOW = new Date('2024-06-15T12:00:00.000Z').getTime();
  const ago = (offsetSec: number): string => new Date(NOW - offsetSec * 1_000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('under 10 seconds reads as "just now" / "justo ahora"', () => {
    expect(formatRelative(ago(5), 'en')).toBe('just now');
    expect(formatRelative(ago(5), 'es')).toBe('justo ahora');
  });

  test('seconds branch', () => {
    expect(formatRelative(ago(30), 'en')).toBe('30 seconds ago');
    expect(formatRelative(ago(30), 'es')).toBe('hace 30 segundos');
  });

  test('minutes branch, singular and plural', () => {
    expect(formatRelative(ago(65), 'en')).toBe('1 minute ago');
    expect(formatRelative(ago(65), 'es')).toBe('hace 1 minuto');
    expect(formatRelative(ago(5 * 60), 'en')).toBe('5 minutes ago');
    expect(formatRelative(ago(5 * 60), 'es')).toBe('hace 5 minutos');
  });

  test('hours branch, singular and plural', () => {
    expect(formatRelative(ago(3_700), 'en')).toBe('1 hour ago');
    expect(formatRelative(ago(3_700), 'es')).toBe('hace 1 hora');
    expect(formatRelative(ago(3 * 3_600), 'en')).toBe('3 hours ago');
    expect(formatRelative(ago(3 * 3_600), 'es')).toBe('hace 3 horas');
  });

  test('days branch, singular and plural (irregular Spanish plural "día"/"días")', () => {
    expect(formatRelative(ago(90_000), 'en')).toBe('1 day ago');
    expect(formatRelative(ago(90_000), 'es')).toBe('hace 1 día');
    expect(formatRelative(ago(2 * 86_400), 'en')).toBe('2 days ago');
    expect(formatRelative(ago(2 * 86_400), 'es')).toBe('hace 2 días');
  });

  test('months branch, singular and plural (irregular Spanish plural "mes"/"meses")', () => {
    expect(formatRelative(ago(2_600_000), 'en')).toBe('1 month ago');
    expect(formatRelative(ago(2_600_000), 'es')).toBe('hace 1 mes');
    expect(formatRelative(ago(2 * 2_592_000), 'en')).toBe('2 months ago');
    expect(formatRelative(ago(2 * 2_592_000), 'es')).toBe('hace 2 meses');
  });

  test('years branch, singular and plural (irregular Spanish plural "año"/"años")', () => {
    expect(formatRelative(ago(31_600_000), 'en')).toBe('1 year ago');
    expect(formatRelative(ago(31_600_000), 'es')).toBe('hace 1 año');
    expect(formatRelative(ago(2 * 31_536_000), 'en')).toBe('2 years ago');
    expect(formatRelative(ago(2 * 31_536_000), 'es')).toBe('hace 2 años');
  });

  test('an unparsable date falls back to the raw string instead of throwing', () => {
    expect(formatRelative('not-a-date', 'en')).toBe('not-a-date');
    expect(formatRelative('not-a-date', 'es')).toBe('not-a-date');
  });
});

describe('plural i18n branches (n > 1)', () => {
  function seedTwoAppsWithEntriesAndFlows(): void {
    for (const i of [1, 2]) {
      saveEntry({
        origin: `http://app-${i}`,
        title: `App ${i}`,
        url_pattern: '/a',
        kind: 'selector',
        purpose: 'p',
        payload: { selector: '#a' },
      });
      saveFlow({ origin: `http://app-${i}`, title: `App ${i}`, name: 'login', steps: STEPS });
    }
  }

  test('exportWritten uses the plural form (English and Spanish) for more than one app', () => {
    seedTwoAppsWithEntriesAndFlows();
    const outFile = join(dataDir, 'export-plural.json');

    const en = runMapCommand(['export', '--out', outFile], 'en');
    expect(en).toMatch(/Wrote 2 apps to/);

    const es = runMapCommand(['export', '--out', outFile], 'es');
    expect(es).toMatch(/Se escribieron 2 apps en/);
  });

  test('importSummary uses plural forms (English and Spanish) for more than one app/entry/flow', () => {
    seedTwoAppsWithEntriesAndFlows();
    const exported = runMapCommand(['export']);
    closeDb();

    const freshDir = mkdtempSync(join(tmpdir(), 'browser-link-map-cmd-plural-'));
    process.env.BROWSER_LINK_DATA_DIR = freshDir;
    try {
      const file = join(freshDir, 'in.json');
      writeFileSync(file, exported, 'utf8');
      const enSummary = runMapCommand(['import', file], 'en');
      expect(enSummary).toMatch(/Imported 2 apps, 2 entries, 2 flows\./);
    } finally {
      closeDb();
      rmSync(freshDir, { recursive: true, force: true });
    }

    const freshDirEs = mkdtempSync(join(tmpdir(), 'browser-link-map-cmd-plural-es-'));
    process.env.BROWSER_LINK_DATA_DIR = freshDirEs;
    try {
      const file = join(freshDirEs, 'in.json');
      writeFileSync(file, exported, 'utf8');
      const esSummary = runMapCommand(['import', file], 'es');
      expect(esSummary).toMatch(/Se importaron 2 apps, 2 entradas, 2 flows\./);
    } finally {
      closeDb();
      rmSync(freshDirEs, { recursive: true, force: true });
    }
  });

  test('importSummary reports plural "replaced" and "duplicate skipped" counts', () => {
    seedTwoAppsWithEntriesAndFlows();
    const exported = runMapCommand(['export']);
    const file = join(dataDir, 'reimport.json');
    writeFileSync(file, exported, 'utf8');

    // Re-import over the live map: --replace touches both apps (2 replaced),
    // duplicate entries are skipped (2 duplicates).
    const replaceSummary = runMapCommand(['import', file, '--replace'], 'en');
    expect(replaceSummary).toMatch(/\(2 replaced\)/);

    const dupSummary = runMapCommand(['import', file], 'en');
    expect(dupSummary).toMatch(/\(2 duplicate skipped\)/);

    const dupSummaryEs = runMapCommand(['import', file], 'es');
    expect(dupSummaryEs).toMatch(/\(2 duplicadas omitidas\)/);
  });
});
