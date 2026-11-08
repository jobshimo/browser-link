import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  OBSERVER_BINDING,
  OBSERVER_GLOBAL,
  OBSERVER_VERSION,
  buildObserverChangesJs,
  buildObserverInstallJs,
  buildObserverMarkJs,
  buildObserverRefResolveJs,
  buildObserverTeardownJs,
} from './observer.js';

/**
 * End-to-end tests for the page observer source. Each builder returns a
 * self-invoking expression; indirect eval runs it in the jsdom window the
 * same way CDP `Runtime.evaluate` / `Page.addScriptToEvaluateOnNewDocument`
 * run it in a page. A fake binding on `window` collects the pushed messages.
 */
const globalEval = eval;

function evalExpr<T = unknown>(source: string): T {
  return globalEval(source) as T;
}

interface Descriptor {
  tag: string;
  id?: string;
  role?: string;
  path: string;
}
interface Kinds {
  childList: number;
  attributes: number;
  characterData: number;
}
interface Roots {
  document: boolean;
  shadow: boolean;
  frame: boolean;
}
interface Summary {
  type: 'summary';
  doc_id: string;
  seq: number;
  t0: number;
  t1: number;
  records: number;
  targets: number;
  kinds: Kinds;
  roots: Roots;
  descriptors: Descriptor[];
  overflow: number;
}
type Message =
  | Summary
  | { type: 'doc_start'; doc_id: string; url: string; version: number; coverage: string }
  | { type: 'nav'; doc_id: string; url: string };

interface MarkOk {
  ok: true;
  doc_id: string;
  mark: number;
  url: string;
  has_focus_baseline: true;
}
interface ChangesOk {
  ok: true;
  doc_id: string;
  since: number;
  records: number;
  targets: number;
  kinds: Kinds;
  roots: Roots;
  descriptors: Descriptor[];
  overflow: number;
  truncated?: true;
  url_changed?: string;
  focus_moved?: true;
}
type Failure = { ok: false; reason: string };

let pushed: Message[] = [];
const summaries = (): Summary[] => pushed.filter((m): m is Summary => m.type === 'summary');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  pushed = [];
  document.body.innerHTML = '';
  (window as unknown as Record<string, unknown>)[OBSERVER_BINDING] = (payload: string) => {
    pushed.push(JSON.parse(payload) as Message);
  };
});

afterEach(() => {
  vi.useRealTimers();
  evalExpr(buildObserverTeardownJs());
  delete (window as unknown as Record<string, unknown>)[OBSERVER_BINDING];
});

describe('page observer: install and lifecycle', () => {
  test('install pushes doc_start with the version and full coverage', () => {
    evalExpr(buildObserverInstallJs());
    const starts = pushed.filter((m) => m.type === 'doc_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      type: 'doc_start',
      version: OBSERVER_VERSION,
      coverage: 'full',
      url: location.href,
    });
    expect(typeof starts[0].doc_id).toBe('string');
  });

  test('an equal version is a no-op and a higher version replaces the old observers', async () => {
    document.body.innerHTML = '<ul id="list"></ul>';
    evalExpr(buildObserverInstallJs());
    evalExpr(buildObserverInstallJs());
    expect(pushed.filter((m) => m.type === 'doc_start')).toHaveLength(1);
    document.getElementById('list')!.appendChild(document.createElement('li'));
    await wait(40);
    expect(summaries()).toHaveLength(1);

    pushed = [];
    evalExpr(buildObserverInstallJs({ version: OBSERVER_VERSION + 1 }));
    const starts = pushed.filter((m) => m.type === 'doc_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ version: OBSERVER_VERSION + 1 });
    document.getElementById('list')!.appendChild(document.createElement('li'));
    await wait(40);
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].records).toBe(1);
  });

  test('a nav message is pushed on history.pushState', () => {
    evalExpr(buildObserverInstallJs());
    history.pushState({}, '', '/next-page');
    const navs = pushed.filter((m) => m.type === 'nav');
    expect(navs).toHaveLength(1);
    expect(navs[0]).toMatchObject({ type: 'nav', url: location.href });
    expect(location.pathname).toBe('/next-page');
  });

  test('teardown disconnects the observers and is idempotent', async () => {
    document.body.innerHTML = '<ul id="list"></ul>';
    evalExpr(buildObserverInstallJs());
    document.getElementById('list')!.appendChild(document.createElement('li'));
    await wait(40);
    expect(summaries()).toHaveLength(1);
    pushed = [];
    evalExpr(buildObserverTeardownJs());
    expect(() => evalExpr(buildObserverTeardownJs())).not.toThrow();
    document.getElementById('list')!.appendChild(document.createElement('li'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).appendChild(document.createElement('span'));
    await wait(40);
    expect(summaries()).toHaveLength(0);
    expect(evalExpr<Failure>(buildObserverMarkJs())).toEqual({
      ok: false,
      reason: 'observer-unavailable',
    });
  });
});

describe('page observer: observation and coalescing', () => {
  test('a light DOM childList mutation yields one summary after the flush delay', async () => {
    document.body.innerHTML = '<div id="app"><ul id="list"></ul></div>';
    evalExpr(buildObserverInstallJs());
    document.getElementById('list')!.appendChild(document.createElement('li'));
    expect(summaries()).toHaveLength(0);
    await wait(40);
    expect(summaries()).toHaveLength(1);
    const s = summaries()[0];
    expect(s.records).toBe(1);
    expect(s.kinds.childList).toBe(1);
    expect(s.roots.document).toBe(true);
    expect(s.roots.frame).toBe(false);
    expect(s.descriptors).toHaveLength(1);
    expect(s.descriptors[0]).toMatchObject({ tag: 'ul', id: 'list' });
    expect(s.descriptors[0].path).toBe('body>div#app>ul#list');
    expect(s.overflow).toBe(0);
  });

  test('mutations inside an open shadow root that existed at install are counted', async () => {
    const host = document.createElement('my-card');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<section id="inner"></section>';
    evalExpr(buildObserverInstallJs());
    root.getElementById('inner')!.setAttribute('data-x', '1');
    await wait(40);
    const s = summaries()[0];
    expect(s.records).toBe(1);
    expect(s.kinds.attributes).toBe(1);
    expect(s.roots.shadow).toBe(true);
    expect(s.descriptors[0].path).toBe('body>my-card>#shadow>section#inner');
  });

  test('open and closed shadow roots created after install are both observed', async () => {
    evalExpr(buildObserverInstallJs());
    const openHost = document.createElement('div');
    const closedHost = document.createElement('div');
    document.body.append(openHost, closedHost);
    await wait(40);
    pushed = [];
    openHost.attachShadow({ mode: 'open' }).appendChild(document.createElement('i'));
    closedHost.attachShadow({ mode: 'closed' }).appendChild(document.createElement('b'));
    await wait(40);
    const s = summaries()[0];
    expect(s.records).toBe(2);
    expect(s.roots.shadow).toBe(true);
    expect(s.roots.document).toBe(false);
    expect(s.descriptors.every((d) => d.tag === '#shadow-root')).toBe(true);
  });

  test('characterData is attributed to the parent element', async () => {
    document.body.innerHTML = '<p id="msg">hello</p>';
    evalExpr(buildObserverInstallJs());
    (document.getElementById('msg')!.firstChild as Text).data = 'bye';
    await wait(40);
    const s = summaries()[0];
    expect(s.kinds.characterData).toBe(1);
    expect(s.descriptors).toEqual([{ tag: 'p', id: 'msg', path: 'body>p#msg' }]);
  });

  test('a burst folds into one summary, descriptors ordered by count, overflow beyond the cap', async () => {
    document.body.innerHTML =
      '<div id="a" role="status"></div><div id="b"></div><div id="c"></div>';
    evalExpr(buildObserverInstallJs({ descriptor_cap: 2 }));
    const [a, b, c] = ['a', 'b', 'c'].map((id) => document.getElementById(id)!);
    b.setAttribute('x', '1');
    a.setAttribute('x', '1');
    a.setAttribute('x', '2');
    a.setAttribute('x', '3');
    b.setAttribute('x', '2');
    c.setAttribute('x', '1');
    await wait(40);
    expect(summaries()).toHaveLength(1);
    const s = summaries()[0];
    expect(s.records).toBe(6);
    expect(s.targets).toBe(3);
    expect(s.descriptors.map((d) => d.id)).toEqual(['a', 'b']);
    expect(s.descriptors[0].role).toBe('status');
    expect(s.overflow).toBe(1);
  });

  test('the flush runs on setTimeout and never on requestAnimationFrame', async () => {
    vi.useFakeTimers();
    const raf = vi.fn(() => {
      throw new Error('requestAnimationFrame must not be used');
    });
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = raf as unknown as typeof window.requestAnimationFrame;
    try {
      document.body.innerHTML = '<ul id="list"></ul>';
      evalExpr(buildObserverInstallJs());
      document.getElementById('list')!.appendChild(document.createElement('li'));
      await Promise.resolve();
      expect(summaries()).toHaveLength(0);
      vi.advanceTimersByTime(16);
      expect(summaries()).toHaveLength(1);
      expect(raf).not.toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = original;
    }
  });
});

describe('page observer: mark and changes', () => {
  test('changes since a mark exclude earlier mutations and report focus and url baselines', () => {
    document.body.innerHTML = '<ul id="list"></ul><button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    list.appendChild(document.createElement('li'));
    const mark = evalExpr<MarkOk>(buildObserverMarkJs());
    expect(mark).toMatchObject({ ok: true, url: location.href, has_focus_baseline: true });
    expect(mark.mark).toBe(1);

    list.appendChild(document.createElement('li'));
    list.setAttribute('data-n', '2');
    document.getElementById('go')!.focus();
    const changes = evalExpr<ChangesOk>(buildObserverChangesJs(mark.mark));
    expect(changes).toMatchObject({ ok: true, doc_id: mark.doc_id, since: mark.mark });
    expect(changes.records).toBe(2);
    expect(changes.kinds).toEqual({ childList: 1, attributes: 1, characterData: 0 });
    expect(changes.targets).toBe(1);
    expect(changes.descriptors[0].path).toBe('body>ul#list');
    expect(changes.focus_moved).toBe(true);
    expect('url_changed' in changes).toBe(false);
    expect('truncated' in changes).toBe(false);
  });

  test('changes without an observer report observer-unavailable', () => {
    expect(evalExpr<Failure>(buildObserverChangesJs(0))).toEqual({
      ok: false,
      reason: 'observer-unavailable',
    });
  });
});

interface RefInstance {
  doc_id: string;
  refFor(el: Element): string | null;
  resolveRef(ref: string): Element | null;
  nextSnapshotId(): string | null;
  recordSnapshot(id: string, record: unknown): void;
  getSnapshot(id: string): unknown;
  teardown(): void;
}
const instance = (): RefInstance =>
  (window as unknown as Record<string, RefInstance>)[OBSERVER_GLOBAL];

describe('page observer: element refs', () => {
  test('the same element gets the same ref across calls', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const go = document.getElementById('go')!;
    const first = instance().refFor(go);
    expect(first).toBe('e1');
    expect(instance().refFor(go)).toBe(first);
    expect(instance().resolveRef(first!)).toBe(go);
  });

  test('distinct elements get distinct refs in issue order', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.refFor(document.getElementById('b')!)).toBe('e1');
    expect(g.refFor(document.getElementById('a')!)).toBe('e2');
    expect(g.resolveRef('e1')).toBe(document.getElementById('b'));
    expect(g.resolveRef('e2')).toBe(document.getElementById('a'));
  });

  test('a detached element resolves to null and its ref id is never reissued', () => {
    document.body.innerHTML = '<ul id="list"><li id="one">1</li></ul>';
    evalExpr(buildObserverInstallJs());
    const g = instance();
    const one = document.getElementById('one')!;
    const ref = g.refFor(one)!;
    one.remove();
    expect(g.resolveRef(ref)).toBeNull();
    const other = document.createElement('li');
    document.getElementById('list')!.appendChild(other);
    const next = g.refFor(other);
    expect(next).not.toBe(ref);
    expect(next).toBe('e2');
    expect(g.resolveRef(ref)).toBeNull();
  });

  test('refFor and resolveRef never throw on bad input', () => {
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.refFor(null as unknown as Element)).toBeNull();
    expect(g.refFor(document.createTextNode('x') as unknown as Element)).toBeNull();
    expect(g.resolveRef(undefined as unknown as string)).toBeNull();
    expect(g.resolveRef('e999')).toBeNull();
  });

  test('a new install on a fresh document instance restarts at e1', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    evalExpr(buildObserverInstallJs());
    instance().refFor(document.getElementById('a')!);
    const firstDoc = instance().doc_id;
    evalExpr(buildObserverTeardownJs());
    evalExpr(buildObserverInstallJs());
    expect(instance().doc_id).not.toBe(firstDoc);
    expect(instance().refFor(document.getElementById('b')!)).toBe('e1');
  });

  test('teardown clears the registries', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const g = instance();
    const ref = g.refFor(document.getElementById('go')!)!;
    g.teardown();
    expect(g.resolveRef(ref)).toBeNull();
    expect(g.refFor(document.getElementById('go')!)).toBeNull();
  });
});
describe('page observer: snapshot ids', () => {
  test('nextSnapshotId issues <doc_id>:s<N> per call from s1', () => {
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.nextSnapshotId()).toBe(g.doc_id + ':s1');
    expect(g.nextSnapshotId()).toBe(g.doc_id + ':s2');
    expect(g.nextSnapshotId()).toBe(g.doc_id + ':s3');
  });

  test('a fresh install restarts at s1 under its own doc_id', () => {
    evalExpr(buildObserverInstallJs());
    const oldDocId = instance().doc_id;
    instance().nextSnapshotId();
    instance().nextSnapshotId();
    evalExpr(buildObserverTeardownJs());
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.doc_id).not.toBe(oldDocId);
    expect(g.nextSnapshotId()).toBe(g.doc_id + ':s1');
  });

  test('nextSnapshotId returns null after teardown', () => {
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.nextSnapshotId()).toBe(g.doc_id + ':s1');
    g.teardown();
    expect(g.nextSnapshotId()).toBeNull();
  });
});

describe('page observer: snapshot store', () => {
  test('a recorded snapshot round-trips by id, unknown ids give null', () => {
    evalExpr(buildObserverInstallJs());
    const g = instance();
    const record = { entries: { e1: { hash: 'h', entry: { tag: 'button' } } }, text_hash: 't' };
    g.recordSnapshot('s1', record);
    expect(g.getSnapshot('s1')).toBe(record);
    expect(g.getSnapshot('s2')).toBeNull();
    expect(g.getSnapshot(42 as unknown as string)).toBeNull();
  });

  test('only the last 4 records are kept: the oldest is evicted by the fifth', () => {
    evalExpr(buildObserverInstallJs());
    const g = instance();
    for (let i = 1; i <= 5; i++) g.recordSnapshot('s' + i, { n: i });
    expect(g.getSnapshot('s1')).toBeNull();
    for (let i = 2; i <= 5; i++) expect(g.getSnapshot('s' + i)).toEqual({ n: i });
  });

  test('teardown clears the store and makes both methods inert', () => {
    evalExpr(buildObserverInstallJs());
    const g = instance();
    g.recordSnapshot('s1', { n: 1 });
    g.teardown();
    expect(g.getSnapshot('s1')).toBeNull();
    g.recordSnapshot('s2', { n: 2 });
    expect(g.getSnapshot('s2')).toBeNull();
  });
});
describe('page observer: version 2 install rule', () => {
  test('OBSERVER_VERSION is 2', () => {
    expect(OBSERVER_VERSION).toBe(2);
  });

  test('an installed version 1 instance is torn down and replaced by version 2', () => {
    const teardown = vi.fn();
    (window as unknown as Record<string, unknown>)[OBSERVER_GLOBAL] = {
      version: 1,
      doc_id: 'old-doc',
      coverage: 'full',
      teardown,
    };
    const result = evalExpr(buildObserverInstallJs());
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, installed: true, version: 2 });
    expect(instance().doc_id).not.toBe('old-doc');
    expect(typeof instance().refFor).toBe('function');
  });

  test.each([2, 3])('an installed version %i instance is left alone', (version) => {
    const teardown = vi.fn();
    (window as unknown as Record<string, unknown>)[OBSERVER_GLOBAL] = {
      version,
      doc_id: 'kept-doc',
      coverage: 'full',
      teardown,
    };
    const result = evalExpr(buildObserverInstallJs());
    expect(teardown).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      installed: false,
      version,
      doc_id: 'kept-doc',
      coverage: 'full',
    });
    expect(pushed.filter((m) => m.type === 'doc_start')).toHaveLength(0);
  });

  test('doc_start keeps its exact payload shape with version 2', () => {
    evalExpr(buildObserverInstallJs());
    const starts = pushed.filter((m) => m.type === 'doc_start');
    expect(starts).toHaveLength(1);
    expect(Object.keys(starts[0]).sort()).toEqual(['coverage', 'doc_id', 'type', 'url', 'version']);
    expect(starts[0]).toMatchObject({ version: 2, coverage: 'full', url: location.href });
  });

  test('mark and changes keep their exact result shapes alongside refs', () => {
    document.body.innerHTML = '<ul id="list"></ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    instance().refFor(list);
    const mark = evalExpr<MarkOk>(buildObserverMarkJs());
    expect(Object.keys(mark).sort()).toEqual(['doc_id', 'has_focus_baseline', 'mark', 'ok', 'url']);
    list.appendChild(document.createElement('li'));
    const changes = evalExpr<ChangesOk>(buildObserverChangesJs(mark.mark));
    expect(Object.keys(changes).sort()).toEqual([
      'descriptors',
      'doc_id',
      'kinds',
      'ok',
      'overflow',
      'records',
      'roots',
      'since',
      'targets',
    ]);
    expect(changes.records).toBe(1);
    expect(changes.descriptors).toEqual([{ tag: 'ul', id: 'list', path: 'body>ul#list' }]);
  });
});

describe('page observer: buildObserverRefResolveJs', () => {
  test('a live ref resolves to found with its tag', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const ref = instance().refFor(document.getElementById('go')!)!;
    expect(evalExpr(buildObserverRefResolveJs(ref))).toEqual({
      ok: true,
      found: true,
      tag: 'button',
    });
  });

  test('a stale or unknown ref resolves to not found', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const go = document.getElementById('go')!;
    const ref = instance().refFor(go)!;
    go.remove();
    expect(evalExpr(buildObserverRefResolveJs(ref))).toEqual({ ok: true, found: false });
    expect(evalExpr(buildObserverRefResolveJs('e42'))).toEqual({ ok: true, found: false });
  });

  test('without an instance it reports observer-unavailable', () => {
    expect(evalExpr<Failure>(buildObserverRefResolveJs('e1'))).toEqual({
      ok: false,
      reason: 'observer-unavailable',
    });
  });
});
