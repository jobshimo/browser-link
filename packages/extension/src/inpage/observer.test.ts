import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  OBSERVER_BINDING,
  OBSERVER_GLOBAL,
  OBSERVER_VERSION,
  buildObserverChangesJs,
  buildObserverInstallJs,
  buildObserverMarkJs,
  buildObserverRefResolveJs,
  buildObserverSemanticKeyJs,
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

interface PathStep {
  tag: string;
  index: number;
}
interface SemanticKey {
  role: string;
  name: string;
  path: PathStep[];
}
interface RefInstance {
  doc_id: string;
  refFor(el: Element): string | null;
  resolveRef(ref: string): Element | null;
  resolveRefDetailed(ref: string): { el: Element; reresolved: boolean } | null;
  semanticKeyFor(el: Element): SemanticKey | null;
  nextSnapshotId(): string | null;
  recordSnapshot(id: string, record: unknown): void;
  getSnapshot(id: string): unknown;
  teardown(): void;
}
const instance = (): RefInstance =>
  (window as unknown as Record<string, RefInstance>)[OBSERVER_GLOBAL];
/** The ref the current instance issues for its N-th element: `<doc_tag>:e<N>`. */
const tagged = (n: number): string => instance().doc_id.slice(0, 6) + ':e' + n;
const REF_FORMAT = /^[a-z0-9]{1,6}:e\d+$/;

describe('page observer: element refs', () => {
  test('the same element gets the same ref across calls', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const go = document.getElementById('go')!;
    const first = instance().refFor(go);
    expect(first).toBe(tagged(1));
    expect(first).toMatch(REF_FORMAT);
    expect(instance().refFor(go)).toBe(first);
    expect(instance().resolveRef(first!)).toBe(go);
  });

  test('distinct elements get distinct refs in issue order', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.refFor(document.getElementById('b')!)).toBe(tagged(1));
    expect(g.refFor(document.getElementById('a')!)).toBe(tagged(2));
    expect(g.resolveRef(tagged(1))).toBe(document.getElementById('b'));
    expect(g.resolveRef(tagged(2))).toBe(document.getElementById('a'));
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
    expect(next).toBe(tagged(2));
    expect(g.resolveRef(ref)).toBeNull();
  });

  test('refFor and resolveRef never throw on bad input', () => {
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.refFor(null as unknown as Element)).toBeNull();
    expect(g.refFor(document.createTextNode('x') as unknown as Element)).toBeNull();
    expect(g.resolveRef(undefined as unknown as string)).toBeNull();
    expect(g.resolveRef(tagged(999))).toBeNull();
  });

  test('a bare e<N> without a document tag is stale even when this document issued that number', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.refFor(document.getElementById('go')!)).toBe(tagged(1));
    expect(g.resolveRef('e1')).toBeNull();
    expect(g.resolveRefDetailed('e1')).toBeNull();
    expect(evalExpr(buildObserverRefResolveJs('e1'))).toEqual({ ok: true, found: false });
    expect(evalExpr(buildObserverSemanticKeyJs('e1'))).toEqual({ ok: true, key: null });
  });

  test('a ref from a torn-down instance is stale even when the new instance issued the same number', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    evalExpr(buildObserverInstallJs());
    const oldRef = instance().refFor(document.getElementById('a')!)!;
    expect(oldRef).toBe(tagged(1));
    evalExpr(buildObserverTeardownJs());
    evalExpr(buildObserverInstallJs());
    const newRef = instance().refFor(document.getElementById('b')!)!;
    expect(newRef).toBe(tagged(1));
    expect(newRef).not.toBe(oldRef);
    expect(instance().resolveRef(oldRef)).toBeNull();
    expect(instance().resolveRefDetailed(oldRef)).toBeNull();
    expect(evalExpr(buildObserverRefResolveJs(oldRef))).toEqual({ ok: true, found: false });
    expect(evalExpr(buildObserverSemanticKeyJs(oldRef))).toEqual({ ok: true, key: null });
    expect(instance().resolveRef(newRef)).toBe(document.getElementById('b'));
  });

  test('a ref carrying another document tag is stale', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const g = instance();
    const ref = g.refFor(document.getElementById('go')!)!;
    const otherTag = g.doc_id.slice(0, 6) === 'zzzzzz' ? 'yyyyyy' : 'zzzzzz';
    expect(g.resolveRef(otherTag + ':e1')).toBeNull();
    expect(g.resolveRef(ref)).toBe(document.getElementById('go'));
  });

  test('a new install on a fresh document instance restarts the number at e1 under its own tag', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    evalExpr(buildObserverInstallJs());
    instance().refFor(document.getElementById('a')!);
    const firstDoc = instance().doc_id;
    evalExpr(buildObserverTeardownJs());
    evalExpr(buildObserverInstallJs());
    expect(instance().doc_id).not.toBe(firstDoc);
    expect(instance().refFor(document.getElementById('b')!)).toBe(tagged(1));
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
describe('page observer: version 3 install rule', () => {
  test('OBSERVER_VERSION is 3', () => {
    expect(OBSERVER_VERSION).toBe(3);
  });

  test('an installed version 2 instance is torn down and replaced by version 3', () => {
    const teardown = vi.fn();
    (window as unknown as Record<string, unknown>)[OBSERVER_GLOBAL] = {
      version: 2,
      doc_id: 'old-doc',
      coverage: 'full',
      teardown,
    };
    const result = evalExpr(buildObserverInstallJs());
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, installed: true, version: 3 });
    expect(instance().doc_id).not.toBe('old-doc');
    expect(typeof instance().refFor).toBe('function');
    expect(typeof instance().resolveRefDetailed).toBe('function');
  });

  test.each([3, 4])('an installed version %i instance is left alone', (version) => {
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

  test('doc_start keeps its exact payload shape with version 3', () => {
    evalExpr(buildObserverInstallJs());
    const starts = pushed.filter((m) => m.type === 'doc_start');
    expect(starts).toHaveLength(1);
    expect(Object.keys(starts[0]).sort()).toEqual(['coverage', 'doc_id', 'type', 'url', 'version']);
    expect(starts[0]).toMatchObject({ version: 3, coverage: 'full', url: location.href });
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
    expect(evalExpr(buildObserverRefResolveJs(tagged(42)))).toEqual({ ok: true, found: false });
  });

  test('without an instance it reports observer-unavailable', () => {
    expect(evalExpr<Failure>(buildObserverRefResolveJs('k3x9ab:e1'))).toEqual({
      ok: false,
      reason: 'observer-unavailable',
    });
  });
});

describe('page observer: builders embed strings safely in JS source', () => {
  test('a ref with line terminators and a closing tag cannot break out of the expression', () => {
    const hostile = 'e1  </script><script>';
    const js = buildObserverRefResolveJs(hostile);
    expect(js).not.toContain(' ');
    expect(js).not.toContain(' ');
    expect(js).not.toContain('</script>');
    expect(js).not.toContain('<script>');
    // The literal still evaluates to the same string once parsed.
    expect(evalExpr<Failure>(js)).toEqual({ ok: false, reason: 'observer-unavailable' });
  });

  test('a docId with the same characters is embedded safely in the changes expression', () => {
    const js = buildObserverChangesJs(0, 'd </script>');
    expect(js).not.toContain(' ');
    expect(js).not.toContain('</script>');
  });
});

const LIST_ITEMS = '<li><button>Alpha</button></li><li><button>Beta</button></li>';

describe('page observer: semantic key', () => {
  test('explicit and implicit roles', () => {
    document.body.innerHTML = [
      '<div id="r" role="tab">Tab</div>',
      '<a id="link" href="/x">Home</a>',
      '<a id="anchor">Plain</a>',
      '<input id="cb" type="checkbox">',
      '<input id="rd" type="radio">',
      '<input id="sub" type="submit" value="Send">',
      '<input id="txt">',
      '<textarea id="ta"></textarea>',
      '<div id="ce" contenteditable="true">Edit</div>',
      '<select id="sel"></select>',
      '<summary id="sum">More</summary>',
      '<section id="sec">S</section>',
    ].join('');
    evalExpr(buildObserverInstallJs());
    const role = (id: string) => instance().semanticKeyFor(document.getElementById(id)!)!.role;
    expect(role('r')).toBe('tab');
    expect(role('link')).toBe('link');
    expect(role('anchor')).toBe('a');
    expect(role('cb')).toBe('checkbox');
    expect(role('rd')).toBe('radio');
    expect(role('sub')).toBe('button');
    expect(role('txt')).toBe('textbox');
    expect(role('ta')).toBe('textbox');
    expect(role('ce')).toBe('textbox');
    expect(role('sel')).toBe('combobox');
    expect(role('sum')).toBe('button');
    expect(role('sec')).toBe('section');
  });

  test('name precedence: aria-label, aria-labelledby, label, text, placeholder, title, value', () => {
    document.body.innerHTML = [
      '<button id="aria" aria-label="Close dialog">X</button>',
      '<span id="lbl1">Search</span><span id="lbl2">site</span>',
      '<button id="by" aria-labelledby="lbl1 lbl2">Go</button>',
      '<label for="email">Email address</label><input id="email" placeholder="you@example.com">',
      '<label>Remember <input id="wrapped" type="checkbox"></label>',
      '<input id="ph" placeholder="Filter" title="T">',
      '<input id="tt" title="Only title">',
      '<input id="val" type="button" value="Press me">',
      '<div id="none"></div>',
      '<p id="long">' + 'word '.repeat(40) + '</p>',
      '<p id="ws">  many\n   spaces\there  </p>',
    ].join('');
    evalExpr(buildObserverInstallJs());
    const name = (id: string) => instance().semanticKeyFor(document.getElementById(id)!)!.name;
    expect(name('aria')).toBe('Close dialog');
    expect(name('by')).toBe('Search site');
    expect(name('email')).toBe('Email address');
    expect(name('wrapped')).toBe('Remember');
    expect(name('ph')).toBe('Filter');
    expect(name('tt')).toBe('Only title');
    expect(name('val')).toBe('Press me');
    expect(name('none')).toBe('');
    expect(name('long')).toBe('word '.repeat(40).trim().slice(0, 80));
    expect(name('long')).toHaveLength(80);
    expect(name('ws')).toBe('many spaces here');
  });

  test('path: up to 8 steps from the outermost, 1-based same-tag sibling index', () => {
    document.body.innerHTML =
      '<ul id="list"><li>a</li><p>p</p><li>b</li><li><span>x</span><span id="t">y</span></li></ul>';
    evalExpr(buildObserverInstallJs());
    expect(instance().semanticKeyFor(document.getElementById('t')!)!.path).toEqual([
      { tag: 'body', index: 1 },
      { tag: 'ul', index: 1 },
      { tag: 'li', index: 3 },
      { tag: 'span', index: 2 },
    ]);
    let deep = '<b id="deep">d</b>';
    for (let i = 0; i < 10; i++) deep = '<div>' + deep + '</div>';
    document.body.innerHTML = deep;
    const path = instance().semanticKeyFor(document.getElementById('deep')!)!.path;
    expect(path).toHaveLength(8);
    expect(path[7]).toEqual({ tag: 'b', index: 1 });
  });

  test('a button inside an open shadow root crosses the boundary as #shadow', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="bar"><button>Save</button></div>';
    evalExpr(buildObserverInstallJs());
    expect(instance().semanticKeyFor(root.querySelector('button')!)).toEqual({
      role: 'button',
      name: 'Save',
      path: [
        { tag: 'body', index: 1 },
        { tag: 'div', index: 1 },
        { tag: '#shadow', index: 0 },
        { tag: 'div', index: 1 },
        { tag: 'button', index: 1 },
      ],
    });
  });

  test('semanticKeyFor never throws on bad input', () => {
    evalExpr(buildObserverInstallJs());
    expect(instance().semanticKeyFor(null as unknown as Element)).toBeNull();
    const text = document.createTextNode('x') as unknown as Element;
    expect(instance().semanticKeyFor(text)).toBeNull();
  });
});

describe('page observer: semantic re-resolution', () => {
  test('a list re-rendered with the same nodes keeps the ref on the same element', () => {
    document.body.innerHTML = '<ul id="list">' + LIST_ITEMS + '</ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    const alpha = list.querySelector('button')!;
    const ref = instance().refFor(alpha)!;
    list.appendChild(list.firstElementChild!);
    alpha.setAttribute('data-churn', '1');
    list.setAttribute('class', 'reordered');
    expect(instance().resolveRefDetailed(ref)).toEqual({ el: alpha, reresolved: false });
    expect(instance().resolveRef(ref)).toBe(alpha);
  });

  test('a re-render that replaces the nodes rebinds the ref to the new node', () => {
    document.body.innerHTML = '<ul id="list">' + LIST_ITEMS + '</ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    const old = list.querySelectorAll('button')[1];
    const ref = instance().refFor(old)!;
    list.innerHTML = LIST_ITEMS;
    const fresh = list.querySelectorAll('button')[1];
    expect(fresh).not.toBe(old);
    expect(instance().resolveRefDetailed(ref)).toEqual({ el: fresh, reresolved: true });
    expect(instance().resolveRef(ref)).toBe(fresh);
    expect(instance().resolveRefDetailed(ref)).toEqual({ el: fresh, reresolved: false });
    expect(instance().refFor(fresh)).toBe(ref);
  });

  test('resolveRef alone re-resolves a replaced node', () => {
    document.body.innerHTML = '<ul id="list">' + LIST_ITEMS + '</ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    const ref = instance().refFor(list.querySelector('button')!)!;
    list.innerHTML = LIST_ITEMS;
    expect(instance().resolveRef(ref)).toBe(list.querySelector('button'));
  });

  test('a changed name invalidates the ref', () => {
    document.body.innerHTML = '<ul id="list">' + LIST_ITEMS + '</ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    const ref = instance().refFor(list.querySelector('button')!)!;
    list.innerHTML = '<li><button>Alpha renamed</button></li><li><button>Beta</button></li>';
    expect(instance().resolveRefDetailed(ref)).toBeNull();
    expect(instance().resolveRef(ref)).toBeNull();
  });

  test('two candidates with the same tag path resolve to null', () => {
    document.body.innerHTML =
      '<ul id="list"><li><button>X</button></li><li><button>Go</button></li></ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    const ref = instance().refFor(list.querySelectorAll('button')[1])!;
    list.innerHTML =
      '<li><button>Go</button></li><li><button>Y</button></li><li><button>Go</button></li>';
    expect(instance().resolveRefDetailed(ref)).toBeNull();
  });

  test('sibling-index distance never picks among candidates with the same tag path', () => {
    document.body.innerHTML =
      '<ul id="list"><li><button>X</button></li><li><button>Go</button></li></ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    const ref = instance().refFor(list.querySelectorAll('button')[1])!;
    list.innerHTML =
      '<li><button>Y</button></li><li><button>Go</button></li>' +
      '<li><button>Z</button></li><li><button>Go</button></li>';
    expect(instance().resolveRefDetailed(ref)).toBeNull();
  });

  test('a removed row never rebinds its ref to the identically named button of the next row', () => {
    document.body.innerHTML =
      '<ul id="rows">' +
      ['r1', 'r2', 'r3', 'r4'].map((id) => `<li id="${id}"><button>Delete</button></li>`).join('') +
      '</ul>';
    evalExpr(buildObserverInstallJs());
    const ref = instance().refFor(document.querySelector('#r3 button')!)!;
    document.getElementById('r3')!.remove();
    expect(instance().resolveRefDetailed(ref)).toBeNull();
    expect(instance().resolveRef(ref)).toBeNull();
    expect(evalExpr(buildObserverRefResolveJs(ref))).toEqual({ ok: true, found: false });
  });

  test('a unique same-named button in a rebuilt list is re-resolved at another index', () => {
    document.body.innerHTML =
      '<ul id="list"><li><button>X</button></li><li><button>Go</button></li></ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    const ref = instance().refFor(list.querySelectorAll('button')[1])!;
    list.innerHTML =
      '<li><button>Y</button></li><li><button>Z</button></li><li><button>Go</button></li>';
    expect(instance().resolveRefDetailed(ref)).toEqual({
      el: list.querySelectorAll('button')[2],
      reresolved: true,
    });
  });

  test('the same role and name under a different tag path resolves to null', () => {
    document.body.innerHTML = '<div id="c"><span><button>Go</button></span></div>';
    evalExpr(buildObserverInstallJs());
    const c = document.getElementById('c')!;
    const ref = instance().refFor(c.querySelector('button')!)!;
    c.innerHTML = '<p><button>Go</button></p>';
    expect(instance().resolveRefDetailed(ref)).toBeNull();
  });

  test('a node replaced inside an open shadow root is re-resolved', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="bar"><button>Save</button></div>';
    evalExpr(buildObserverInstallJs());
    const ref = instance().refFor(root.querySelector('button')!)!;
    root.innerHTML = '<div class="bar"><button>Save</button></div>';
    expect(instance().resolveRefDetailed(ref)).toEqual({
      el: root.querySelector('button'),
      reresolved: true,
    });
  });

  test('a node replaced inside a closed shadow root created after install is re-resolved', () => {
    evalExpr(buildObserverInstallJs());
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<button>Save</button>';
    const ref = instance().refFor(root.querySelector('button')!)!;
    root.innerHTML = '<button>Save</button>';
    expect(instance().resolveRefDetailed(ref)).toEqual({
      el: root.querySelector('button'),
      reresolved: true,
    });
  });

  test('a node replaced inside a same-origin iframe is re-resolved', () => {
    document.body.innerHTML = '<iframe id="frame"></iframe>';
    const frameDoc = (document.getElementById('frame') as HTMLIFrameElement).contentDocument!;
    frameDoc.body.innerHTML = '<div class="bar"><button>Save</button></div>';
    evalExpr(buildObserverInstallJs());
    const old = frameDoc.querySelector('button')!;
    const ref = instance().refFor(old)!;
    frameDoc.body.innerHTML = '<div class="bar"><button>Save</button></div>';
    const fresh = frameDoc.querySelector('button')!;
    expect(fresh).not.toBe(old);
    expect(instance().resolveRefDetailed(ref)).toEqual({ el: fresh, reresolved: true });
    expect(instance().resolveRefDetailed(ref)).toEqual({ el: fresh, reresolved: false });
  });

  test('main-document re-resolution is unchanged when an iframe holds a same-named element', () => {
    document.body.innerHTML =
      '<div class="bar"><span><button>Save</button></span></div><iframe id="frame"></iframe>';
    const frameDoc = (document.getElementById('frame') as HTMLIFrameElement).contentDocument!;
    frameDoc.body.innerHTML = '<div class="bar"><button>Save</button></div>';
    evalExpr(buildObserverInstallJs());
    const bar = document.querySelector('.bar')!;
    const ref = instance().refFor(bar.querySelector('button')!)!;
    bar.innerHTML = '<span><button>Save</button></span>';
    expect(instance().resolveRefDetailed(ref)).toEqual({
      el: bar.querySelector('button'),
      reresolved: true,
    });
  });

  test('resolveRefDetailed never throws and is null for unknown refs and after teardown', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const g = instance();
    expect(g.resolveRefDetailed(undefined as unknown as string)).toBeNull();
    expect(g.resolveRefDetailed(tagged(999))).toBeNull();
    const ref = g.refFor(document.getElementById('go')!)!;
    g.teardown();
    expect(g.resolveRefDetailed(ref)).toBeNull();
  });
});

describe('page observer: semantic builders', () => {
  test('buildObserverRefResolveJs reports reresolved exactly once after a replacing re-render', () => {
    document.body.innerHTML = '<ul id="list">' + LIST_ITEMS + '</ul>';
    evalExpr(buildObserverInstallJs());
    const list = document.getElementById('list')!;
    const ref = instance().refFor(list.querySelector('button')!)!;
    list.innerHTML = LIST_ITEMS;
    expect(evalExpr(buildObserverRefResolveJs(ref))).toEqual({
      ok: true,
      found: true,
      tag: 'button',
      reresolved: true,
    });
    expect(evalExpr(buildObserverRefResolveJs(ref))).toEqual({
      ok: true,
      found: true,
      tag: 'button',
    });
  });

  test('buildObserverSemanticKeyJs returns the stored key, or null for an unknown ref', () => {
    document.body.innerHTML = '<button id="go" aria-label="Start">Go</button>';
    evalExpr(buildObserverInstallJs());
    const ref = instance().refFor(document.getElementById('go')!)!;
    expect(evalExpr(buildObserverSemanticKeyJs(ref))).toEqual({
      ok: true,
      key: {
        role: 'button',
        name: 'Start',
        path: [
          { tag: 'body', index: 1 },
          { tag: 'button', index: 1 },
        ],
      },
    });
    expect(evalExpr(buildObserverSemanticKeyJs(tagged(42)))).toEqual({ ok: true, key: null });
  });

  test('without an instance both builders report observer-unavailable', () => {
    const unavailable = { ok: false, reason: 'observer-unavailable' };
    expect(evalExpr(buildObserverRefResolveJs('k3x9ab:e1'))).toEqual(unavailable);
    expect(evalExpr(buildObserverSemanticKeyJs('k3x9ab:e1'))).toEqual(unavailable);
  });

  test('teardown clears the key registry', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    evalExpr(buildObserverInstallJs());
    const ref = instance().refFor(document.getElementById('go')!)!;
    expect(evalExpr<{ key: unknown }>(buildObserverSemanticKeyJs(ref)).key).not.toBeNull();
    evalExpr(buildObserverTeardownJs());
    evalExpr(buildObserverInstallJs());
    expect(evalExpr(buildObserverSemanticKeyJs(ref))).toEqual({ ok: true, key: null });
  });

  test('a hostile ref is embedded safely in the semantic key expression', () => {
    const hostile = 'e1' + String.fromCharCode(0x2028, 0x2029) + '</script>';
    const js = buildObserverSemanticKeyJs(hostile);
    expect(js).not.toContain(String.fromCharCode(0x2028));
    expect(js).not.toContain(String.fromCharCode(0x2029));
    expect(js).not.toContain('</script>');
    expect(evalExpr(js)).toEqual({ ok: false, reason: 'observer-unavailable' });
  });
});
