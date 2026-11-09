import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { closeDb, getDb } from './db.js';
import { resolveLearnerApp } from './queries.js';
import { saveConfig } from '../config.js';
import {
  MAX_READERS_PER_APP,
  READER_FLAGS,
  analyzeExpression,
  clearTypedValues,
  listReaders,
  recordReaderFromDispatch,
  rememberTypedValue,
  rememberTypedValuesFromFlow,
  setReaderStatus,
  typedValues,
  upsertReader,
} from './readers.js';

/**
 * The `js_readers` DDL is owned by `map/db.ts`. Until its migration lands the
 * tests create the table with the agreed statement; the IF NOT EXISTS guard
 * makes this a no-op once the migration creates it.
 */
const JS_READERS_DDL = `
  CREATE TABLE IF NOT EXISTS js_readers (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE, hash TEXT NOT NULL, expression TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('reader','mutation')), name TEXT, ok_n INTEGER NOT NULL DEFAULT 0, fail_n INTEGER NOT NULL DEFAULT 0, last_ok_at TEXT, last_fail_at TEXT, last_ok_build TEXT, result_bytes_avg INTEGER, flags TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','kept','dropped')), created_at TEXT NOT NULL, UNIQUE(app_id, hash));
  CREATE INDEX IF NOT EXISTS idx_js_readers_app ON js_readers(app_id, status);
`;

let dataDir: string;

function db(): Database.Database {
  const handle = getDb();
  handle.exec(JS_READERS_DDL);
  return handle;
}

function appId(origin = 'https://app.example.com'): number {
  return resolveLearnerApp(db(), origin).id;
}

interface RawRow {
  expression: string;
  status: string;
  ok_n: number;
}

function allRows(): RawRow[] {
  return db()
    .prepare('SELECT expression, status, ok_n FROM js_readers ORDER BY id')
    .all() as RawRow[];
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-readers-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  clearTypedValues();
});

afterEach(() => {
  closeDb();
  clearTypedValues();
  vi.restoreAllMocks();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('analyzeExpression — kind', () => {
  test.each([
    ['document.title', 'reader'],
    ['[...document.querySelectorAll(".row")].map((r) => r.innerText)', 'reader'],
    ['const n = document.querySelectorAll("li").length; n', 'reader'],
    ['a.b == c && a.b === d && a.b != e && a.b !== f && a.b <= 1 && a.b >= 2', 'reader'],
    ['document.body.innerHTML.length', 'reader'],
    ['document.querySelector("#q").value = "x"', 'mutation'],
    ['el.style.color = "red"', 'mutation'],
    ['items[0] = 1', 'mutation'],
    ['counter.total += 1', 'mutation'],
    ['document.querySelector("button").click()', 'mutation'],
    ['el.dispatchEvent(new Event("input"))', 'mutation'],
    ['form.submit()', 'mutation'],
    ['input.focus()', 'mutation'],
    ['node.remove()', 'mutation'],
    ['el.setAttribute("x", "1")', 'mutation'],
    ['el.innerHTML = ""', 'mutation'],
    ['el.textContent = "hi"', 'mutation'],
    ['fetch("/api/items").then((r) => r.json())', 'mutation'],
    ['new XMLHttpRequest()', 'mutation'],
  ])('%s → %s', (expression, kind) => {
    expect(analyzeExpression(expression, []).kind).toBe(kind);
  });

  test('an assignment written inside a string literal does not make a mutation', () => {
    expect(analyzeExpression('document.title.includes("a.b = c")', []).kind).toBe('reader');
  });
});

describe('analyzeExpression — flags', () => {
  test('exports the flag vocabulary', () => {
    expect(READER_FLAGS).toEqual(['literal_data', 'secret_shape']);
  });

  test.each([
    ['document.title', []],
    ['document.querySelector("#total").innerText', []],
    ['document.querySelector("h1 span").innerText', ['literal_data']],
    ['[...document.links].filter((a) => a.href.includes("ana@example.com"))', ['literal_data']],
    ['document.body.innerText.includes("4821937")', ['literal_data']],
    ["document.body.innerText.includes('12345')", []],
    ['document.cookie', ['secret_shape']],
    ['localStorage.getItem("x")', ['secret_shape']],
    ['sessionStorage.length', ['secret_shape']],
    ['document.querySelector("[name=Password]").value', ['secret_shape']],
    ['window.__TOKEN__', ['secret_shape']],
    ['headers.Authorization', ['secret_shape']],
    ['"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc"', ['secret_shape']],
    ['x === "0123456789abcdef0123456789abcdef"', ['literal_data', 'secret_shape']],
  ])('%s → %j', (expression, flags) => {
    expect(analyzeExpression(expression, []).flags).toEqual(flags);
  });

  test('a literal equal to or containing a typed value is literal_data', () => {
    expect(analyzeExpression('document.body.innerText.includes("acme")', ['acme']).flags).toEqual([
      'literal_data',
    ]);
    expect(analyzeExpression('x.includes("Order-acme-7")', ['acme']).flags).toEqual([
      'literal_data',
    ]);
    expect(analyzeExpression('x.includes("other")', ['acme']).flags).toEqual([]);
  });
});

describe('typed values ring', () => {
  test('keeps the last 50 non-empty strings', () => {
    for (let i = 0; i < 60; i += 1) rememberTypedValue(`value-${i}`);
    rememberTypedValue('');
    rememberTypedValue(42);
    const values = typedValues();
    expect(values).toHaveLength(50);
    expect(values[0]).toBe('value-10');
    expect(values[49]).toBe('value-59');
  });

  test('collects `type` steps of a flow, including inside repeat', () => {
    rememberTypedValuesFromFlow({
      steps: [
        { type: { selector: '#q', text: 'shrek' } },
        { repeat: { max_iterations: 2, steps: [{ type: { text: 'donkey' } }] } },
        { click: { selector: '#go' } },
      ],
    });
    expect(typedValues()).toEqual(['shrek', 'donkey']);
  });
});

describe('upsertReader — registry', () => {
  test('identical expression is the same row; counters, stamps and average move', () => {
    const id = appId();
    const first = upsertReader(db(), {
      appId: id,
      expression: 'document.title',
      ok: true,
      build: 'b1',
      resultBytes: 10,
    });
    upsertReader(db(), { appId: id, expression: 'document.title', ok: true, resultBytes: 30 });
    const last = upsertReader(db(), { appId: id, expression: 'document.title', ok: false });
    expect(first?.id).toBe(last?.id);
    const rows = listReaders(db(), id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      expression: 'document.title',
      kind: 'reader',
      ok_n: 2,
      fail_n: 1,
      result_bytes_avg: 20,
      status: 'pending',
      name: null,
      flags: [],
    });
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.last_ok_at).not.toBeNull();
    expect(row?.last_fail_at).not.toBeNull();
    // The second ok call carried no build: the stamp records what was observed.
    expect(row?.last_ok_build).toBeNull();
  });

  test('a different expression is a different row, and apps are separate', () => {
    const a = appId('https://a.example.com');
    const b = appId('https://b.example.com');
    upsertReader(db(), { appId: a, expression: 'document.title', ok: true });
    upsertReader(db(), { appId: a, expression: 'location.pathname', ok: true });
    upsertReader(db(), { appId: b, expression: 'document.title', ok: true });
    expect(listReaders(db(), a)).toHaveLength(2);
    expect(listReaders(db(), b)).toHaveLength(1);
  });

  test('flags only grow on a later call, and the expression is never rewritten', () => {
    const id = appId();
    const expression = 'document.querySelector("h1").innerText';
    upsertReader(db(), { appId: id, expression, ok: true });
    db().prepare("UPDATE js_readers SET flags = 'literal_data' WHERE app_id = ?").run(id);
    upsertReader(db(), { appId: id, expression, ok: true });
    expect(listReaders(db(), id)[0]).toMatchObject({
      expression,
      ok_n: 2,
      flags: ['literal_data'],
    });
  });

  test('a secret-shaped expression is never stored', () => {
    const id = appId();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(upsertReader(db(), { appId: id, expression: 'document.cookie', ok: true })).toBeNull();
    expect(allRows()).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('an expression containing a typed value is never stored', () => {
    const id = appId();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = upsertReader(db(), {
      appId: id,
      expression: 'document.querySelector("#q").value === "hunter22"',
      ok: true,
      typedValues: ['hunter22'],
    });
    expect(out).toBeNull();
    expect(allRows()).toEqual([]);
  });

  test('listReaders filters by status; setReaderStatus changes status and name only', () => {
    const id = appId();
    const r = upsertReader(db(), { appId: id, expression: 'document.title', ok: true });
    upsertReader(db(), { appId: id, expression: 'location.href', ok: true });
    expect(setReaderStatus(db(), r!.id, 'kept', 'page-title')).toBe(true);
    expect(setReaderStatus(db(), 9999, 'kept')).toBe(false);
    expect(listReaders(db(), id, { status: 'kept' })).toEqual([
      expect.objectContaining({ expression: 'document.title', name: 'page-title', status: 'kept' }),
    ]);
    expect(listReaders(db(), id, { status: 'pending' })).toHaveLength(1);
  });
});

describe('upsertReader — static cap', () => {
  function fill(id: number, n: number, ok: boolean): void {
    const handle = db();
    for (let i = 0; i < n; i += 1) {
      upsertReader(handle, { appId: id, expression: `window.v${i}`, ok });
    }
  }

  test(`never exceeds ${MAX_READERS_PER_APP}: dropped rows go first`, () => {
    const id = appId();
    fill(id, MAX_READERS_PER_APP, false);
    const ids = listReaders(db(), id).map((r) => r.id);
    setReaderStatus(db(), ids[5]!, 'dropped');
    upsertReader(db(), { appId: id, expression: 'window.fresh', ok: true });
    const rows = allRows();
    expect(rows).toHaveLength(MAX_READERS_PER_APP);
    expect(rows.some((r) => r.status === 'dropped')).toBe(false);
    // The oldest pending row survived because a dropped row was available.
    expect(rows.map((r) => r.expression)).toContain('window.v0');
    expect(rows.map((r) => r.expression)).toContain('window.fresh');
  });

  test('then the oldest pending row that never worked; kept rows never', () => {
    const id = appId();
    fill(id, MAX_READERS_PER_APP, false);
    const ids = listReaders(db(), id).map((r) => r.id);
    setReaderStatus(db(), ids[0]!, 'kept', 'first');
    upsertReader(db(), { appId: id, expression: 'window.fresh', ok: true });
    const expressions = allRows().map((r) => r.expression);
    expect(expressions).toHaveLength(MAX_READERS_PER_APP);
    expect(expressions).toContain('window.v0');
    expect(expressions).not.toContain('window.v1');
    expect(expressions).toContain('window.fresh');
  });

  test('when nothing is evictable the new expression is not stored', () => {
    const id = appId();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fill(id, MAX_READERS_PER_APP, true);
    expect(upsertReader(db(), { appId: id, expression: 'window.fresh', ok: true })).toBeNull();
    expect(allRows()).toHaveLength(MAX_READERS_PER_APP);
    // An existing row still counts up at the cap.
    upsertReader(db(), { appId: id, expression: 'window.v0', ok: true });
    expect(allRows()[0]?.ok_n).toBe(2);
  });
});

describe('recordReaderFromDispatch', () => {
  const ctx = {
    tool: 'browser.evaluate',
    args: { tab_id: 'tab_1', expression: 'document.title' },
    result: 'Inbox',
    url: 'https://app.example.com/inbox/42',
    build: 'b7',
  };

  test('records an evaluate against the origin app', () => {
    db();
    recordReaderFromDispatch(ctx);
    expect(listReaders(db(), appId())).toEqual([
      expect.objectContaining({
        expression: 'document.title',
        ok_n: 1,
        last_ok_build: 'b7',
        result_bytes_avg: Buffer.byteLength(JSON.stringify('Inbox')),
      }),
    ]);
  });

  test('a thrown evaluate counts as a failure', () => {
    db();
    recordReaderFromDispatch({ ...ctx, result: undefined, error: new Error('boom') });
    expect(listReaders(db(), appId())[0]).toMatchObject({ ok_n: 0, fail_n: 1 });
  });

  test('ignores other tools, missing expressions and URL-less tabs', () => {
    db();
    recordReaderFromDispatch({ ...ctx, tool: 'browser.click' });
    recordReaderFromDispatch({ ...ctx, args: { tab_id: 'tab_1' } });
    recordReaderFromDispatch({ ...ctx, url: undefined });
    recordReaderFromDispatch({ ...ctx, url: 'about:blank' });
    expect(allRows()).toEqual([]);
  });

  test('map learning off records nothing', () => {
    db();
    saveConfig({ mapLearningEnabled: false });
    recordReaderFromDispatch(ctx);
    expect(allRows()).toEqual([]);
  });

  test('a secret-shaped evaluate creates neither a reader nor an app', () => {
    const handle = db();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    recordReaderFromDispatch({ ...ctx, args: { expression: 'document.cookie' } });
    expect(allRows()).toEqual([]);
    expect(handle.prepare('SELECT COUNT(*) AS n FROM apps').get()).toEqual({ n: 0 });
  });

  test('a value typed earlier in this process never reaches js_readers', () => {
    db();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rememberTypedValue('ana.garcia@example.com');
    recordReaderFromDispatch({
      ...ctx,
      args: { expression: 'document.body.innerText.includes(`ana.garcia@example.com`)' },
    });
    expect(allRows()).toEqual([]);
  });

  test('never throws, even when the DB is unusable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getDb().exec('DROP TABLE IF EXISTS js_readers');
    expect(() =>
      recordReaderFromDispatch({ ...ctx, args: { expression: 'window.x' } }),
    ).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
