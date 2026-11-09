import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from './db.js';
import {
  getMapHint,
  listApps,
  listLearned,
  recall,
  resolveLearnerApp,
  saveEntry,
  upsertApp,
} from './queries.js';
import { saveConfig } from '../config.js';
import {
  MAX_LEARNED_PER_APP,
  classifyOutcome,
  learnFromDispatch,
  recordOutcome,
} from './learning.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-learning-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const ORIGIN = 'https://app.example.com';

interface OutcomeRow {
  app_id: number;
  url_pattern: string;
  target: string;
  target_kind: string;
  action: string;
  ok_n: number;
  fail_n: number;
  last_reason: string | null;
  last_ok_at: string | null;
  last_fail_at: string | null;
}

function rows(): OutcomeRow[] {
  return getDb().prepare('SELECT * FROM selector_outcomes ORDER BY id').all() as OutcomeRow[];
}

describe('classifyOutcome — thrown errors', () => {
  const args = { tab_id: 't1', selector: '#save' };

  test('a retargeted click error fails with "retargeted"', () => {
    const error = new Error(
      'Click would land on div.wrap, not on #save: scroll or expand its container, or target the element that receives clicks; force: true clicks there anyway',
    );
    expect(classifyOutcome('browser.click', args, undefined, error)).toEqual({
      ok: false,
      reason: 'retargeted',
    });
  });

  test('a ref-stale error fails with "ref-stale"', () => {
    const error = new Error('ref-stale: abc:e1 not found in document abc');
    expect(classifyOutcome('browser.click', args, undefined, error)).toEqual({
      ok: false,
      reason: 'ref-stale',
    });
  });

  test('an unmet expectation fails with "expect-failed"', () => {
    const error = new Error('expectation not met: url_changed');
    expect(classifyOutcome('browser.type', args, undefined, error)).toEqual({
      ok: false,
      reason: 'expect-failed',
    });
  });

  test('a bridge timeout fails with "timeout"', () => {
    const error = new Error("Tool 'click' timed out after 15000ms");
    expect(classifyOutcome('browser.click', args, undefined, error)).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  test('an element-not-found error fails with "not-found"', () => {
    const error = new Error('Element not found: #save');
    expect(classifyOutcome('browser.click', args, undefined, error)).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  test('any other error teaches nothing', () => {
    const error = new Error('browser.click needs exactly one of selector or ref');
    expect(classifyOutcome('browser.click', args, undefined, error)).toBeNull();
  });
});

describe('classifyOutcome — resolved actions', () => {
  test('a click with an expect (so it was met) is ok', () => {
    const args = { tab_id: 't1', selector: '#save', expect: { url_changed: true } };
    expect(classifyOutcome('browser.click', args, { ok: true }, undefined)).toEqual({ ok: true });
  });

  test('a press whose settle saw mutations is ok', () => {
    const args = { tab_id: 't1', selector: '#q', key: 'Enter' };
    const result = { ok: true, settle: { settled: true, mutation_count: 3 } };
    expect(classifyOutcome('browser.press', args, result, undefined)).toEqual({ ok: true });
  });

  test('an unsettled action fails with "unsettled"', () => {
    const args = { tab_id: 't1', selector: '#q', text: 'secret' };
    const result = { ok: true, settle: { settled: false, mutation_count: 40 } };
    expect(classifyOutcome('browser.type', args, result, undefined)).toEqual({
      ok: false,
      reason: 'unsettled',
    });
  });

  test('a hit_element other than the target fails with "hit-mismatch"', () => {
    const args = { tab_id: 't1', selector: '#save' };
    const result = {
      ok: true,
      hit_element: 'div.overlay',
      settle: { settled: true, mutation_count: 2 },
    };
    expect(classifyOutcome('browser.click', args, result, undefined)).toEqual({
      ok: false,
      reason: 'hit-mismatch',
    });
  });

  test('a quiet click without expect teaches nothing (quiet is not effect)', () => {
    const args = { tab_id: 't1', selector: '#save' };
    const result = { ok: true, settle: { settled: true, mutation_count: 0 } };
    expect(classifyOutcome('browser.click', args, result, undefined)).toBeNull();
  });

  test('find with matched:false and reason not-found fails with "not-found"', () => {
    const args = { tab_id: 't1', key: { role: 'button', name: 'Save', path: [] } };
    expect(
      classifyOutcome('browser.find', args, { matched: false, reason: 'not-found' }, undefined),
    ).toEqual({ ok: false, reason: 'not-found' });
  });

  test('find with matched:false and reason multiple-matches fails with "multiple-matches"', () => {
    const args = { tab_id: 't1', key: { role: 'button', name: 'Save', path: [] } };
    expect(
      classifyOutcome(
        'browser.find',
        args,
        { matched: false, reason: 'multiple-matches' },
        undefined,
      ),
    ).toEqual({ ok: false, reason: 'multiple-matches' });
  });

  test('wait_for with matched:false fails with "unmatched"', () => {
    const args = { tab_id: 't1', selector: '.toast' };
    expect(
      classifyOutcome('browser.wait_for', args, { matched: false, reason: 'timeout' }, undefined),
    ).toEqual({ ok: false, reason: 'unmatched' });
  });

  test('an MCP { content } envelope is unwrapped before classifying', () => {
    const wrapped = {
      content: [{ type: 'text', text: JSON.stringify({ matched: false, reason: 'not-found' }) }],
    };
    expect(
      classifyOutcome(
        'browser.find',
        { key: { role: 'button', name: 'Go', path: [] } },
        wrapped,
        undefined,
      ),
    ).toEqual({ ok: false, reason: 'not-found' });
  });

  test('find / wait_for with matched:true is ok', () => {
    expect(
      classifyOutcome('browser.wait_for', { selector: '.toast' }, { matched: true }, undefined),
    ).toEqual({ ok: true });
  });
});

describe('classifyOutcome — nothing learnable', () => {
  test('a call that used only a ref learns nothing', () => {
    const error = new Error('ref-stale: abc:e1 not found in document abc');
    expect(classifyOutcome('browser.click', { ref: 'abc:e1' }, undefined, error)).toBeNull();
    expect(
      classifyOutcome('browser.find', { ref: 'abc:e1' }, { matched: false }, undefined),
    ).toBeNull();
  });

  test('find by text has no durable target', () => {
    expect(
      classifyOutcome('browser.find', { text: 'Save' }, { matched: false }, undefined),
    ).toBeNull();
  });

  test('tools outside click/type/press/find/wait_for learn nothing', () => {
    const error = new Error("Tool 'evaluate' timed out after 15000ms");
    expect(classifyOutcome('browser.evaluate', { expression: '1' }, undefined, error)).toBeNull();
    expect(
      classifyOutcome('browser.snapshot', { within_selector: '#x' }, undefined, error),
    ).toBeNull();
  });
});

describe('recordOutcome', () => {
  const base = {
    origin: ORIGIN,
    pathname: '/settings',
    target: '#save',
    target_kind: 'selector' as const,
    action: 'click',
  };

  test('upserts counters on one row per (app, url, target, kind, action)', () => {
    const db = getDb();
    recordOutcome(db, { ...base, outcome: { ok: true } });
    recordOutcome(db, { ...base, outcome: { ok: true } });
    recordOutcome(db, { ...base, outcome: { ok: false, reason: 'retargeted' } });
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      url_pattern: '/settings',
      target: '#save',
      target_kind: 'selector',
      action: 'click',
      ok_n: 2,
      fail_n: 1,
      last_reason: 'retargeted',
    });
    expect(all[0]!.last_ok_at).not.toBeNull();
    expect(all[0]!.last_fail_at).not.toBeNull();
  });

  test('lands in the same app browser.map.save resolves for origin + title', () => {
    const { app } = saveEntry({
      origin: ORIGIN,
      title: 'Example App',
      url_pattern: '/settings',
      kind: 'selector',
      purpose: 'save button',
      payload: { selector: '#save' },
    });
    recordOutcome(getDb(), { ...base, outcome: { ok: true } });
    expect(rows()[0]!.app_id).toBe(app.id);
  });

  test(`caps each app at ${MAX_LEARNED_PER_APP} rows, evicting the least used`, () => {
    const db = getDb();
    // One heavily used row that must survive, then fill the app to the cap.
    for (let i = 0; i < 5; i++) recordOutcome(db, { ...base, outcome: { ok: true } });
    for (let i = 1; i < MAX_LEARNED_PER_APP; i++) {
      recordOutcome(db, { ...base, target: `#t${i}`, outcome: { ok: true } });
    }
    // Every #tN except #t1 is used once; #t2 is the oldest of those, so it
    // is the eviction victim.
    recordOutcome(db, { ...base, target: '#t1', outcome: { ok: true } });
    expect(rows()).toHaveLength(MAX_LEARNED_PER_APP);
    recordOutcome(db, { ...base, target: '#new', outcome: { ok: false, reason: 'not-found' } });
    const targets = rows().map((r) => r.target);
    expect(targets).toHaveLength(MAX_LEARNED_PER_APP);
    expect(targets).toContain('#save');
    expect(targets).toContain('#t1');
    expect(targets).toContain('#new');
    expect(targets).not.toContain('#t2');
  });

  test('the cap is per app: another app is untouched', () => {
    const db = getDb();
    recordOutcome(db, { ...base, origin: 'https://other.example.com', outcome: { ok: true } });
    for (let i = 0; i < MAX_LEARNED_PER_APP + 3; i++) {
      recordOutcome(db, { ...base, target: `#t${i}`, outcome: { ok: true } });
    }
    const other = resolveLearnerApp(db, 'https://other.example.com');
    expect(rows().filter((r) => r.app_id === other.id)).toHaveLength(1);
  });
});

describe('listLearned', () => {
  test('failures first, then most used', () => {
    const db = getDb();
    const base = {
      origin: ORIGIN,
      title: 'Example App',
      pathname: '/',
      target_kind: 'selector' as const,
      action: 'click',
    };
    for (let i = 0; i < 3; i++) {
      recordOutcome(db, { ...base, target: '#busy', outcome: { ok: true } });
    }
    recordOutcome(db, { ...base, target: '#quiet', outcome: { ok: true } });
    recordOutcome(db, {
      ...base,
      target: '#broken',
      outcome: { ok: false, reason: 'hit-mismatch' },
    });
    const app = resolveLearnerApp(db, ORIGIN);
    expect(listLearned(db, app.id, 10).map((l) => l.target)).toEqual([
      '#broken',
      '#busy',
      '#quiet',
    ]);
    expect(listLearned(db, app.id, 2)).toHaveLength(2);
  });
});

describe('learnFromDispatch', () => {
  const ctx = {
    tool: 'browser.click',
    args: { tab_id: 't1', selector: '#save', expect: { url_changed: true } },
    result: { ok: true },
    error: undefined,
    url: `${ORIGIN}/settings?id=42`,
    title: 'Example App',
  };

  test('records the target with the pathname only (no query string)', () => {
    learnFromDispatch(ctx);
    expect(rows()).toEqual([
      expect.objectContaining({
        url_pattern: '/settings',
        target: '#save',
        action: 'click',
        ok_n: 1,
      }),
    ]);
  });

  test('stores the semantic key, never the typed text', () => {
    learnFromDispatch({
      ...ctx,
      tool: 'browser.find',
      args: { tab_id: 't1', key: { role: 'button', name: 'Save', path: ['main'] } },
      result: { matched: false, reason: 'not-found' },
    });
    learnFromDispatch({
      ...ctx,
      tool: 'browser.type',
      args: { tab_id: 't1', selector: '#pw', text: 'hunter2', expect: { url_changed: true } },
    });
    const all = rows();
    expect(all.map((r) => r.target_kind)).toEqual(['key', 'selector']);
    expect(JSON.parse(all[0]!.target)).toEqual({ role: 'button', name: 'Save', path: ['main'] });
    expect(JSON.stringify(all)).not.toContain('hunter2');
  });

  test('the map-learning switch off records nothing', () => {
    saveConfig({ mapLearningEnabled: false });
    learnFromDispatch(ctx);
    expect(rows()).toHaveLength(0);
  });

  test('a tab without a usable url records nothing', () => {
    learnFromDispatch({ ...ctx, url: null });
    learnFromDispatch({ ...ctx, url: 'not a url' });
    expect(rows()).toHaveLength(0);
  });
});

describe('learnFromDispatch — app resolution', () => {
  const click = (url: string, title: string | null): void => {
    learnFromDispatch({
      tool: 'browser.click',
      args: { tab_id: 't1', selector: '#compose', expect: { url_changed: true } },
      result: { ok: true },
      error: undefined,
      url,
      title,
    });
  };

  test('a changed tab title never creates an app nor hides the saved map', () => {
    saveEntry({
      origin: ORIGIN,
      app_key: 'myapp',
      title: 'My App',
      url_pattern: '/inbox',
      kind: 'selector',
      purpose: 'compose button',
      payload: { selector: '#compose' },
    });
    click(`${ORIGIN}/inbox`, 'Inbox (3) - My App');

    expect(listApps().map((a) => a.app_key)).toEqual(['myapp']);

    const hint = getMapHint(ORIGIN);
    expect(hint).toMatchObject({ app_key: 'myapp', entries: 1 });
    expect(hint?.inline?.entries).toEqual([
      {
        url_pattern: '/inbox',
        kind: 'selector',
        purpose: 'compose button',
        payload: { selector: '#compose' },
      },
    ]);
    expect(hint?.inline?.learned).toEqual([
      expect.objectContaining({ target: '#compose', action: 'click', ok_n: 1, fail_n: 0 }),
    ]);

    const recalled = recall({ origin: ORIGIN });
    expect(recalled.app?.app_key).toBe('myapp');
    expect(recalled.entries.map((e) => e.purpose)).toEqual(['compose button']);
    expect(recalled.learned?.map((l) => l.target)).toEqual(['#compose']);
  });

  test('an origin without an app gets one app keyed and titled by its host', () => {
    click(`${ORIGIN}/inbox`, 'Inbox (3) - My App');
    click(`${ORIGIN}/inbox`, 'Inbox (4) - My App');
    const apps = listApps();
    expect(apps.map((a) => ({ app_key: a.app_key, title: a.title }))).toEqual([
      { app_key: 'app-example-com', title: 'app.example.com' },
    ]);
    expect(rows()).toEqual([expect.objectContaining({ app_id: apps[0]!.id, ok_n: 2 })]);
    expect(JSON.stringify(apps)).not.toContain('Inbox');
  });

  test('learning leaves the resolved app untouched (last_seen_at and title)', () => {
    const app = upsertApp({ origin: ORIGIN, app_key: 'myapp', title: 'My App' });
    getDb()
      .prepare('UPDATE apps SET last_seen_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', app.id);
    const before = getDb().prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
    click(`${ORIGIN}/inbox`, 'Inbox (3) - My App');
    const after = getDb().prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
    expect(after).toEqual(before);
    expect(rows()).toEqual([expect.objectContaining({ app_id: app.id })]);
  });
});

describe('learnFromDispatch — press with a keyboard key', () => {
  test('a press carrying only a keyboard key learns nothing', () => {
    learnFromDispatch({
      tool: 'browser.press',
      args: { tab_id: 't1', key: 'Enter', expect: { url_changed: true } },
      result: { ok: true, settle: { settled: true, mutation_count: 4 } },
      error: undefined,
      url: `${ORIGIN}/search`,
      title: 'Example App',
    });
    expect(rows()).toHaveLength(0);
    expect(listApps()).toHaveLength(0);
  });
});

describe('learnFromDispatch — knowledge-loop keys and stamps', () => {
  const ctx = {
    tool: 'browser.click',
    args: { tab_id: 't1', selector: '#pay', expect: { url_changed: true } },
    result: { ok: true },
    error: undefined,
    url: `${ORIGIN}/facturas/48213`,
    title: null,
    build: 'b1',
    viewSig: 'v1',
  };
  const fail = (reason: string, build: string): void => {
    learnFromDispatch({
      ...ctx,
      build,
      args: { tab_id: 't1', selector: '#pay' },
      result: undefined,
      error: new Error(reason),
    });
  };
  const stamps = (): Record<string, unknown> =>
    getDb()
      .prepare(
        'SELECT url_pattern, view_sig, last_ok_build, last_fail_build, struct_fail_n, struct_fail_build FROM selector_outcomes',
      )
      .get() as Record<string, unknown>;

  test('records the path pattern, not the raw pathname', () => {
    learnFromDispatch(ctx);
    learnFromDispatch({ ...ctx, url: `${ORIGIN}/facturas/99/` });
    expect(rows()).toEqual([expect.objectContaining({ url_pattern: '/facturas/:id', ok_n: 2 })]);
  });

  test('stamps the view signature and the build of the last success', () => {
    learnFromDispatch(ctx);
    expect(stamps()).toEqual({
      url_pattern: '/facturas/:id',
      view_sig: 'v1',
      last_ok_build: 'b1',
      last_fail_build: null,
      struct_fail_n: 0,
      struct_fail_build: null,
    });
  });

  test('structural failures count per build and reset when the build changes or it works', () => {
    fail('Element not found: #pay', 'b1');
    fail('Element not found: #pay', 'b1');
    expect(stamps()).toMatchObject({
      last_fail_build: 'b1',
      struct_fail_n: 2,
      struct_fail_build: 'b1',
    });
    fail('Element not found: #pay', 'b2');
    expect(stamps()).toMatchObject({ struct_fail_n: 1, struct_fail_build: 'b2' });
    learnFromDispatch({ ...ctx, build: 'b2' });
    expect(stamps()).toMatchObject({ last_ok_build: 'b2', struct_fail_n: 0 });
  });

  test('situational failures stamp the build but never count as structural', () => {
    fail("Tool 'browser.click' timed out after 15000ms", 'b1');
    fail("Tool 'browser.click' timed out after 15000ms", 'b1');
    expect(stamps()).toMatchObject({ last_fail_build: 'b1', struct_fail_n: 0 });
  });

  test('a single expect-failed never counts as structural', () => {
    fail('expectation not met: url_changed', 'b1');
    expect(stamps()).toMatchObject({ last_fail_build: 'b1', struct_fail_n: 0 });
  });

  test('expect-failed counts toward the per-build counter only from its second occurrence', () => {
    fail('expectation not met: url_changed', 'b1');
    fail('expectation not met: url_changed', 'b1');
    expect(stamps()).toMatchObject({ struct_fail_n: 1, struct_fail_build: 'b1' });
    fail('expectation not met: url_changed', 'b1');
    expect(stamps()).toMatchObject({ struct_fail_n: 2, struct_fail_build: 'b1' });
  });

  test('one not-found plus one expect-failed on the same build is not failing', () => {
    fail('Element not found: #pay', 'b1');
    fail('expectation not met: url_changed', 'b1');
    expect(stamps()).toMatchObject({ struct_fail_n: 1, struct_fail_build: 'b1' });
  });

  test('an expect-failed repeated after another build does not count on the new build', () => {
    fail('expectation not met: url_changed', 'b1');
    fail('expectation not met: url_changed', 'b2');
    expect(stamps()).toMatchObject({ last_fail_build: 'b2', struct_fail_n: 0 });
  });

  test('browser.evaluate goes to the JS registry, gated by the learning switch', () => {
    const evaluate = {
      ...ctx,
      tool: 'browser.evaluate',
      args: { tab_id: 't1', expression: 'document.title' },
      result: { ok: true, value: 'x' },
    };
    learnFromDispatch(evaluate);
    const readers = (): number =>
      (getDb().prepare('SELECT COUNT(*) AS n FROM js_readers').get() as { n: number }).n;
    expect(readers()).toBe(1);
    expect(rows()).toHaveLength(0);
    saveConfig({ mapLearningEnabled: false });
    learnFromDispatch({ ...evaluate, args: { tab_id: 't1', expression: 'location.href' } });
    expect(readers()).toBe(1);
  });

  test('a throwing write is logged, never thrown', () => {
    getDb().exec('DROP TABLE selector_outcomes');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => learnFromDispatch(ctx)).not.toThrow();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('map learning failed for browser.click'),
    );
    spy.mockRestore();
  });
});
