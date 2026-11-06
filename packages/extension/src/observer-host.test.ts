import { describe, expect, test } from 'vitest';
import {
  OBSERVER_RECENT_CAP,
  TOP_DOCUMENT_PROBE_JS,
  applyObserverMessage,
  createObserverMirror,
  isTopDocumentMessage,
  mergeSettleChanges,
  parseObserverMessage,
  readObserverMark,
} from './observer-host.js';

function summaryPayload(seq: number, docId = 'doc-a', frame = false): string {
  return JSON.stringify({
    type: 'summary',
    doc_id: docId,
    seq,
    t0: 1,
    t1: 2,
    records: 3,
    targets: 1,
    kinds: { childList: 1, attributes: 2, characterData: 0 },
    roots: { document: true, shadow: false, frame },
    descriptors: [{ tag: 'div', id: 'app', path: 'body>div#app' }],
    overflow: 0,
  });
}

function apply(mirror: ReturnType<typeof createObserverMirror>, payload: string) {
  const message = parseObserverMessage(payload);
  if (!message) return { kind: 'ignored' as const };
  return applyObserverMessage(mirror, message);
}

const docStart = (docId: string, url: string, coverage: 'full' | 'partial' = 'full'): string =>
  JSON.stringify({ type: 'doc_start', doc_id: docId, url, version: 1, coverage });

describe('createObserverMirror', () => {
  test('starts uninstalled with an empty ring', () => {
    expect(createObserverMirror()).toEqual({ installed: false, last_seq: 0, recent: [] });
  });
});

describe('parseObserverMessage', () => {
  test('rejects invalid JSON, non-objects and unknown shapes', () => {
    expect(parseObserverMessage('{not json')).toBeNull();
    expect(parseObserverMessage('42')).toBeNull();
    expect(parseObserverMessage('null')).toBeNull();
    expect(parseObserverMessage(JSON.stringify({ type: 'bogus', doc_id: 'x' }))).toBeNull();
    expect(parseObserverMessage(JSON.stringify({ type: 'nav', doc_id: 'x' }))).toBeNull();
    expect(parseObserverMessage(JSON.stringify({ type: 'summary', doc_id: 'x', seq: 'one' }))).toBeNull();
  });

  test('accepts the three observer message types', () => {
    expect(parseObserverMessage(summaryPayload(1))?.type).toBe('summary');
    expect(parseObserverMessage(docStart('d', 'https://a.test/'))?.type).toBe('doc_start');
    expect(
      parseObserverMessage(JSON.stringify({ type: 'nav', doc_id: 'd', url: 'https://a.test/#x' }))
        ?.type,
    ).toBe('nav');
  });
});

describe('applyObserverMessage', () => {
  test('a valid summary updates last_seq and is kept in the recent ring', () => {
    const mirror = createObserverMirror();
    expect(apply(mirror, summaryPayload(4))).toEqual({ kind: 'summary' });
    expect(mirror.last_seq).toBe(4);
    expect(mirror.recent).toHaveLength(1);
    expect(mirror.recent[0]?.seq).toBe(4);
  });

  test('the recent ring is bounded at 32 summaries, oldest dropped first', () => {
    const mirror = createObserverMirror();
    for (let seq = 1; seq <= 40; seq++) apply(mirror, summaryPayload(seq));
    expect(OBSERVER_RECENT_CAP).toBe(32);
    expect(mirror.recent).toHaveLength(32);
    expect(mirror.recent[0]?.seq).toBe(9);
    expect(mirror.recent[31]?.seq).toBe(40);
    expect(mirror.last_seq).toBe(40);
  });

  test('doc_start resets doc_id, url, coverage and the ring, and reports doc_start', () => {
    const mirror = createObserverMirror();
    apply(mirror, docStart('doc-a', 'https://a.test/'));
    apply(mirror, summaryPayload(7, 'doc-a'));
    const outcome = apply(mirror, docStart('doc-b', 'https://b.test/', 'partial'));
    expect(outcome).toEqual({ kind: 'doc_start', url: 'https://b.test/' });
    expect(mirror).toMatchObject({
      doc_id: 'doc-b',
      url: 'https://b.test/',
      coverage: 'partial',
      last_seq: 0,
      recent: [],
    });
  });

  test('nav updates the url and reports nav; a nav to the same url is ignored', () => {
    const mirror = createObserverMirror();
    apply(mirror, docStart('doc-a', 'https://a.test/'));
    const navPayload = JSON.stringify({ type: 'nav', doc_id: 'doc-a', url: 'https://a.test/next' });
    expect(apply(mirror, navPayload)).toEqual({ kind: 'nav', url: 'https://a.test/next' });
    expect(mirror.url).toBe('https://a.test/next');
    expect(apply(mirror, navPayload)).toEqual({ kind: 'ignored' });
  });

  test('summaries from a child frame or from another document are ignored', () => {
    const mirror = createObserverMirror();
    apply(mirror, docStart('doc-a', 'https://a.test/'));
    expect(apply(mirror, summaryPayload(1, 'doc-a', true))).toEqual({ kind: 'ignored' });
    expect(apply(mirror, summaryPayload(1, 'doc-other'))).toEqual({ kind: 'ignored' });
    expect(mirror.last_seq).toBe(0);
    expect(mirror.recent).toEqual([]);
  });

  test('a garbage payload is ignored and leaves the mirror intact', () => {
    const mirror = createObserverMirror();
    mirror.installed = true;
    apply(mirror, docStart('doc-a', 'https://a.test/'));
    apply(mirror, summaryPayload(2, 'doc-a'));
    const before = structuredClone(mirror);
    for (const garbage of ['', '{', '[]', '"nav"', JSON.stringify({ type: 'nav' })]) {
      expect(apply(mirror, garbage)).toEqual({ kind: 'ignored' });
    }
    expect(mirror).toEqual(before);
  });
});

describe('isTopDocumentMessage', () => {
  test('matches only when the top document reports the same doc_id', () => {
    expect(isTopDocumentMessage({ doc_id: 'doc-a' }, 'doc-a')).toBe(true);
    expect(isTopDocumentMessage({ doc_id: 'doc-frame' }, 'doc-a')).toBe(false);
    expect(isTopDocumentMessage(null, 'doc-a')).toBe(false);
    expect(isTopDocumentMessage({ doc_id: null }, 'doc-a')).toBe(false);
  });

  test('the probe expression reads the doc_id of the installed observer', () => {
    const w = window as unknown as Record<string, unknown>;
    w.__blPageObserver = { doc_id: 'doc-z' };
    try {
      expect((0, eval)(TOP_DOCUMENT_PROBE_JS)).toEqual({ doc_id: 'doc-z' });
    } finally {
      delete w.__blPageObserver;
    }
    expect((0, eval)(TOP_DOCUMENT_PROBE_JS)).toEqual({ doc_id: null });
  });
});

describe('mergeSettleChanges', () => {
  const baseSettle = (): Record<string, unknown> => ({
    settled: true,
    duration_ms: 180,
    mutation_count: 0,
    url_changed: 'https://late.test/',
    focus_moved: true,
  });

  const okChanges = {
    ok: true,
    doc_id: 'doc-a',
    since: 3,
    records: 5,
    targets: 2,
    kinds: { childList: 2, attributes: 3, characterData: 0 },
    roots: { document: true, shadow: true, frame: false },
    descriptors: [{ tag: 'span', path: 'body>span' }],
    overflow: 0,
  };

  test('ok changes attach `changes` and override mutation_count, url_changed and focus_moved', () => {
    const merged = mergeSettleChanges(baseSettle(), {
      ...okChanges,
      truncated: true,
      url_changed: 'https://a.test/after',
    });
    expect(merged).toEqual({
      settled: true,
      duration_ms: 180,
      mutation_count: 5,
      url_changed: 'https://a.test/after',
      changes: {
        records: 5,
        targets: 2,
        kinds: { childList: 2, attributes: 3, characterData: 0 },
        roots: { document: true, shadow: true, frame: false },
        descriptors: [{ tag: 'span', path: 'body>span' }],
        overflow: 0,
        truncated: true,
      },
    });
  });

  test('ok changes with focus moved since the mark report focus_moved and no url_changed', () => {
    const settle = baseSettle();
    delete settle.focus_moved;
    const merged = mergeSettleChanges(settle, { ...okChanges, focus_moved: true });
    expect(merged).toMatchObject({ focus_moved: true, mutation_count: 5 });
    expect(merged).not.toHaveProperty('url_changed');
    expect(merged?.changes).not.toHaveProperty('truncated');
  });

  test('failed changes keep every settle field and add changes: null with the reason', () => {
    for (const reason of ['observer-unavailable', 'doc-changed'] as const) {
      expect(mergeSettleChanges(baseSettle(), { ok: false, reason })).toEqual({
        ...baseSettle(),
        changes: null,
        observer: reason,
      });
    }
  });

  test('non-object, malformed or unknown-reason changes report changes-error', () => {
    for (const bad of [undefined, null, 'x', { ok: true, records: 'many' }, { ok: false, reason: 'weird' }]) {
      expect(mergeSettleChanges(baseSettle(), bad)).toEqual({
        ...baseSettle(),
        changes: null,
        observer: 'changes-error',
      });
    }
  });

  test('settle degraded results (context destroyed) keep their fields on both paths', () => {
    const degraded = { settled: false, reason: 'context-destroyed' };
    expect(mergeSettleChanges({ ...degraded }, { ok: false, reason: 'doc-changed' })).toEqual({
      ...degraded,
      changes: null,
      observer: 'doc-changed',
    });
  });

  test('null settle (settle_ms: 0) stays null', () => {
    expect(mergeSettleChanges(null, okChanges)).toBeNull();
    expect(mergeSettleChanges(null, { ok: false, reason: 'doc-changed' })).toBeNull();
  });

  test('never mutates the settle object it was given', () => {
    const settle = baseSettle();
    mergeSettleChanges(settle, okChanges);
    expect(settle).toEqual(baseSettle());
  });
});

describe('readObserverMark', () => {
  test('accepts an ok mark with a numeric mark and a doc_id', () => {
    expect(
      readObserverMark({ ok: true, doc_id: 'doc-a', mark: 3, url: 'https://a.test/', has_focus_baseline: true }),
    ).toEqual({ mark: 3, doc_id: 'doc-a' });
  });

  test('rejects failed, malformed or missing marks', () => {
    for (const bad of [
      null,
      undefined,
      { ok: false, reason: 'observer-unavailable' },
      { ok: true, doc_id: 'doc-a' },
      { ok: true, mark: 1 },
      { ok: true, doc_id: 'doc-a', mark: -1 },
    ]) {
      expect(readObserverMark(bad)).toBeNull();
    }
  });
});
