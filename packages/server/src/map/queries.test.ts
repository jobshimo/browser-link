import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './db.js';
import {
  forget,
  listApps,
  recall,
  recordUse,
  renameApp,
  saveEntry,
  upsertApp,
} from './queries.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('upsertApp', () => {
  test('creates an app with a derived app_key from the title', () => {
    const app = upsertApp({ origin: 'http://localhost:3030', title: 'My App' });
    expect(app.origin).toBe('http://localhost:3030');
    expect(app.app_key).toBe('my-app');
  });

  test('falls back to the origin host when no title is provided', () => {
    const app = upsertApp({ origin: 'http://example.com' });
    expect(app.app_key).toBe('example-com');
  });

  test('does not duplicate when called twice with the same (origin, key)', () => {
    upsertApp({ origin: 'http://x', title: 'A' });
    upsertApp({ origin: 'http://x', title: 'A' });
    expect(listApps()).toHaveLength(1);
  });
});

describe('saveEntry and recall', () => {
  test('save + recall round-trips the payload as a parsed object', () => {
    const saved = saveEntry({
      origin: 'http://localhost:3030',
      title: 'My App',
      url_pattern: '/cga',
      kind: 'selector',
      purpose: 'open task detail',
      payload: { selector: 'div[aria-label]', evidence: 'snapshot' },
    });
    expect(saved.entry.payload).toEqual({
      selector: 'div[aria-label]',
      evidence: 'snapshot',
    });

    const recalled = recall({ origin: 'http://localhost:3030', url: 'http://x/cga' });
    expect(recalled.entries).toHaveLength(1);
    expect(recalled.entries[0]?.purpose).toBe('open task detail');
  });

  test('save is an upsert keyed by (app, url_pattern, kind, purpose)', () => {
    saveEntry({
      origin: 'http://localhost:3030',
      title: 'My App',
      url_pattern: '/cga',
      kind: 'selector',
      purpose: 'open task detail',
      payload: { selector: 'div.first' },
    });
    saveEntry({
      origin: 'http://localhost:3030',
      title: 'My App',
      url_pattern: '/cga',
      kind: 'selector',
      purpose: 'open task detail',
      payload: { selector: 'div.second' },
    });

    const { entries } = recall({ origin: 'http://localhost:3030' });
    expect(entries).toHaveLength(1);
    expect((entries[0]?.payload as { selector: string }).selector).toBe('div.second');
  });

  test('recall filters by pathname when a url is provided', () => {
    saveEntry({
      origin: 'http://localhost:3030',
      title: 'My App',
      url_pattern: '/cga',
      kind: 'gotcha',
      purpose: 'a',
      payload: { body: 'one' },
    });
    saveEntry({
      origin: 'http://localhost:3030',
      title: 'My App',
      url_pattern: '/realtime',
      kind: 'gotcha',
      purpose: 'b',
      payload: { body: 'two' },
    });

    const onlyCga = recall({ origin: 'http://localhost:3030', url: 'http://x/cga' });
    expect(onlyCga.entries.map((e) => e.url_pattern)).toEqual(['/cga']);
  });
});

describe('recordUse', () => {
  test('ok=true stamps verified_at and clears failed_at', () => {
    const { entry } = saveEntry({
      origin: 'http://x',
      title: 't',
      url_pattern: '/p',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: 'a' },
    });
    recordUse({ entry_id: entry.id, ok: false });
    const after = recordUse({ entry_id: entry.id, ok: true });
    expect(after?.verified_at).toBeTruthy();
    expect(after?.failed_at).toBeNull();
  });

  test('ok=false stamps failed_at and keeps the historical verified_at', () => {
    const { entry } = saveEntry({
      origin: 'http://x',
      title: 't',
      url_pattern: '/p',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: 'a' },
    });
    const verifiedBefore = recall({ origin: 'http://x' }).entries[0]?.verified_at;
    const after = recordUse({ entry_id: entry.id, ok: false });
    expect(after?.failed_at).toBeTruthy();
    expect(after?.verified_at).toBe(verifiedBefore);
  });
});

describe('forget', () => {
  test('deletes a single entry by id', () => {
    const { entry } = saveEntry({
      origin: 'http://x',
      title: 't',
      url_pattern: '/p',
      kind: 'gotcha',
      purpose: 'p',
      payload: { body: 'x' },
    });
    expect(forget({ entry_id: entry.id })).toEqual({ deleted_entries: 1, deleted_apps: 0 });
    expect(recall({ origin: 'http://x' }).entries).toHaveLength(0);
  });

  test('deleting an app cascades to its entries', () => {
    const a = saveEntry({
      origin: 'http://x',
      title: 't',
      url_pattern: '/p',
      kind: 'gotcha',
      purpose: 'p',
      payload: { body: 'x' },
    });
    const b = forget({ app_id: a.app.id });
    expect(b).toEqual({ deleted_entries: 1, deleted_apps: 1 });
    expect(listApps()).toHaveLength(0);
  });
});

describe('renameApp', () => {
  test('updates the app_key in place', () => {
    const a = upsertApp({ origin: 'http://x', title: 'Bad Key' });
    const renamed = renameApp(a.id, 'better-key');
    expect(renamed?.app_key).toBe('better-key');
  });
});
