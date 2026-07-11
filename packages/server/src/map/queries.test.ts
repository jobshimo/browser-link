import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './db.js';
import {
  forget,
  getMapHint,
  listApps,
  listFlows,
  recall,
  recordUse,
  renameApp,
  saveEntry,
  saveFlow,
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

describe('saveFlow, listFlows and recall', () => {
  const STEPS = [{ find: { text: '<QUERY>', role: 'textbox' } }, { click: {} }];

  test('save + listFlows round-trips steps as a parsed array', () => {
    const { flow } = saveFlow({
      origin: 'http://x',
      title: 'My App',
      name: 'open search',
      description: 'Opens the search box and focuses it',
      steps: STEPS,
    });
    expect(flow.steps).toEqual(STEPS);
    expect(flow.use_count).toBe(0);

    const flows = listFlows(flow.app_id);
    expect(flows).toHaveLength(1);
    expect(flows[0]?.name).toBe('open search');
  });

  test('save is an upsert keyed by (app, name) — steps/description replaced, use_count untouched', () => {
    const first = saveFlow({ origin: 'http://x', name: 'login', steps: STEPS });
    const second = saveFlow({
      origin: 'http://x',
      name: 'login',
      description: 'updated',
      steps: [{ click: { selector: '#new' } }],
    });
    expect(second.flow.id).toBe(first.flow.id);
    expect(second.flow.description).toBe('updated');
    expect(second.flow.steps).toEqual([{ click: { selector: '#new' } }]);
    expect(listFlows(first.flow.app_id)).toHaveLength(1);
  });

  test('two different names for the same app both persist', () => {
    const { flow: a } = saveFlow({ origin: 'http://x', name: 'flow a', steps: STEPS });
    saveFlow({ origin: 'http://x', name: 'flow b', steps: STEPS });
    expect(
      listFlows(a.app_id)
        .map((f) => f.name)
        .sort(),
    ).toEqual(['flow a', 'flow b']);
  });

  test('recall returns saved flows alongside entries for the app', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/search',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
    saveFlow({ origin: 'http://x', title: 'My App', name: 'open search', steps: STEPS });

    const recalled = recall({ origin: 'http://x' });
    expect(recalled.entries).toHaveLength(1);
    expect(recalled.flows).toHaveLength(1);
    expect(recalled.flows[0]?.name).toBe('open search');
    expect(recalled.flows[0]?.steps).toEqual(STEPS);
  });

  test('recall returns an empty flows array when the app has none', () => {
    upsertApp({ origin: 'http://x', title: 'My App' });
    const recalled = recall({ origin: 'http://x' });
    expect(recalled.flows).toEqual([]);
  });

  test('recall on an unknown origin returns flows: []', () => {
    const recalled = recall({ origin: 'http://does-not-exist' });
    expect(recalled).toEqual({ app: null, entries: [], flows: [] });
  });
});

describe('getMapHint', () => {
  const STEPS = [{ find: { text: '<QUERY>', role: 'textbox' } }, { click: {} }];

  test('returns null for an origin with no app', () => {
    expect(getMapHint('http://does-not-exist')).toBeNull();
  });

  test('returns null for an origin with an app but zero entries and zero flows', () => {
    upsertApp({ origin: 'http://x', title: 'My App' });
    expect(getMapHint('http://x')).toBeNull();
  });

  test('returns app_key + counts when the app has entries', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/search',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
    expect(getMapHint('http://x')).toEqual({ app_key: 'my-app', entries: 1, flows: 0 });
  });

  test('returns app_key + counts when the app has flows', () => {
    saveFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS });
    expect(getMapHint('http://x')).toEqual({ app_key: 'my-app', entries: 0, flows: 1 });
  });

  test('counts both entries and flows together', () => {
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/search',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
    saveFlow({ origin: 'http://x', title: 'My App', name: 'login', steps: STEPS });
    saveFlow({ origin: 'http://x', title: 'My App', name: 'logout', steps: STEPS });
    expect(getMapHint('http://x')).toEqual({ app_key: 'my-app', entries: 1, flows: 2 });
  });

  test('does not bump last_seen_at (unlike recall, listing tabs is passive)', () => {
    const app = upsertApp({ origin: 'http://x', title: 'My App' });
    saveEntry({
      origin: 'http://x',
      title: 'My App',
      url_pattern: '/search',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
    const before = listApps().find((a) => a.id === app.id)?.last_seen_at;
    getMapHint('http://x');
    const after = listApps().find((a) => a.id === app.id)?.last_seen_at;
    expect(after).toBe(before);
  });

  test('finds an app saved with a trailing-slash origin (write-path canonicalization)', () => {
    saveEntry({
      origin: 'https://myapp.example.com/',
      title: 'My App',
      url_pattern: '/search',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
    // Lookup key is what handleListTabs computes: new URL(tab.url).origin.
    expect(getMapHint('https://myapp.example.com')).toEqual({
      app_key: 'my-app',
      entries: 1,
      flows: 0,
    });
  });

  test('finds a canonical save when the lookup itself carries free text (defense in depth)', () => {
    saveEntry({
      origin: 'https://myapp.example.com',
      title: 'My App',
      url_pattern: '/search',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
    expect(getMapHint('https://myapp.example.com/some/path')).toEqual({
      app_key: 'my-app',
      entries: 1,
      flows: 0,
    });
  });
});

describe('origin canonicalization across save and recall', () => {
  test('a recall with a trailing-slash origin finds what a canonical save stored', () => {
    saveEntry({
      origin: 'https://myapp.example.com',
      title: 'My App',
      url_pattern: '/search',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
    const recalled = recall({ origin: 'https://myapp.example.com/' });
    expect(recalled.app?.app_key).toBe('my-app');
    expect(recalled.entries).toHaveLength(1);
  });

  test('saving the same app with and without a trailing slash upserts ONE app row', () => {
    upsertApp({ origin: 'https://myapp.example.com/', title: 'My App' });
    upsertApp({ origin: 'https://myapp.example.com', title: 'My App' });
    expect(listApps()).toHaveLength(1);
    expect(listApps()[0]?.origin).toBe('https://myapp.example.com');
  });
});
