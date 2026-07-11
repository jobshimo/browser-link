import { beforeEach, describe, expect, test } from 'vitest';
import {
  buildClickResolveJs,
  buildFindJs,
  buildSnapshotJs,
  buildTypeResolveJs,
} from './builders.js';

/**
 * End-to-end tests for the actual expression strings background.ts ships to
 * CDP `Runtime.evaluate`. Each `build*Js` call returns a self-invoking
 * expression (`(() => { ... })()`); indirect eval executes it and yields
 * its completion value directly — the same thing CDP's `Runtime.evaluate`
 * returns for an expression with no trailing statement.
 */
const globalEval = eval;

function evalExpr<T = unknown>(source: string): T {
  return globalEval(source) as T;
}

/** jsdom never computes layout, so `offsetParent` is always null — the
 * `isVisible()` heuristic in dom-helpers.ts would filter out every element
 * in every test. Stub the getter per-element to opt it into "visible",
 * mirroring how a real browser reports offsetParent for a rendered element. */
function makeVisible(el: Element): void {
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
}

interface FindMatch {
  matched: true;
  selector: string;
  coords: { x: number; y: number };
  tag: string;
  text: string;
  frame?: string;
  ambiguous?: boolean;
}
interface FindNoMatch {
  matched: false;
  reason: string;
}
type FindResult = FindMatch | FindNoMatch;

interface SnapshotInteractiveEntry {
  tag: string;
  role: string;
  selector: string;
  text?: string;
  frame?: string;
  ambiguous?: boolean;
}
interface SnapshotResult {
  title: string;
  url: string;
  interactive: SnapshotInteractiveEntry[];
}

type ClickResolveResult =
  | { ok: true; x: number; y: number; tag: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'occluded'; blocker: string };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildFindJs -> buildClickResolveJs round trip (the core agent workflow)', () => {
  test('a selector found inside a shadow root resolves back to the same element via click', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Save changes</button>';
    const target = shadow.querySelector('button')!;
    makeVisible(target);

    const found = evalExpr<FindResult>(buildFindJs({ text: 'Save changes' }));
    expect(found.matched).toBe(true);
    if (!found.matched) return;
    expect(found.frame).toBeUndefined();

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: found.selector, force: false }),
    );
    expect(resolved.ok).toBe(true);
  });

  test('a selector found inside a same-origin iframe carries a frame field and resolves via click', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<button>Submit order</button>';
    const target = idoc.querySelector('button')!;
    makeVisible(target);

    const found = evalExpr<FindResult>(buildFindJs({ text: 'Submit order' }));
    expect(found.matched).toBe(true);
    if (!found.matched) return;
    expect(found.frame).toBeDefined();

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: found.selector, force: false }),
    );
    expect(resolved.ok).toBe(true);
  });

  test('not-found reason when the text does not match anything', () => {
    const found = evalExpr<FindResult>(buildFindJs({ text: 'nonexistent label xyz' }));
    expect(found).toEqual({ matched: false, reason: 'not-found' });
  });
});

describe('buildSnapshotJs — deep scan', () => {
  test('lists interactive elements from the top document and a shadow root, marks framed entries', () => {
    const topButton = document.createElement('button');
    topButton.textContent = 'Top level';
    document.body.appendChild(topButton);
    makeVisible(topButton);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="shadow-btn">In shadow</button>';
    makeVisible(shadow.getElementById('shadow-btn')!);

    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<button id="frame-btn">In frame</button>';
    makeVisible(idoc.getElementById('frame-btn')!);

    const snapshot = evalExpr<SnapshotResult>(buildSnapshotJs({}));
    const texts = snapshot.interactive.map((e) => e.text);
    expect(texts).toContain('Top level');
    expect(texts).toContain('In shadow');
    expect(texts).toContain('In frame');

    const framedEntry = snapshot.interactive.find((e) => e.text === 'In frame');
    expect(framedEntry?.frame).toBeDefined();
    const shadowEntry = snapshot.interactive.find((e) => e.text === 'In shadow');
    expect(shadowEntry?.frame).toBeUndefined();
  });

  test('within_selector resolves through the deep search scope too', () => {
    const host = document.createElement('div');
    host.id = 'panel-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<section id="panel"><button>Inside panel</button></section>';
    makeVisible(shadow.querySelector('button')!);

    const outside = document.createElement('button');
    outside.textContent = 'Outside panel';
    document.body.appendChild(outside);
    makeVisible(outside);

    const snapshot = evalExpr<SnapshotResult>(buildSnapshotJs({ within_selector: '#panel' }));
    const texts = snapshot.interactive.map((e) => e.text);
    expect(texts).toContain('Inside panel');
    expect(texts).not.toContain('Outside panel');
  });

  test('exclude pierces shadow boundaries: a shadow button whose host lives in <nav> is excluded', () => {
    // <nav> > <host with open shadow root> > <button>. A parentElement-only
    // climb dies at the shadow boundary (parentElement of the button is
    // null — its parentNode is the ShadowRoot) and the button would leak
    // into the snapshot despite exclude:['nav'].
    const nav = document.createElement('nav');
    document.body.appendChild(nav);
    const host = document.createElement('div');
    nav.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Nav shadow button</button>';
    makeVisible(shadow.querySelector('button')!);

    const outside = document.createElement('button');
    outside.textContent = 'Main content button';
    document.body.appendChild(outside);
    makeVisible(outside);

    const snapshot = evalExpr<SnapshotResult>(buildSnapshotJs({ exclude: ['nav'] }));
    const texts = snapshot.interactive.map((e) => e.text);
    expect(texts).not.toContain('Nav shadow button');
    expect(texts).toContain('Main content button');
  });

  test('structurally-identical twins in different shadow roots are flagged ambiguous', () => {
    // Two component instances with byte-identical shadow content: no CSS
    // selector can distinguish their internals (there is no root-scoping
    // syntax), so the entries must carry ambiguous:true — the signal that
    // the selector resolves first-match-wins and must not be cached.
    for (let i = 0; i < 2; i++) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<button>Twin</button>';
      makeVisible(shadow.querySelector('button')!);
    }

    const snapshot = evalExpr<SnapshotResult>(buildSnapshotJs({}));
    const twins = snapshot.interactive.filter((e) => e.text === 'Twin');
    expect(twins).toHaveLength(2);
    for (const twin of twins) {
      expect(twin.ambiguous).toBe(true);
    }
  });

  test('a uniquely-resolvable element does NOT carry the ambiguous flag', () => {
    const btn = document.createElement('button');
    btn.id = 'unique-btn';
    btn.textContent = 'One of a kind';
    document.body.appendChild(btn);
    makeVisible(btn);

    const snapshot = evalExpr<SnapshotResult>(buildSnapshotJs({}));
    const entry = snapshot.interactive.find((e) => e.text === 'One of a kind');
    expect(entry).toBeDefined();
    expect(entry?.ambiguous).toBeUndefined();
  });
});

describe('buildClickResolveJs — occlusion guard', () => {
  test('blocks the click and describes the covering element when force is false', () => {
    const target = document.createElement('button');
    target.id = 'save-btn';
    document.body.appendChild(target);
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    document.body.appendChild(overlay);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => overlay;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#save-btn', force: false }),
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok || resolved.reason !== 'occluded') throw new Error('expected occluded');
    expect(resolved.blocker).toContain('modal-backdrop');
  });

  test('force:true skips the occlusion check', () => {
    const target = document.createElement('button');
    target.id = 'save-btn';
    document.body.appendChild(target);
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    document.body.appendChild(overlay);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => overlay;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#save-btn', force: true }),
    );
    expect(resolved.ok).toBe(true);
  });

  test('not-found when the selector matches nothing anywhere in the deep search scope', () => {
    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#does-not-exist', force: false }),
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-found' });
  });

  test('hit-tests and dispatches at the FIRST client rect center of a line-wrapped inline element', () => {
    // Bounding-rect center of a wrapped link lands in the unpainted gap
    // between its two line boxes — hit-testing there reports whatever is
    // behind the link (false occlusion positive) and dispatching there
    // misses. Both the guard and the returned CDP coordinates must use the
    // first painted fragment instead, and they must be the SAME point.
    const link = document.createElement('a');
    link.id = 'wrapped-link';
    link.href = '#';
    document.body.appendChild(link);
    const rect1 = { left: 300, top: 100, width: 80, height: 16 } as DOMRect;
    const rect2 = { left: 0, top: 120, width: 40, height: 16 } as DOMRect;
    link.getClientRects = () => [rect1, rect2] as unknown as DOMRectList;
    link.getBoundingClientRect = () => ({ left: 0, top: 100, width: 380, height: 36 }) as DOMRect;

    const firstRectCenter = { x: 340, y: 108 };
    const gapCenter = { x: 190, y: 118 }; // bounding-rect center — in the inter-line gap
    const background = document.createElement('div');
    background.className = 'page-background';
    document.body.appendChild(background);
    const elementFromPoint = (x: number, y: number): Element =>
      x === firstRectCenter.x && y === firstRectCenter.y ? link : background;
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element }
    ).elementFromPoint = elementFromPoint;
    // Stub sanity: the old bounding-rect center point hits the background,
    // which would have blocked the click as a false occlusion positive.
    expect(elementFromPoint(gapCenter.x, gapCenter.y)).toBe(background);

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#wrapped-link', force: false }),
    );
    // Guard passes ONLY if the hit-test ran at the first-rect center; the
    // dispatch coordinates must be that same point (gapCenter would have
    // returned the background element and blocked).
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.x).toBe(firstRectCenter.x);
      expect(resolved.y).toBe(firstRectCenter.y);
    }
  });
});

describe('buildTypeResolveJs', () => {
  test('focuses an input nested in a shadow root and reports success', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="email" value="old" />';

    const focused = evalExpr<boolean>(buildTypeResolveJs({ selector: '#email', clear: false }));
    expect(focused).toBe(true);
    expect((shadow.getElementById('email') as HTMLInputElement).value).toBe('old');
  });

  test('clear:true empties the value before returning', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="email" value="old" />';

    const focused = evalExpr<boolean>(buildTypeResolveJs({ selector: '#email', clear: true }));
    expect(focused).toBe(true);
    expect((shadow.getElementById('email') as HTMLInputElement).value).toBe('');
  });

  test('false when the selector matches nothing', () => {
    const focused = evalExpr<boolean>(
      buildTypeResolveJs({ selector: '#does-not-exist', clear: false }),
    );
    expect(focused).toBe(false);
  });
});
