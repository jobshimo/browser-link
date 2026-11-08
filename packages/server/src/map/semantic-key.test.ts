import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from './db.js';
import { getMapHint, listApps, listEntries, recall } from './queries.js';
import { handleMapTool, MAP_TOOL_DEFINITIONS } from './tools.js';

/**
 * The map stores the semantic key next to the selector (spec v4 §6.3, S3):
 * `semantic_key` lives inside the free-form JSON `payload` (no migration),
 * `browser.map.save` validates it and refuses it on `ambiguous: true`
 * entries, and `recall` adds `prefer: 'semantic_key'` to a selector entry
 * whose stored selector is a structural (`:nth-of-type(`) fallback.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-semantic-key-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const ORIGIN = 'https://myapp.example.com';
const KEY = {
  role: 'button',
  name: 'Save',
  path: [
    { tag: 'body', index: 1 },
    { tag: 'main', index: 1 },
    { tag: 'button', index: 2 },
  ],
};
const STRUCTURAL = 'main > button:nth-of-type(2)';

function save(purpose: string, payload: unknown): unknown {
  return handleMapTool('browser.map.save', {
    origin: ORIGIN,
    title: 'My App',
    url_pattern: '/home',
    kind: 'selector',
    purpose,
    payload,
  });
}

function recalled(purpose: string): Record<string, unknown> {
  const result = recall({ origin: ORIGIN });
  const entry = result.entries.find((e) => e.purpose === purpose);
  if (!entry) throw new Error(`no recalled entry "${purpose}"`);
  return entry as unknown as Record<string, unknown>;
}

describe('browser.map.save with semantic_key', () => {
  test('a valid key is stored inside the payload and recall returns it verbatim', () => {
    const payload = { selector: STRUCTURAL, evidence: 'clicked', semantic_key: KEY };
    save('save button', payload);
    expect(recalled('save button').payload).toEqual(payload);
  });

  test('a key on an ambiguous: true entry is refused naming the entry; nothing is saved', () => {
    expect(() =>
      save('save button', { selector: STRUCTURAL, ambiguous: true, semantic_key: KEY }),
    ).toThrow(
      'browser.map.save: entry "save button" (/home) has ambiguous: true and cannot store a semantic_key',
    );
    expect(listApps()).toEqual([]);
  });

  test.each([
    ['missing role', { name: 'Save', path: KEY.path }, /semantic_key role must be/],
    ['missing path', { role: 'button', name: 'Save' }, /semantic_key path is required/],
    [
      'a path of 9 steps',
      { role: 'button', name: 'Save', path: Array.from({ length: 9 }, () => KEY.path[0]) },
      /semantic_key path must be an array of 1 to 8/,
    ],
    [
      'a name over 200 chars',
      { role: 'button', name: 'n'.repeat(201), path: KEY.path },
      /semantic_key name must be a string of at most 200/,
    ],
  ])('a malformed key (%s) is refused before anything is written', (_label, key, error) => {
    expect(() => save('save button', { selector: STRUCTURAL, semantic_key: key })).toThrow(error);
    expect(listApps()).toEqual([]);
  });

  test('entries without a key keep saving and recalling exactly as before', () => {
    save('plain', { selector: '#save' });
    save('ambiguous plain', { selector: STRUCTURAL, ambiguous: true });
    const plain = recalled('plain');
    expect(plain.payload).toEqual({ selector: '#save' });
    expect(plain).not.toHaveProperty('prefer');
    expect(recalled('ambiguous plain').payload).toEqual({ selector: STRUCTURAL, ambiguous: true });
    expect(recalled('ambiguous plain')).not.toHaveProperty('prefer');
  });

  test('the save schema documents semantic_key in the selector payload', () => {
    const def = MAP_TOOL_DEFINITIONS.find((d) => d.name === 'browser.map.save')!;
    const payload = (def.inputSchema as { properties: Record<string, { description: string }> })
      .properties.payload;
    expect(payload.description).toContain('semantic_key');
    const recallDef = MAP_TOOL_DEFINITIONS.find((d) => d.name === 'browser.map.recall')!;
    expect(recallDef.description).toContain('prefer: "semantic_key"');
  });
});

describe('recall prefer: semantic_key', () => {
  test('only a structural selector with a key gets prefer', () => {
    save('structural keyed', { selector: STRUCTURAL, semantic_key: KEY });
    save('id keyed', { selector: '#save', semantic_key: KEY });
    save('structural plain', { selector: STRUCTURAL });
    expect(recalled('structural keyed').prefer).toBe('semantic_key');
    expect(recalled('id keyed')).not.toHaveProperty('prefer');
    expect(recalled('structural plain')).not.toHaveProperty('prefer');
  });

  test('prefer is computed at recall time, never stored', () => {
    save('structural keyed', { selector: STRUCTURAL, semantic_key: KEY });
    const raw = getDb().prepare('SELECT payload FROM entries').get() as { payload: string };
    expect(JSON.parse(raw.payload)).toEqual({ selector: STRUCTURAL, semantic_key: KEY });
    expect(raw.payload).not.toContain('prefer');
    const [app] = listApps();
    expect(listEntries(app!.id)[0]).not.toHaveProperty('prefer');
  });

  test('a non-selector entry never gets prefer', () => {
    handleMapTool('browser.map.save', {
      origin: ORIGIN,
      url_pattern: '/home',
      kind: 'gotcha',
      purpose: 'note',
      payload: { body: 'x', selector: STRUCTURAL, semantic_key: KEY },
    });
    expect(recalled('note')).not.toHaveProperty('prefer');
  });
});

describe('legacy rows (no semantic_key) read unchanged', () => {
  test('a row inserted with the pre-S3 shape recalls exactly as stored', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, title, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    ).run(ORIGIN, 'my-app', 'My App', '2026-01-01', '2026-01-01');
    db.prepare(
      `INSERT INTO entries (app_id, url_pattern, kind, purpose, payload, verified_at, failed_at, notes, created_at, updated_at)
       VALUES (1, '/home', 'selector', 'legacy', ?, '2026-01-02', NULL, 'old note', '2026-01-01', '2026-01-02')`,
    ).run(JSON.stringify({ selector: STRUCTURAL, evidence: 'old' }));

    const [entry] = recall({ origin: ORIGIN }).entries;
    expect(entry).toEqual({
      id: 1,
      app_id: 1,
      url_pattern: '/home',
      kind: 'selector',
      purpose: 'legacy',
      payload: { selector: STRUCTURAL, evidence: 'old' },
      verified_at: '2026-01-02',
      failed_at: null,
      notes: 'old note',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
    });
  });
});

describe('forget and the list_tabs hint with a keyed entry', () => {
  test('forget removes an entry that carries a key', () => {
    save('structural keyed', { selector: STRUCTURAL, semantic_key: KEY });
    const entry = recalled('structural keyed');
    const result = handleMapTool('browser.map.forget', { entry_id: entry.id }) as {
      deleted_entries: number;
    };
    expect(result.deleted_entries).toBe(1);
    expect(recall({ origin: ORIGIN }).entries).toEqual([]);
  });

  test('the inline hint passes the payload through and still respects its byte cap', () => {
    save('structural keyed', { selector: STRUCTURAL, semantic_key: KEY });
    const hint = getMapHint(ORIGIN)!;
    expect(hint.inline?.entries[0]?.payload).toEqual({ selector: STRUCTURAL, semantic_key: KEY });

    const longName = 'n'.repeat(200);
    // Five items (the item cap) whose JSON exceeds the 2048-byte cap.
    for (let i = 0; i < 4; i++) {
      save(`long ${i}`, {
        selector: STRUCTURAL,
        evidence: 'e'.repeat(300),
        semantic_key: { role: 'button', name: longName, path: KEY.path },
      });
    }
    const capped = getMapHint(ORIGIN)!;
    expect(capped.entries).toBe(5);
    expect(capped.inline).toBeUndefined();
  });
});
