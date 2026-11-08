import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  OBSERVER_BINDING,
  OBSERVER_VERSION,
  buildObserverChangesJs,
  buildObserverInstallJs,
  buildObserverMarkJs,
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
