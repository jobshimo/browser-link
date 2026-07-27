import { beforeEach, describe, expect, test } from 'vitest';
import { DEEP_QUERY_JS } from './deep-query.js';

/**
 * `DEEP_QUERY_JS` is a raw string of `function` declarations — the exact
 * source injected into the page via CDP `Runtime.evaluate`. We test it by
 * evaluating that exact string with INDIRECT eval, which (per spec) always
 * runs as non-strict global code regardless of this test file's own
 * strictness — so the top-level `function` declarations become bindings on
 * `globalThis`, exactly like they become bindings in the page's global
 * scope when CDP injects them. No test-only rewriting of the shipped
 * source is needed.
 */
const globalEval = eval;

interface DeepQueryGlobals {
  deepQueryAll: (selector: string, start?: Document | Element) => Element[];
  deepQueryFirst: (selector: string, start?: Document | Element) => Element | null;
  deepWalkAll: (callback: (el: Element) => void, start?: Document | Element) => void;
  frameElementChain: (el: Element) => HTMLIFrameElement[];
  viewportCenterOf: (el: Element) => { x: number; y: number; localX: number; localY: number };
  composedContains: (ancestor: Node, node: Node) => boolean;
  describeElement: (el: Element | null) => string;
  checkOcclusion: (
    target: Element,
    localX: number,
    localY: number,
  ) => { allowed: true; hit?: string } | { allowed: false; blocker: string };
}

function loadDeepQuery(): DeepQueryGlobals {
  globalEval(DEEP_QUERY_JS);
  return globalThis as unknown as DeepQueryGlobals;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('deepQueryAll / deepQueryFirst — shadow DOM', () => {
  test('finds an element inside a single open shadow root', () => {
    const { deepQueryAll, deepQueryFirst } = loadDeepQuery();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="inner">Click me</button>';

    const all = deepQueryAll('#inner');
    expect(all).toHaveLength(1);
    expect(deepQueryFirst('#inner')).toBe(shadow.getElementById('inner'));
  });

  test('finds an element inside nested open shadow roots (shadow inside shadow)', () => {
    const { deepQueryFirst } = loadDeepQuery();
    const outerHost = document.createElement('div');
    document.body.appendChild(outerHost);
    const outerShadow = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('div');
    outerShadow.appendChild(innerHost);
    const innerShadow = innerHost.attachShadow({ mode: 'open' });
    innerShadow.innerHTML = '<span id="deep">deep text</span>';

    const found = deepQueryFirst('#deep');
    expect(found).not.toBeNull();
    expect(found).toBe(innerShadow.getElementById('deep'));
  });

  test('returns no matches for content inside a CLOSED shadow root', () => {
    const { deepQueryAll, deepQueryFirst } = loadDeepQuery();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const closedShadow = host.attachShadow({ mode: 'closed' });
    closedShadow.innerHTML = '<button id="hidden-from-cdp">nope</button>';

    expect(deepQueryAll('#hidden-from-cdp')).toHaveLength(0);
    expect(deepQueryFirst('#hidden-from-cdp')).toBeNull();
  });
});

describe('deepQueryAll / deepQueryFirst — same-origin iframes', () => {
  test('finds an element inside a same-origin iframe document', () => {
    const { deepQueryFirst } = loadDeepQuery();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument;
    expect(idoc).not.toBeNull();
    idoc!.body.innerHTML = '<button id="in-frame">frame button</button>';

    const found = deepQueryFirst('#in-frame');
    expect(found).not.toBeNull();
    expect(found).toBe(idoc!.getElementById('in-frame'));
  });

  test('finds a shadow root nested inside a same-origin iframe', () => {
    const { deepQueryFirst } = loadDeepQuery();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    const host = idoc.createElement('div');
    idoc.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="frame-shadow-btn">nested</button>';

    const found = deepQueryFirst('#frame-shadow-btn');
    expect(found).toBe(shadow.getElementById('frame-shadow-btn'));
  });

  test('does not throw when a frame document is inaccessible (e.g. cross-origin)', () => {
    const { deepQueryAll } = loadDeepQuery();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    // Simulate a cross-origin frame: accessing contentDocument throws.
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new DOMException('Blocked a frame with origin from accessing a cross-origin frame');
      },
    });
    const other = document.createElement('button');
    other.id = 'reachable';
    document.body.appendChild(other);

    expect(() => deepQueryAll('#reachable')).not.toThrow();
    expect(deepQueryAll('#reachable')).toHaveLength(1);
  });
});

describe('deepWalkAll', () => {
  test('visits elements across the top document and every open shadow root', () => {
    const { deepWalkAll } = loadDeepQuery();
    const host = document.createElement('div');
    host.id = 'host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p id="shadow-p">hi</p>';

    const seenIds: string[] = [];
    deepWalkAll((el) => {
      if (el.id) seenIds.push(el.id);
    });

    expect(seenIds).toContain('host');
    expect(seenIds).toContain('shadow-p');
  });
});

describe('viewportCenterOf — coordinate offset accumulation', () => {
  test('a top-document element has no offset: x/y equal localX/localY', () => {
    const { viewportCenterOf } = loadDeepQuery();
    const el = document.createElement('button');
    document.body.appendChild(el);
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 20, height: 10 }) as DOMRect;

    const center = viewportCenterOf(el);
    expect(center.localX).toBe(110);
    expect(center.localY).toBe(55);
    expect(center.x).toBe(110);
    expect(center.y).toBe(55);
  });

  test('accumulates ancestor iframe rect offsets for an element inside one iframe', () => {
    const { viewportCenterOf } = loadDeepQuery();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.getBoundingClientRect = () =>
      ({ left: 200, top: 300, width: 400, height: 400 }) as DOMRect;
    const idoc = iframe.contentDocument!;
    const el = idoc.createElement('button');
    idoc.body.appendChild(el);
    el.getBoundingClientRect = () => ({ left: 10, top: 20, width: 30, height: 10 }) as DOMRect;

    const center = viewportCenterOf(el);
    // local center within the iframe's own viewport.
    expect(center.localX).toBe(25);
    expect(center.localY).toBe(25);
    // top-level center adds the iframe's own rect offset.
    expect(center.x).toBe(200 + 25);
    expect(center.y).toBe(300 + 25);
  });

  test('accumulates offsets across nested iframes (iframe inside iframe)', () => {
    const { viewportCenterOf } = loadDeepQuery();
    const outerFrame = document.createElement('iframe');
    document.body.appendChild(outerFrame);
    outerFrame.getBoundingClientRect = () =>
      ({ left: 50, top: 60, width: 500, height: 500 }) as DOMRect;
    const outerDoc = outerFrame.contentDocument!;

    const innerFrame = outerDoc.createElement('iframe');
    outerDoc.body.appendChild(innerFrame);
    innerFrame.getBoundingClientRect = () =>
      ({ left: 15, top: 25, width: 200, height: 200 }) as DOMRect;
    const innerDoc = innerFrame.contentDocument!;

    const el = innerDoc.createElement('button');
    innerDoc.body.appendChild(el);
    el.getBoundingClientRect = () => ({ left: 5, top: 5, width: 10, height: 10 }) as DOMRect;

    const center = viewportCenterOf(el);
    expect(center.localX).toBe(10);
    expect(center.localY).toBe(10);
    expect(center.x).toBe(50 + 15 + 10);
    expect(center.y).toBe(60 + 25 + 10);
  });

  test('shadow DOM introduces no coordinate offset', () => {
    const { viewportCenterOf } = loadDeepQuery();
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.getBoundingClientRect = () => ({ left: 999, top: 999, width: 0, height: 0 }) as DOMRect;
    const shadow = host.attachShadow({ mode: 'open' });
    const el = document.createElement('button');
    shadow.appendChild(el);
    el.getBoundingClientRect = () => ({ left: 40, top: 15, width: 10, height: 10 }) as DOMRect;

    const center = viewportCenterOf(el);
    expect(center.x).toBe(45);
    expect(center.y).toBe(20);
  });

  test('adds iframe border and padding on top of the bounding rect (content-box viewport origin)', () => {
    // getBoundingClientRect() on an <iframe> returns the BORDER box, but
    // the embedded document's viewport starts at the CONTENT box — a
    // styled iframe (border and/or padding) shifts every inner coordinate
    // by border+padding. The earlier tests mock only left/top, which is
    // exactly what hid this bug.
    const { viewportCenterOf } = loadDeepQuery();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.getBoundingClientRect = () =>
      ({ left: 200, top: 300, width: 400, height: 400 }) as DOMRect;
    // clientLeft/clientTop = border widths (jsdom computes no layout, so
    // stub them); padding via inline style so getComputedStyle sees it.
    Object.defineProperty(iframe, 'clientLeft', { value: 3, configurable: true });
    Object.defineProperty(iframe, 'clientTop', { value: 5, configurable: true });
    iframe.style.paddingLeft = '4px';
    iframe.style.paddingTop = '2px';

    const idoc = iframe.contentDocument!;
    const el = idoc.createElement('button');
    idoc.body.appendChild(el);
    el.getBoundingClientRect = () => ({ left: 10, top: 20, width: 30, height: 10 }) as DOMRect;

    const center = viewportCenterOf(el);
    expect(center.localX).toBe(25);
    expect(center.localY).toBe(25);
    // top-level = frame border-box rect + border + padding + local center.
    expect(center.x).toBe(200 + 3 + 4 + 25);
    expect(center.y).toBe(300 + 5 + 2 + 25);
  });

  test('accumulates border+padding across nested iframes', () => {
    const { viewportCenterOf } = loadDeepQuery();
    const outerFrame = document.createElement('iframe');
    document.body.appendChild(outerFrame);
    outerFrame.getBoundingClientRect = () =>
      ({ left: 50, top: 60, width: 500, height: 500 }) as DOMRect;
    Object.defineProperty(outerFrame, 'clientLeft', { value: 2, configurable: true });
    Object.defineProperty(outerFrame, 'clientTop', { value: 2, configurable: true });
    outerFrame.style.paddingLeft = '6px';
    outerFrame.style.paddingTop = '8px';
    const outerDoc = outerFrame.contentDocument!;

    const innerFrame = outerDoc.createElement('iframe');
    outerDoc.body.appendChild(innerFrame);
    innerFrame.getBoundingClientRect = () =>
      ({ left: 15, top: 25, width: 200, height: 200 }) as DOMRect;
    Object.defineProperty(innerFrame, 'clientLeft', { value: 1, configurable: true });
    Object.defineProperty(innerFrame, 'clientTop', { value: 1, configurable: true });
    const innerDoc = innerFrame.contentDocument!;

    const el = innerDoc.createElement('button');
    innerDoc.body.appendChild(el);
    el.getBoundingClientRect = () => ({ left: 5, top: 5, width: 10, height: 10 }) as DOMRect;

    const center = viewportCenterOf(el);
    expect(center.x).toBe(50 + 2 + 6 + 15 + 1 + 10);
    expect(center.y).toBe(60 + 2 + 8 + 25 + 1 + 10);
  });

  test('uses the FIRST client rect for a line-wrapped inline element, not the bounding-rect center', () => {
    // For a link wrapped across two lines the bounding rect spans both
    // line boxes and its center can land in the unpainted gap between
    // them. The click point must be the center of the first painted
    // fragment — and localX/localY and x/y must be the SAME point so the
    // occlusion hit-test and the CDP dispatch never disagree.
    const { viewportCenterOf } = loadDeepQuery();
    const el = document.createElement('a');
    document.body.appendChild(el);
    const rect1 = { left: 300, top: 100, width: 80, height: 16 } as DOMRect;
    const rect2 = { left: 0, top: 120, width: 40, height: 16 } as DOMRect;
    el.getClientRects = () => [rect1, rect2] as unknown as DOMRectList;
    el.getBoundingClientRect = () => ({ left: 0, top: 100, width: 380, height: 36 }) as DOMRect;

    const center = viewportCenterOf(el);
    expect(center.localX).toBe(340); // center of rect1, not of the union box
    expect(center.localY).toBe(108);
    expect(center.x).toBe(center.localX);
    expect(center.y).toBe(center.localY);
  });

  test('falls back to the bounding rect when getClientRects is empty', () => {
    const { viewportCenterOf } = loadDeepQuery();
    const el = document.createElement('button');
    document.body.appendChild(el);
    el.getClientRects = () => [] as unknown as DOMRectList;
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 20, height: 10 }) as DOMRect;

    const center = viewportCenterOf(el);
    expect(center.x).toBe(110);
    expect(center.y).toBe(55);
  });
});

describe('checkOcclusion', () => {
  function withElementFromPoint(root: Document, returnEl: Element | null): void {
    (
      root as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
    ).elementFromPoint = () => returnEl;
  }

  test('allowed when the hit-tested element IS the target', () => {
    const { checkOcclusion } = loadDeepQuery();
    const target = document.createElement('button');
    document.body.appendChild(target);
    withElementFromPoint(document, target);

    expect(checkOcclusion(target, 5, 5)).toEqual({ allowed: true });
  });

  test('allowed when the hit-tested element is a descendant of the target (own child hit)', () => {
    const { checkOcclusion } = loadDeepQuery();
    const target = document.createElement('button');
    const icon = document.createElement('span');
    target.appendChild(icon);
    document.body.appendChild(target);
    withElementFromPoint(document, icon);

    expect(checkOcclusion(target, 5, 5)).toEqual({ allowed: true });
  });

  test('allowed when the hit-tested element is an ancestor overlay containing the target, surfacing it as the true recipient', () => {
    const { checkOcclusion } = loadDeepQuery();
    const wrapper = document.createElement('div');
    const target = document.createElement('button');
    wrapper.appendChild(target);
    document.body.appendChild(wrapper);
    withElementFromPoint(document, wrapper);

    // The click will target the ancestor, never the element itself (events
    // bubble upward, not down) — allowed as before, but `hit` names the
    // real recipient so click results can report it.
    expect(checkOcclusion(target, 5, 5)).toEqual({ allowed: true, hit: 'div' });
  });

  test('blocked when an unrelated overlay covers the target, with a covering-element descriptor', () => {
    const { checkOcclusion } = loadDeepQuery();
    const target = document.createElement('button');
    target.id = 'save-btn';
    document.body.appendChild(target);
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop dimmed';
    document.body.appendChild(overlay);
    withElementFromPoint(document, overlay);

    const result = checkOcclusion(target, 5, 5);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.blocker).toBe('div.modal-backdrop.dimmed');
    }
  });

  test('fails open when elementFromPoint returns nothing', () => {
    const { checkOcclusion } = loadDeepQuery();
    const target = document.createElement('button');
    document.body.appendChild(target);
    withElementFromPoint(document, null);

    expect(checkOcclusion(target, 5, 5)).toEqual({ allowed: true });
  });

  test('ALLOWED with hit: a pointer-events:none target whose sibling takes the hit is retargeted, not blocked', () => {
    // The Articulate Storyline shape: an invisible a11y element stacked
    // over the visual control, whose real hit-target is a SIBLING — what
    // a real user click at this exact point activates, not a blocker.
    const { checkOcclusion } = loadDeepQuery();
    const target = document.createElement('div');
    target.id = 'acc-42';
    target.style.pointerEvents = 'none';
    document.body.appendChild(target);
    const hitTarget = document.createElement('div');
    hitTarget.id = 'hit-target';
    hitTarget.className = 'slide-object';
    document.body.appendChild(hitTarget);
    withElementFromPoint(document, hitTarget);

    expect(checkOcclusion(target, 5, 5)).toEqual({
      allowed: true,
      hit: 'div#hit-target.slide-object',
    });
  });

  test('a descendant hit on a pointer-events:none target stays a plain allowed (no hit field)', () => {
    // The click bubbles through the target — the descendant branch must
    // win over the pointer-events retarget branch.
    const { checkOcclusion } = loadDeepQuery();
    const target = document.createElement('div');
    target.style.pointerEvents = 'none';
    document.body.appendChild(target);
    const child = document.createElement('button');
    child.style.pointerEvents = 'auto';
    target.appendChild(child);
    withElementFromPoint(document, child);

    expect(checkOcclusion(target, 5, 5)).toEqual({ allowed: true });
  });
});

describe('checkOcclusion — shadow root and iframe hit-test paths', () => {
  // jsdom implements elementFromPoint on NOTHING (Document included), so
  // without explicit stubs every path in hitTestDeep would silently pass
  // via the fail-open branch. These stubs make the deep code paths run
  // for real: the shadow-root start, the iframe-document start, and the
  // nested-shadow descent loop.
  function stubElementFromPoint(root: Node, impl: (x: number, y: number) => Element | null): void {
    Object.defineProperty(root, 'elementFromPoint', { value: impl, configurable: true });
  }

  test('BLOCKED: target in an open shadow root, covered by a sibling overlay in the same root', () => {
    const { checkOcclusion } = loadDeepQuery();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<button id="save">Save</button><div id="veil" class="shadow-overlay"></div>';
    const target = shadow.getElementById('save')!;
    const veil = shadow.getElementById('veil')!;
    // checkOcclusion starts from target.getRootNode() — the ShadowRoot.
    stubElementFromPoint(shadow, () => veil);

    const result = checkOcclusion(target, 5, 5);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.blocker).toBe('div#veil.shadow-overlay');
    }
  });

  test('ALLOWED: target in an open shadow root, hit lands on the target itself', () => {
    const { checkOcclusion } = loadDeepQuery();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="save">Save</button>';
    const target = shadow.getElementById('save')!;
    stubElementFromPoint(shadow, () => target);

    expect(checkOcclusion(target, 5, 5)).toEqual({ allowed: true });
  });

  test('BLOCKED: nested-shadow descent — the document hit is a host whose shadow content covers the point', () => {
    const { checkOcclusion } = loadDeepQuery();
    const target = document.createElement('button');
    target.id = 'buy';
    document.body.appendChild(target);
    const overlayHost = document.createElement('cookie-banner');
    document.body.appendChild(overlayHost);
    const overlayShadow = overlayHost.attachShadow({ mode: 'open' });
    overlayShadow.innerHTML = '<div id="consent" class="backdrop"></div>';
    const inner = overlayShadow.getElementById('consent')!;
    // document.elementFromPoint reports the composed-tree TOP-LEVEL node —
    // the host — and hitTestDeep must descend into its shadow root.
    stubElementFromPoint(document, () => overlayHost);
    stubElementFromPoint(overlayShadow, () => inner);

    const result = checkOcclusion(target, 5, 5);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // The descriptor names the INNER shadow element — proof the descent
      // loop actually ran instead of stopping at the host.
      expect(result.blocker).toBe('div#consent.backdrop');
    }
  });

  test('ALLOWED: nested-shadow descent into a component that is a child of the target', () => {
    const { checkOcclusion } = loadDeepQuery();
    const target = document.createElement('button');
    document.body.appendChild(target);
    const iconHost = document.createElement('fancy-icon');
    target.appendChild(iconHost);
    const iconShadow = iconHost.attachShadow({ mode: 'open' });
    iconShadow.innerHTML = '<svg id="glyph"></svg>';
    const glyph = iconShadow.getElementById('glyph')!;
    stubElementFromPoint(document, () => iconHost);
    stubElementFromPoint(iconShadow, () => glyph);

    // The hit is the icon's shadow-internal <svg>; composed-tree
    // containment (glyph -> shadow root -> iconHost -> target) makes it
    // part of the target, so the click is legitimate.
    expect(checkOcclusion(target, 5, 5)).toEqual({ allowed: true });
  });

  test('BLOCKED: target inside a same-origin iframe, covered by an overlay in that iframe', () => {
    const { checkOcclusion } = loadDeepQuery();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML =
      '<button id="submit">Submit</button><div id="spinner" class="loading-overlay"></div>';
    const target = idoc.getElementById('submit')!;
    const spinner = idoc.getElementById('spinner')!;
    // checkOcclusion starts from target.getRootNode() — the iframe's own
    // document, in the iframe's own (local) coordinates.
    stubElementFromPoint(idoc, () => spinner);

    const result = checkOcclusion(target, 5, 5);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.blocker).toBe('div#spinner.loading-overlay');
    }
  });

  test('ALLOWED: target inside a same-origin iframe, hit lands on the target', () => {
    const { checkOcclusion } = loadDeepQuery();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<button id="submit">Submit</button>';
    const target = idoc.getElementById('submit')!;
    stubElementFromPoint(idoc, () => target);

    expect(checkOcclusion(target, 5, 5)).toEqual({ allowed: true });
  });
});

describe('composedContains', () => {
  test('an element contains itself', () => {
    const { composedContains } = loadDeepQuery();
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(composedContains(el, el)).toBe(true);
  });

  test('true when node is a light-DOM descendant of ancestor', () => {
    const { composedContains } = loadDeepQuery();
    const ancestor = document.createElement('div');
    const child = document.createElement('span');
    const grandchild = document.createElement('b');
    child.appendChild(grandchild);
    ancestor.appendChild(child);
    document.body.appendChild(ancestor);

    expect(composedContains(ancestor, grandchild)).toBe(true);
    expect(composedContains(ancestor, child)).toBe(true);
  });

  test('false for two unrelated elements (neither contains the other)', () => {
    const { composedContains } = loadDeepQuery();
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    expect(composedContains(a, b)).toBe(false);
    expect(composedContains(b, a)).toBe(false);
  });

  test('false when the argument order is reversed (descendant does not contain ancestor)', () => {
    const { composedContains } = loadDeepQuery();
    const ancestor = document.createElement('div');
    const child = document.createElement('span');
    ancestor.appendChild(child);
    document.body.appendChild(ancestor);
    expect(composedContains(child, ancestor)).toBe(false);
  });

  test('crosses a shadow boundary — a shadow-hosted node is contained by the host', () => {
    const { composedContains } = loadDeepQuery();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    shadow.appendChild(inner);

    // Node.contains() would return false here (it does not pierce shadow
    // boundaries); composedContains walks the COMPOSED tree via the host.
    expect(composedContains(host, inner)).toBe(true);
    expect(host.contains(inner)).toBe(false);
  });
});
