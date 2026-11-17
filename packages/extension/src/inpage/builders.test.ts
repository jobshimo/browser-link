import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  FIND_CUT_HINT,
  NOT_WALKED_NOTE,
  PASSWORD_VALUES_HIDDEN_NOTE,
  SNAPSHOT_CUT_HINT,
  SNAPSHOT_NOT_COMPARED_HINT,
  SNAPSHOT_NOT_COMPARED_TEXT_HINT,
  UNOBSERVED_FRAMES_HINT,
  UNOBSERVED_SHADOW_HINT,
  buildClickAimJs,
  buildClickHitCheckJs,
  buildClickResolveJs,
  buildDragProbeJs,
  buildFrameWatchReadJs,
  buildFrameWatchStartJs,
  clickMissedMessage,
  buildElementRectJs,
  buildExpectProbeJs,
  buildFindJs,
  buildFocusJs,
  buildFocusedFieldJs,
  buildProgrammaticClickJs,
  buildSettleJs,
  buildSnapshotJs,
  buildStateJs,
  buildTypeResolveJs,
  buildWaitForSelectorJs,
} from './builders.js';
import {
  OBSERVER_BINDING,
  OBSERVER_GLOBAL,
  buildObserverInstallJs,
  buildObserverTeardownJs,
} from './observer.js';
import baselineFixture from './builders.baseline.fixture.json';

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

/** jsdom has no layout: every element answers `getClientRects()` with an
 * empty list and `getBoundingClientRect()` with zeros, which is what Chrome
 * answers only for an element that is not rendered (display:none, inside a
 * display:none ancestor, an <option> of a closed <select>). A rendered
 * element has at least one client rect, so the click tests give their
 * targets one; a test that leaves a target without it models an element
 * with no box. */
function giveBox(
  el: Element,
  box: { left: number; top: number; width: number; height: number } = {
    left: 100,
    top: 200,
    width: 80,
    height: 20,
  },
): void {
  const rect = {
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
  } as DOMRect;
  el.getClientRects = () => [rect] as unknown as DOMRectList;
  el.getBoundingClientRect = () => rect;
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
interface NearMiss {
  text: string;
  selector: string;
  role?: string;
}
interface FindNoMatch {
  matched: false;
  reason: string;
  error?: string;
  near_misses?: NearMiss[];
  candidates?: { selector: string; text: string; tag: string }[];
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
  | { ok: true; x: number; y: number; tag: string; hit_element?: string }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'occluded'; blocker: string }
  | { ok: false; reason: 'retargeted'; hit_element: string };

type TypeResolveResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' };

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
    giveBox(target);

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
    giveBox(target);

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

describe('buildFindJs — near-miss suggestions on not-found', () => {
  test('omits near_misses entirely when nothing plausible is on the page', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Completely unrelated label';
    document.body.appendChild(btn);
    makeVisible(btn);

    const found = evalExpr<FindResult>(buildFindJs({ text: 'zzz-nomatch-zzz' }));
    expect(found).toEqual({ matched: false, reason: 'not-found' });
  });

  test('ranks a substring-containment candidate above a token-overlap-only candidate (exact:true so a containing-but-not-equal element misses the primary scan)', () => {
    // With exact:true the primary scan requires an EXACT text match, so an
    // element that merely CONTAINS the needle never becomes a `matches`
    // entry — it only surfaces through the near-miss ranker, which always
    // checks containment regardless of `exact`. That is what makes the
    // containment tier reachable at all in the no-role branch (without
    // exact:true, anything containing the needle would already be a
    // primary match and the not-found branch would never run).
    const overlapOnly = document.createElement('button');
    overlapOnly.textContent = 'changes saved to disk';
    document.body.appendChild(overlapOnly);
    makeVisible(overlapOnly);

    const containment = document.createElement('button');
    containment.textContent = 'Save changes now';
    document.body.appendChild(containment);
    makeVisible(containment);

    const found = evalExpr<FindResult>(buildFindJs({ text: 'Save changes', exact: true }));
    expect(found.matched).toBe(false);
    if (found.matched) return;
    expect(found.near_misses).toBeDefined();
    expect(found.near_misses?.[0]?.text).toBe('Save changes now');
    expect(found.near_misses?.length).toBeLessThanOrEqual(3);
  });

  test('near_misses caps at 3 candidates and only considers VISIBLE elements', () => {
    for (let i = 0; i < 5; i++) {
      const btn = document.createElement('button');
      btn.textContent = 'Save item ' + i;
      document.body.appendChild(btn);
      makeVisible(btn);
    }
    const hidden = document.createElement('button');
    hidden.textContent = 'Save hidden item';
    document.body.appendChild(hidden);
    // Not marked visible — offsetParent stays null, isVisible() must drop it.

    // exact:true so "Save item N" (contains, not equal) stays out of the
    // primary match scan — see the containment-tier test above for why.
    const found = evalExpr<FindResult>(buildFindJs({ text: 'Save', exact: true }));
    expect(found.matched).toBe(false);
    if (found.matched) return;
    expect(found.near_misses).toHaveLength(3);
    for (const nm of found.near_misses ?? []) {
      expect(nm.text).not.toBe('Save hidden item');
    }
  });

  test('role exclusion: text matched broadly but not within the requested role names it explicitly', () => {
    const div = document.createElement('div');
    div.setAttribute('onclick', 'void 0');
    div.textContent = 'GIF picker';
    document.body.appendChild(div);
    makeVisible(div);

    const found = evalExpr<FindResult>(buildFindJs({ text: 'GIF picker', role: 'button' }));
    expect(found.matched).toBe(false);
    if (found.matched) return;
    expect(found.reason).toBe('not-found');
    expect(found.error).toContain('text matched 1 element but none with role "button"');
    expect(found.error).toContain('GIF picker');
    expect(found.near_misses).toBeDefined();
    expect(found.near_misses?.[0]?.selector).toBeTruthy();
  });

  test('role provided, no exact substring match anywhere: falls back to token-overlap near-miss ranking, no error field', () => {
    // A token-overlap-only candidate (no full substring containment
    // anywhere on the page) must NOT trigger the role-exclusion error path
    // — that path is reserved for text that fully matched broadly.
    const link = document.createElement('a');
    link.textContent = 'Changes list';
    document.body.appendChild(link);
    makeVisible(link);

    const found = evalExpr<FindResult>(buildFindJs({ text: 'Save changes', role: 'checkbox' }));
    expect(found.matched).toBe(false);
    if (found.matched) return;
    expect(found.error).toBeUndefined();
    expect(found.near_misses?.[0]?.text).toBe('Changes list');
  });
});

describe('buildFindJs — pointer-events gate on candidates', () => {
  test('skips a pointer-events:none twin and matches the real clickable element uniquely (no multiple-matches)', () => {
    // Same visible text on an invisible a11y-layer button AND the real
    // control — without the gate this would be a multiple-matches miss.
    const acc = document.createElement('button');
    acc.textContent = 'Continue';
    acc.style.pointerEvents = 'none';
    document.body.appendChild(acc);
    makeVisible(acc);

    const real = document.createElement('button');
    real.id = 'continue-btn';
    real.textContent = 'Continue';
    document.body.appendChild(real);
    makeVisible(real);

    const found = evalExpr<FindResult>(buildFindJs({ text: 'Continue' }));
    expect(found.matched).toBe(true);
    if (!found.matched) return;
    expect(document.querySelector(found.selector)).toBe(real);
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

describe('buildSnapshotJs — pointer-events gate on the interactive list', () => {
  interface SnapshotWithHeadings extends SnapshotResult {
    headings?: { level: string; text: string }[];
  }

  test('excludes a pointer-events:none element from interactive but keeps heading text (labels are not lost)', () => {
    const acc = document.createElement('button');
    acc.textContent = 'A11y layer button';
    acc.style.pointerEvents = 'none';
    document.body.appendChild(acc);
    makeVisible(acc);

    const heading = document.createElement('h2');
    heading.textContent = 'Slide title';
    heading.style.pointerEvents = 'none';
    document.body.appendChild(heading);
    makeVisible(heading);

    const snapshot = evalExpr<SnapshotWithHeadings>(buildSnapshotJs({}));
    expect(snapshot.interactive.map((e) => e.text)).not.toContain('A11y layer button');
    // Headings keep plain isVisible — non-interactive text is not lost.
    expect(snapshot.headings?.map((h) => h.text)).toContain('Slide title');
  });

  test('includes a pointer-events:auto element inside a none wrapper (per-element check, not a subtree prune)', () => {
    const wrapper = document.createElement('div');
    wrapper.style.pointerEvents = 'none';
    document.body.appendChild(wrapper);
    const btn = document.createElement('button');
    btn.textContent = 'Re-enabled child';
    btn.style.pointerEvents = 'auto';
    wrapper.appendChild(btn);
    makeVisible(btn);

    const snapshot = evalExpr<SnapshotResult>(buildSnapshotJs({}));
    expect(snapshot.interactive.map((e) => e.text)).toContain('Re-enabled child');
  });
});

describe('buildClickResolveJs — occlusion guard', () => {
  test('blocks the click and describes the covering element when force is false', () => {
    const target = document.createElement('button');
    target.id = 'save-btn';
    document.body.appendChild(target);
    giveBox(target);
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

  test('force:true skips the block but still reports the covering element as hit_element', () => {
    const target = document.createElement('button');
    target.id = 'save-btn';
    document.body.appendChild(target);
    giveBox(target);
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    document.body.appendChild(overlay);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => overlay;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#save-btn', force: true }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      // Force skips the BLOCK, not the truth-telling — a forced click
      // dispatched onto an unrelated element must not look like success.
      expect(resolved.hit_element).toBe('div.modal-backdrop');
    }
  });

  test('retargets a pointer-events:none target: ok with hit_element naming the real recipient, not an occlusion error', () => {
    const acc = document.createElement('div');
    acc.id = 'acc-1';
    acc.style.pointerEvents = 'none';
    document.body.appendChild(acc);
    giveBox(acc);
    const hitTarget = document.createElement('div');
    hitTarget.id = 'hit-layer';
    document.body.appendChild(hitTarget);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => hitTarget;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#acc-1', force: false }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.hit_element).toBe('div#hit-layer');
    }
  });

  test('fails as retargeted when the hit-test lands on an ancestor of a clickable target (clipped by an overflow container)', () => {
    // A button scrolled out of its overflow:hidden container's clip: its
    // centre is painted over by the container itself, so a click there
    // lands on the container and never reaches the button.
    const scroller = document.createElement('div');
    scroller.className = 'scroller';
    scroller.style.overflow = 'hidden';
    document.body.appendChild(scroller);
    const target = document.createElement('button');
    target.id = 'clipped-btn';
    scroller.appendChild(target);
    giveBox(target);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => scroller;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#clipped-btn', force: false }),
    );
    expect(resolved).toEqual({ ok: false, reason: 'retargeted', hit_element: 'div.scroller' });
  });

  test('force:true dispatches a retargeted click anyway and reports the ancestor as hit_element', () => {
    const scroller = document.createElement('div');
    scroller.className = 'scroller';
    scroller.style.overflow = 'hidden';
    document.body.appendChild(scroller);
    const target = document.createElement('button');
    target.id = 'clipped-btn';
    scroller.appendChild(target);
    giveBox(target);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => scroller;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#clipped-btn', force: true }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.tag).toBe('button');
      expect(resolved.hit_element).toBe('div.scroller');
    }
  });

  test('keeps a pointer-events:none icon inside its button allowed: ok with the button as hit_element', () => {
    const button = document.createElement('button');
    button.id = 'save-btn';
    document.body.appendChild(button);
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.style.pointerEvents = 'none';
    button.appendChild(icon);
    giveBox(icon);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => button;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#save-btn .icon', force: false }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.hit_element).toBe('button#save-btn');
    }
  });

  test('omits hit_element when the hit-test lands on a descendant of the target', () => {
    const button = document.createElement('button');
    button.id = 'save-btn';
    document.body.appendChild(button);
    giveBox(button);
    const label = document.createElement('span');
    label.textContent = 'Save';
    button.appendChild(label);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => label;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#save-btn', force: false }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.hit_element).toBeUndefined();
    }
  });

  test('omits hit_element when the hit-test lands on the target itself', () => {
    const target = document.createElement('button');
    target.id = 'save-btn';
    document.body.appendChild(target);
    giveBox(target);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => target;

    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#save-btn', force: false }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.hit_element).toBeUndefined();
    }
  });

  test('not-found when the selector matches nothing anywhere in the deep search scope', () => {
    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: '#does-not-exist', force: false }),
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-found' });
  });

  test('invalid-selector when the selector syntax is malformed, distinct from not-found', () => {
    const resolved = evalExpr<ClickResolveResult>(
      buildClickResolveJs({ selector: 'button[', force: false }),
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok || resolved.reason !== 'invalid-selector') {
      throw new Error('expected invalid-selector');
    }
    expect(resolved.error.length).toBeGreaterThan(0);
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

/*
 * Owner decision D4: "without `force`, a target with no visible box fails
 * with a clear message; a click is never made at (0,0). With `force`: a
 * covered target is clicked at its position as today; a target with no box
 * gets a programmatic click on the element itself, with no pointer, and the
 * result says so explicitly."
 */
describe('a click never lands at (0,0) (D4)', () => {
  const NO_BOX = { ok: false, reason: 'no-box' };
  const doc = document as unknown as {
    elementFromPoint?: (x: number, y: number) => Element | null;
  };
  let corner: HTMLElement;

  beforeEach(() => {
    // What a real page has at its top-left corner: the element a click at
    // (0,0) would land on.
    corner = document.createElement('div');
    corner.id = 'corner';
    document.body.appendChild(corner);
    doc.elementFromPoint = (x, y) => (x === 0 && y === 0 ? corner : null);
  });
  afterEach(() => {
    delete doc.elementFromPoint;
  });

  function button(id: string, parent: Element = document.body): HTMLButtonElement {
    const el = document.createElement('button');
    el.id = id;
    el.textContent = 'Go';
    parent.appendChild(el);
    return el;
  }
  function watchScroll(el: Element): Element[] {
    const scrolled: Element[] = [];
    el.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    return scrolled;
  }
  const resolve = (selector: string, force: boolean): Json =>
    evalExpr<Json>(buildClickResolveJs({ selector, force }));

  test('display:none target: no-box without force, a no_box answer with force, never a point', () => {
    const el = button('hidden-btn');
    el.style.display = 'none';
    const scrolled = watchScroll(el);
    expect(resolve('#hidden-btn', false)).toEqual(NO_BOX);
    expect(resolve('#hidden-btn', true)).toEqual({ ok: true, no_box: true, tag: 'button' });
    // Nothing is scrolled for a target that will not be clicked by pointer.
    expect(scrolled).toEqual([]);
  });

  test('a target inside a display:none ancestor has no box either', () => {
    const wrap = document.createElement('div');
    wrap.style.display = 'none';
    document.body.appendChild(wrap);
    button('inner-btn', wrap);
    expect(resolve('#inner-btn', false)).toEqual(NO_BOX);
    expect(resolve('#inner-btn', true)).toEqual({ ok: true, no_box: true, tag: 'button' });
  });

  test('visibility:hidden (own or inherited) is no box although layout gives it a rect', () => {
    const own = button('own-hidden');
    own.style.visibility = 'hidden';
    giveBox(own);
    expect(resolve('#own-hidden', false)).toEqual(NO_BOX);
    expect(resolve('#own-hidden', true)).toEqual({ ok: true, no_box: true, tag: 'button' });
    const wrap = document.createElement('div');
    wrap.style.visibility = 'hidden';
    document.body.appendChild(wrap);
    giveBox(button('inherited-hidden', wrap));
    expect(resolve('#inherited-hidden', false)).toEqual(NO_BOX);
  });

  test('a zero-height anchor whose descendant is hit keeps the HEAD path: allowed at its own position', () => {
    // An inline <a> whose only content is an absolutely positioned child:
    // its own client rect has no height, the child takes the click.
    const link = document.createElement('a');
    link.id = 'wrap-link';
    link.href = '#';
    const child = document.createElement('span');
    link.appendChild(child);
    document.body.appendChild(link);
    giveBox(link, { left: 100, top: 200, width: 50, height: 0 });
    doc.elementFromPoint = (x, y) => (x === 125 && y === 200 ? child : null);
    expect(resolve('#wrap-link', false)).toEqual({ ok: true, x: 125, y: 200, tag: 'a' });
  });

  test('a zero-size target hitting something else is retargeted or occluded exactly as at HEAD', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper';
    document.body.appendChild(wrapper);
    giveBox(button('zero', wrapper), { left: 40, top: 50, width: 0, height: 0 });
    doc.elementFromPoint = () => wrapper;
    expect(resolve('#zero', false)).toEqual({
      ok: false,
      reason: 'retargeted',
      hit_element: 'div.wrapper',
    });
    doc.elementFromPoint = () => corner;
    expect(resolve('#zero', false)).toEqual({
      ok: false,
      reason: 'occluded',
      blocker: 'div#corner',
    });
    // force: clicked by pointer at its own position, naming what is there.
    expect(resolve('#zero', true)).toEqual({
      ok: true,
      x: 40,
      y: 50,
      tag: 'button',
      hit_element: 'div#corner',
    });
  });

  test('an empty rect at the top document origin is no box: never a click at (0,0)', () => {
    giveBox(button('at-origin'), { left: 0, top: 0, width: 0, height: 0 });
    expect(resolve('#at-origin', false)).toEqual(NO_BOX);
    expect(resolve('#at-origin', true)).toEqual({ ok: true, no_box: true, tag: 'button' });
  });

  test('a box that only touches the origin (not empty) is clicked as at HEAD', () => {
    const el = button('corner-btn');
    giveBox(el, { left: -10, top: -10, width: 20, height: 20 });
    doc.elementFromPoint = () => el;
    expect(resolve('#corner-btn', false)).toEqual({ ok: true, x: 0, y: 0, tag: 'button' });
  });

  test('the browser says not visible (content of a closed <details>): no box', () => {
    // Chrome's own answer: checkVisibility() is false for an element whose
    // ancestor hides it from rendering (content-visibility, a closed
    // <details>), even where layout still reports a rect. jsdom has no
    // checkVisibility, so the test supplies Chrome's answer.
    const details = document.createElement('details');
    document.body.appendChild(details);
    const inner = button('in-details', details);
    giveBox(inner);
    const asked: unknown[] = [];
    (inner as unknown as { checkVisibility: (o: unknown) => boolean }).checkVisibility = (o) => {
      asked.push(o);
      return false;
    };
    expect(resolve('#in-details', false)).toEqual(NO_BOX);
    expect(resolve('#in-details', true)).toEqual({ ok: true, no_box: true, tag: 'button' });
    // visibility:hidden counts; opacity is not asked for (see the next test).
    expect(asked[0]).toEqual({ visibilityProperty: true });
  });

  test('an <option> of a <select> has no box of its own', () => {
    document.body.innerHTML =
      '<div id="corner"></div><select id="s"><option id="o1">A</option><option id="o2">B</option></select>';
    giveBox(document.getElementById('s')!);
    expect(resolve('#o2', false)).toEqual(NO_BOX);
    expect(resolve('#o2', true)).toEqual({ ok: true, no_box: true, tag: 'option' });
  });

  test('opacity:0 keeps its box: clicked at its position by pointer, as today', () => {
    const el = button('clear-btn');
    el.style.opacity = '0';
    giveBox(el);
    doc.elementFromPoint = () => el;
    expect(resolve('#clear-btn', false)).toEqual({ ok: true, x: 140, y: 210, tag: 'button' });
  });

  test('the browser says visible and there is a box: clicked at its position', () => {
    const el = button('shown');
    giveBox(el);
    (el as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
    doc.elementFromPoint = () => el;
    expect(resolve('#shown', false)).toEqual({ ok: true, x: 140, y: 210, tag: 'button' });
  });

  test('a target below the viewport is scrolled into view and clicked at its new position', () => {
    const el = button('far');
    giveBox(el, { left: 100, top: 5000, width: 80, height: 20 });
    el.scrollIntoView = () => giveBox(el, { left: 100, top: 300, width: 80, height: 20 });
    doc.elementFromPoint = (x, y) => (x === 140 && y === 310 ? el : null);
    expect(resolve('#far', false)).toEqual({ ok: true, x: 140, y: 310, tag: 'button' });
  });

  test('covered target with force is still clicked at its position, naming the cover', () => {
    const el = button('covered');
    giveBox(el);
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    document.body.appendChild(overlay);
    doc.elementFromPoint = () => overlay;
    expect(resolve('#covered', false)).toEqual({
      ok: false,
      reason: 'occluded',
      blocker: 'div.modal-backdrop',
    });
    expect(resolve('#covered', true)).toEqual({
      ok: true,
      x: 140,
      y: 210,
      tag: 'button',
      hit_element: 'div.modal-backdrop',
    });
  });

  test('no-box by ref, with force, still says reresolved after a re-render', () => {
    const win = window as unknown as Record<string, unknown>;
    document.body.innerHTML = '<ul id="list"><li><button>Alpha</button></li></ul>';
    win[OBSERVER_BINDING] = () => undefined;
    try {
      evalExpr(buildObserverInstallJs());
      const handle = win[OBSERVER_GLOBAL] as { refFor: (el: Element) => string | null };
      const ref = handle.refFor(document.querySelector('#list button')!)!;
      document.getElementById('list')!.innerHTML = '<li><button>Alpha</button></li>';
      expect(evalExpr<Json>(buildClickResolveJs({ ref, force: true }))).toEqual({
        ok: true,
        no_box: true,
        tag: 'button',
        reresolved: true,
      });
    } finally {
      evalExpr(buildObserverTeardownJs());
      delete win[OBSERVER_BINDING];
    }
  });
});

describe('buildProgrammaticClickJs (the force click on a target with no box, D4)', () => {
  test('calls the element’s own click(): a click event, no mousedown, mouseup or pointer events', () => {
    const el = document.createElement('button');
    el.id = 'hidden-btn';
    el.style.display = 'none';
    document.body.appendChild(el);
    const seen: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'mousemove', 'click']) {
      el.addEventListener(type, () => seen.push(type));
    }
    const result = evalExpr<Json>(buildProgrammaticClickJs({ selector: '#hidden-btn' }));
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(['click']);
  });

  test('a target that is gone fails like any other resolution and clicks nothing', () => {
    expect(evalExpr<Json>(buildProgrammaticClickJs({ selector: '#nope' }))).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  test('an element without its own click() (SVG) still gets one click event, bubbling', () => {
    document.body.innerHTML = '<div id="wrap"><svg><circle id="dot" r="2"></circle></svg></div>';
    const seen: string[] = [];
    document.getElementById('wrap')!.addEventListener('click', (e) => {
      seen.push((e.target as Element).id);
    });
    expect(evalExpr<Json>(buildProgrammaticClickJs({ selector: '#dot' }))).toEqual({ ok: true });
    expect(seen).toEqual(['dot']);
  });

  test('a disabled control (itself, or through a disabling ancestor fieldset) is refused and clicked on nothing', () => {
    document.body.innerHTML =
      '<button id="own" disabled>Own</button>' +
      '<fieldset disabled><div><button id="inherited">Inherited</button></div></fieldset>' +
      '<button id="enabled">Enabled</button>';
    const seen: string[] = [];
    const record = (e: Event): void => {
      seen.push((e.target as Element).id);
    };
    document.addEventListener('click', record, true);
    expect(evalExpr<Json>(buildProgrammaticClickJs({ selector: '#own' }))).toEqual({
      ok: false,
      reason: 'not-clickable',
      why: 'disabled',
    });
    expect(evalExpr<Json>(buildProgrammaticClickJs({ selector: '#inherited' }))).toEqual({
      ok: false,
      reason: 'not-clickable',
      why: 'disabled',
    });
    expect(seen).toEqual([]);
    // An enabled control is still clicked, as before.
    expect(evalExpr<Json>(buildProgrammaticClickJs({ selector: '#enabled' }))).toEqual({
      ok: true,
    });
    expect(seen).toEqual(['enabled']);
    document.removeEventListener('click', record, true);
  });

  test('an <option> or <optgroup> is refused: click() never selects it, so nothing is reported as clicked', () => {
    document.body.innerHTML =
      '<select id="s"><optgroup id="g" label="G"><option id="o1" value="a">A</option>' +
      '<option id="o2" value="b">B</option></optgroup></select>';
    const select = document.getElementById('s') as HTMLSelectElement;
    const before = select.value;
    for (const id of ['#o2', '#g']) {
      expect(evalExpr<Json>(buildProgrammaticClickJs({ selector: id }))).toEqual({
        ok: false,
        reason: 'not-clickable',
        why: 'option',
      });
    }
    expect(select.value).toBe(before);
  });
});

describe('buildTypeResolveJs', () => {
  test('focuses an input nested in a shadow root and reports success', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="email" value="old" />';

    const resolved = evalExpr<TypeResolveResult>(
      buildTypeResolveJs({ selector: '#email', clear: false }),
    );
    expect(resolved).toEqual({ ok: true });
    expect((shadow.getElementById('email') as HTMLInputElement).value).toBe('old');
  });

  test('clear:true empties the value before returning', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="email" value="old" />';

    const resolved = evalExpr<TypeResolveResult>(
      buildTypeResolveJs({ selector: '#email', clear: true }),
    );
    expect(resolved).toEqual({ ok: true });
    expect((shadow.getElementById('email') as HTMLInputElement).value).toBe('');
  });

  test('not-found when the selector matches nothing', () => {
    const resolved = evalExpr<TypeResolveResult>(
      buildTypeResolveJs({ selector: '#does-not-exist', clear: false }),
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-found' });
  });

  test('invalid-selector when the selector syntax is malformed', () => {
    const resolved = evalExpr<TypeResolveResult>(
      buildTypeResolveJs({ selector: 'input[', clear: false }),
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok || resolved.reason !== 'invalid-selector') {
      throw new Error('expected invalid-selector');
    }
    expect(resolved.error.length).toBeGreaterThan(0);
  });
});

describe('buildFocusJs', () => {
  test('focuses an input nested in a shadow root and reports success', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="search" />';

    const focused = evalExpr<boolean>(buildFocusJs({ selector: '#search' }));
    expect(focused).toBe(true);
  });

  test('false when the selector matches nothing', () => {
    const focused = evalExpr<boolean>(buildFocusJs({ selector: '#does-not-exist' }));
    expect(focused).toBe(false);
  });
});

/*
 * `Input.insertText` and key events go to whatever has focus. When the
 * element asked for does not take it, type and press used to report success
 * and write into the previously focused field.
 */
describe('type and press act only on an element that took focus', () => {
  let previous: HTMLInputElement;
  beforeEach(() => {
    previous = document.createElement('input');
    previous.id = 'previous';
    document.body.appendChild(previous);
    previous.focus();
  });
  const typeAt = (selector: string, clear = false): Json =>
    evalExpr<Json>(buildTypeResolveJs({ selector, clear }));
  const pressAt = (selector: string): unknown => evalExpr(buildFocusJs({ selector }));
  const notFocused = (why: string): Json => ({ ok: false, reason: 'not-focused', why });

  test('a field with no visible box does not take focus: nothing is cleared, focus stays where it was', () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="hidden" value="keep" />');
    const hidden = document.getElementById('hidden') as HTMLInputElement;
    // Chrome refuses focus to an element that is not rendered; jsdom has no
    // rendering and focuses it anyway, so the test gives it Chrome's answer.
    hidden.focus = () => undefined;
    expect(typeAt('#hidden', true)).toEqual(notFocused('it has no visible box'));
    expect(hidden.value).toBe('keep');
    expect(pressAt('#hidden')).toEqual(notFocused('it has no visible box'));
    expect(document.activeElement).toBe(previous);
  });

  test('a disabled field does not take focus', () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="off" disabled />');
    giveBox(document.getElementById('off')!);
    expect(typeAt('#off')).toEqual(notFocused('it is disabled'));
    expect(pressAt('#off')).toEqual(notFocused('it is disabled'));
    expect(document.activeElement).toBe(previous);
  });

  test('a wrapper that is not focusable does not take focus', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="wrap"><span>Name</span></div>');
    giveBox(document.getElementById('wrap')!);
    expect(typeAt('#wrap')).toEqual(notFocused('it is not focusable'));
    expect(pressAt('#wrap')).toEqual(notFocused('it is not focusable'));
  });

  test('by ref the press resolver answers the same failure object', () => {
    const win = window as unknown as Record<string, unknown>;
    document.body.insertAdjacentHTML('beforeend', '<div id="wrap2" role="button">Go</div>');
    giveBox(document.getElementById('wrap2')!);
    win[OBSERVER_BINDING] = () => undefined;
    try {
      evalExpr(buildObserverInstallJs());
      const handle = win[OBSERVER_GLOBAL] as { refFor: (el: Element) => string | null };
      const ref = handle.refFor(document.getElementById('wrap2')!)!;
      expect(evalExpr(buildFocusJs({ ref }))).toEqual(notFocused('it is not focusable'));
      expect(evalExpr(buildTypeResolveJs({ ref, clear: false }))).toEqual(
        notFocused('it is not focusable'),
      );
    } finally {
      evalExpr(buildObserverTeardownJs());
      delete win[OBSERVER_BINDING];
    }
  });

  test('still works: an input inside an open shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<input id="in-shadow" />';
    expect(typeAt('#in-shadow')).toEqual({ ok: true });
    expect(pressAt('#in-shadow')).toBe(true);
  });

  test('still works: an input inside a same-origin iframe', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.contentDocument!.body.innerHTML = '<input id="in-frame" />';
    expect(typeAt('#in-frame')).toEqual({ ok: true });
    expect(pressAt('#in-frame')).toBe(true);
  });

  test('still works: a contenteditable element', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="editor" contenteditable="true"></div>');
    expect(typeAt('#editor')).toEqual({ ok: true });
    expect(pressAt('#editor')).toBe(true);
  });

  test('still works: a paragraph inside the focused editing host', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="host-editor" contenteditable="true"><p id="para">x</p></div>',
    );
    const editor = document.getElementById('host-editor')!;
    editor.focus();
    // Chrome reports isContentEditable on an editing host; jsdom does not.
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    expect(typeAt('#para')).toEqual({ ok: true });
    expect(pressAt('#para')).toBe(true);
    expect(document.activeElement).toBe(editor);
  });

  test('still works: a host whose shadow root delegates focus to an inner input', () => {
    const host = document.createElement('x-field');
    host.id = 'x-field';
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open', delegatesFocus: true }).innerHTML = '<input />';
    // jsdom does not implement delegatesFocus; Chrome moves focus to the
    // first focusable element inside, which is what the stub does.
    host.focus = () => host.shadowRoot!.querySelector('input')!.focus();
    expect(typeAt('#x-field')).toEqual({ ok: true });
    expect(pressAt('#x-field')).toBe(true);
  });

  test('still works: a label whose focus goes to its control', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<label id="lbl" for="named">Name</label><input id="named" />',
    );
    const label = document.getElementById('lbl') as HTMLLabelElement;
    // Chrome forwards focus() on a label to its control; jsdom does not.
    label.focus = () => (document.getElementById('named') as HTMLInputElement).focus();
    expect(typeAt('#lbl')).toEqual({ ok: true });
    expect(pressAt('#lbl')).toBe(true);
  });
});

describe('buildFocusedFieldJs (S2: fields the page declares sensitive)', () => {
  type FocusedField = { sensitive_field: boolean };

  function focusIn(root: HTMLElement | ShadowRoot, html: string, id: string): HTMLElement {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    root.appendChild(holder);
    const el = root.querySelector<HTMLElement>(`#${id}`)!;
    el.focus();
    return el;
  }

  test('a focused <input type="password"> is sensitive', () => {
    focusIn(document.body, '<input id="pw" type="password">', 'pw');
    expect(evalExpr<FocusedField>(buildFocusedFieldJs())).toEqual({ sensitive_field: true });
  });

  test.each(['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'])(
    'autocomplete="%s" is sensitive, alone or among other tokens',
    (token) => {
      focusIn(document.body, `<input id="a" type="text" autocomplete="${token}">`, 'a');
      expect(evalExpr<FocusedField>(buildFocusedFieldJs())).toEqual({ sensitive_field: true });
      document.body.innerHTML = '';
      focusIn(
        document.body,
        `<input id="b" type="text" autocomplete="section-pay billing ${token.toUpperCase()}">`,
        'b',
      );
      expect(evalExpr<FocusedField>(buildFocusedFieldJs())).toEqual({ sensitive_field: true });
    },
  );

  test('a plain text field is not sensitive, whatever its name, id or label says', () => {
    focusIn(
      document.body,
      '<label for="password">Password</label><input id="password" name="password" type="text" autocomplete="username">',
      'password',
    );
    expect(evalExpr<FocusedField>(buildFocusedFieldJs())).toEqual({ sensitive_field: false });
  });

  test('nothing focused is not sensitive', () => {
    expect(evalExpr<FocusedField>(buildFocusedFieldJs())).toEqual({ sensitive_field: false });
  });

  test('descends through an open shadow root to the focused field', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    focusIn(shadow, '<input id="pw" type="password">', 'pw');
    expect(evalExpr<FocusedField>(buildFocusedFieldJs())).toEqual({ sensitive_field: true });
  });

  test('descends into a same-origin iframe to the focused field', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const inner = frame.contentDocument!;
    const pw = inner.createElement('input');
    pw.type = 'password';
    inner.body.appendChild(pw);
    frame.focus();
    pw.focus();
    expect(document.activeElement).toBe(frame);
    expect(evalExpr<FocusedField>(buildFocusedFieldJs())).toEqual({ sensitive_field: true });
  });
});

describe('buildSettleJs', () => {
  interface SettleResult {
    settled: boolean;
    duration_ms: number;
    mutation_count: number;
    url_changed?: string;
    focus_moved?: boolean;
  }

  test('resolves settled:true once mutations stop for the quiet period', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    const resultPromise = evalExpr<Promise<SettleResult>>(
      buildSettleJs({ settle_ms: 100, settle_timeout_ms: 500 }),
    );
    // One mutation shortly after the observer starts, then silence — the
    // quiet period should be measured from THIS mutation, not from t=0.
    setTimeout(() => target.setAttribute('data-x', '1'), 5);

    const result = await resultPromise;
    expect(result.settled).toBe(true);
    expect(result.mutation_count).toBeGreaterThanOrEqual(1);
    expect(result.duration_ms).toBeGreaterThanOrEqual(100);
  });

  test('resolves settled:false when mutations never stop before the cap', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    const resultPromise = evalExpr<Promise<SettleResult>>(
      buildSettleJs({ settle_ms: 40, settle_timeout_ms: 120 }),
    );
    // Keep mutating faster than the quiet period so it can never settle —
    // the overall cap must still win and return settled:false.
    const interval = setInterval(() => target.setAttribute('data-x', String(Date.now())), 15);

    const result = await resultPromise;
    clearInterval(interval);
    expect(result.settled).toBe(false);
    expect(result.duration_ms).toBeGreaterThanOrEqual(120);
    expect(result.mutation_count).toBeGreaterThan(0);
  });

  test('settle_ms <= 0 resolves immediately with settled:true', async () => {
    const result = await evalExpr<Promise<SettleResult>>(
      buildSettleJs({ settle_ms: 0, settle_timeout_ms: 500 }),
    );
    expect(result.settled).toBe(true);
    expect(result.mutation_count).toBe(0);
  });

  test('reports url_changed only when the URL actually changed during the wait', async () => {
    const noChange = await evalExpr<Promise<SettleResult>>(
      buildSettleJs({ settle_ms: 10, settle_timeout_ms: 200 }),
    );
    expect(noChange.url_changed).toBeUndefined();
  });

  test('reports focus_moved only when the active element changed during the wait', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const other = document.createElement('input');
    document.body.appendChild(other);
    input.focus();

    const resultPromise = evalExpr<Promise<SettleResult>>(
      buildSettleJs({ settle_ms: 100, settle_timeout_ms: 300 }),
    );
    setTimeout(() => other.focus(), 5);

    const result = await resultPromise;
    expect(result.focus_moved).toBe(true);
  });

  test('focus_moved is omitted when the active element never changes', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const result = await evalExpr<Promise<SettleResult>>(
      buildSettleJs({ settle_ms: 10, settle_timeout_ms: 200 }),
    );
    expect(result.focus_moved).toBeUndefined();
  });
});

/**
 * Owner decision D5: settle watches open shadow roots, the closed roots the
 * page observer holds and same-origin iframe documents like the main
 * document, and says when part of the page could not be watched. Timing: the
 * mutation lands at MUTATE_AT, after the quiet period would have started; a
 * settle that sees it finishes no earlier than MUTATE_AT + QUIET.
 */
describe('buildSettleJs: shadow roots and frames (D5)', () => {
  // The product starts its quiet clock when the script starts, before it walks
  // the roots and frames (no mutation can happen during that synchronous walk,
  // so those ms are real quiet). On a slow or cold runner the walk can take
  // tens of ms, and the first quiet check then falls that much earlier than
  // QUIET after the test timers were armed. QUIET must leave room for the walk
  // plus MUTATE_AT, or the mutation lands after settle already ended.
  const QUIET = 100;
  const MUTATE_AT = 20;
  // The page measures with Date.now (1 ms steps) while this test schedules the
  // mutation with setTimeout, whose clock is the event loop's own cached ms
  // tick (coarser on Windows). A timer can therefore fire up to a tick before
  // MUTATE_AT by Date.now. The product never settles before QUIET ms after the
  // last mutation it saw (settle.check compares Date.now deltas), so the lower
  // bound is allowed that much timer skew, not more.
  const TIMER_SLACK = 2;
  const settleJs = () => buildSettleJs({ settle_ms: QUIET, settle_timeout_ms: 1000 });

  interface DeepSettleResult {
    settled: boolean;
    duration_ms: number;
    mutation_count: number;
    frame_mutation_count?: number;
    unobserved?: { cross_origin_frames?: number; shadow_roots?: string; hint: string };
  }

  function settleWhile(mutate: () => void, at = MUTATE_AT): Promise<DeepSettleResult> {
    const pending = evalExpr<Promise<DeepSettleResult>>(settleJs());
    setTimeout(mutate, at);
    return pending;
  }

  /** Install the page observer in a window, as the host does at document start. */
  function installObserver(win: Window = window, opts: { version?: number } = {}): void {
    (win as unknown as { eval(src: string): unknown }).eval(buildObserverInstallJs(opts));
  }

  function openShadowHost(): ShadowRoot {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span id="inner">x</span>';
    return shadow;
  }

  function sameOriginFrame(withObserver = true): Document {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    if (withObserver) installObserver(frame.contentWindow!);
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<p id="inner">x</p>';
    return doc;
  }

  function crossOriginFrame(access: 'null' | 'throws'): HTMLIFrameElement {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    // Chrome answers contentDocument with null for a document that is not
    // same origin-domain (HTML spec, the iframe contentDocument getter);
    // jsdom has no cross-origin frames, so the getter is stubbed to answer
    // that. 'throws' models an engine that throws instead.
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      get: () => {
        if (access === 'throws') throw new DOMException('Blocked a frame', 'SecurityError');
        return null;
      },
    });
    return frame;
  }

  afterEach(() => {
    evalExpr(buildObserverTeardownJs());
  });

  describe('with the page observer', () => {
    beforeEach(() => {
      installObserver();
    });

    test('a mutation inside an open shadow root is counted and delays settled', async () => {
      const shadow = openShadowHost();
      const result = await settleWhile(() =>
        shadow.getElementById('inner')!.setAttribute('data-x', '1'),
      );
      expect(result).toEqual({ settled: true, duration_ms: expect.any(Number), mutation_count: 1 });
      expect(result.duration_ms).toBeGreaterThanOrEqual(MUTATE_AT + QUIET - TIMER_SLACK);
    });

    test('a mutation inside a nested open shadow root is counted', async () => {
      const outer = openShadowHost();
      const innerHost = document.createElement('div');
      outer.appendChild(innerHost);
      const inner = innerHost.attachShadow({ mode: 'open' });
      inner.innerHTML = '<b>y</b>';
      const result = await settleWhile(() => inner.querySelector('b')!.setAttribute('data-x', '1'));
      expect(result).toEqual({ settled: true, duration_ms: expect.any(Number), mutation_count: 1 });
      expect(result.duration_ms).toBeGreaterThanOrEqual(MUTATE_AT + QUIET - TIMER_SLACK);
    });

    test('a closed root attached before settle started, known to the observer, is counted', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const closed = host.attachShadow({ mode: 'closed' });
      const result = await settleWhile(() => closed.appendChild(document.createElement('i')));
      expect(result).toEqual({ settled: true, duration_ms: expect.any(Number), mutation_count: 1 });
      expect(result.duration_ms).toBeGreaterThanOrEqual(MUTATE_AT + QUIET - TIMER_SLACK);
    });

    test('a root attached during the wait is counted through the observer; settle patches nothing', async () => {
      const before = Element.prototype.attachShadow;
      const openHost = document.createElement('div');
      const closedHost = document.createElement('div');
      document.body.append(openHost, closedHost);
      let open: ShadowRoot | null = null;
      let closed: ShadowRoot | null = null;
      let during: unknown = null;
      const pending = evalExpr<Promise<DeepSettleResult>>(settleJs());
      setTimeout(() => {
        during = Element.prototype.attachShadow;
        open = openHost.attachShadow({ mode: 'open' });
        closed = closedHost.attachShadow({ mode: 'closed' });
      }, 5);
      setTimeout(() => {
        open!.appendChild(document.createElement('i'));
        closed!.appendChild(document.createElement('i'));
      }, MUTATE_AT);
      const result = await pending;
      expect(result).toEqual({ settled: true, duration_ms: expect.any(Number), mutation_count: 2 });
      expect(result.duration_ms).toBeGreaterThanOrEqual(MUTATE_AT + QUIET - TIMER_SLACK);
      expect(during).toBe(before);
      expect(Element.prototype.attachShadow).toBe(before);
    });

    test('a closed root inside an element inserted after settle started is counted', async () => {
      // Built off the page before settle started: its host was not in the
      // page then, so the root comes from the observer when the host lands.
      const host = document.createElement('div');
      const closed = host.attachShadow({ mode: 'closed' });
      const pending = evalExpr<Promise<DeepSettleResult>>(settleJs());
      setTimeout(() => document.body.appendChild(host), 5);
      setTimeout(() => closed.appendChild(document.createElement('i')), MUTATE_AT);
      const result = await pending;
      // The insertion of the host (1) and the insertion inside its root (1).
      expect(result).toEqual({ settled: true, duration_ms: expect.any(Number), mutation_count: 2 });
      expect(result.duration_ms).toBeGreaterThanOrEqual(MUTATE_AT + QUIET - TIMER_SLACK);
    });

    test('a mutation inside a same-origin iframe document is counted and delays settled', async () => {
      const doc = sameOriginFrame();
      const result = await settleWhile(() =>
        doc.getElementById('inner')!.setAttribute('data-x', '1'),
      );
      expect(result).toEqual({
        settled: true,
        duration_ms: expect.any(Number),
        mutation_count: 1,
        frame_mutation_count: 1,
      });
      expect(result.duration_ms).toBeGreaterThanOrEqual(MUTATE_AT + QUIET - TIMER_SLACK);
    });

    test('a closed root inside a same-origin iframe, known to its observer, is counted', async () => {
      const doc = sameOriginFrame();
      const host = doc.createElement('div');
      doc.body.appendChild(host);
      const closed = host.attachShadow({ mode: 'closed' });
      const result = await settleWhile(() => closed.appendChild(doc.createElement('i')));
      expect(result).toEqual({
        settled: true,
        duration_ms: expect.any(Number),
        mutation_count: 1,
        frame_mutation_count: 1,
      });
    });

    test('an iframe added after settle started is watched', async () => {
      let frame: HTMLIFrameElement | null = null;
      const pending = evalExpr<Promise<DeepSettleResult>>(settleJs());
      setTimeout(() => {
        frame = document.createElement('iframe');
        document.body.appendChild(frame);
        installObserver(frame.contentWindow!);
      }, 5);
      setTimeout(() => {
        frame!.contentDocument!.body.appendChild(frame!.contentDocument!.createElement('p'));
      }, MUTATE_AT);
      const result = await pending;
      // The iframe insertion in the top document (1) and the insertion inside it (1).
      expect(result).toEqual({
        settled: true,
        duration_ms: expect.any(Number),
        mutation_count: 2,
        frame_mutation_count: 1,
      });
      expect(result.duration_ms).toBeGreaterThanOrEqual(MUTATE_AT + QUIET - TIMER_SLACK);
    });

    test('a cross-origin iframe is reported as not watched', async () => {
      crossOriginFrame('null');
      crossOriginFrame('throws');
      const result = await evalExpr<Promise<DeepSettleResult>>(settleJs());
      expect(result).toEqual({
        settled: true,
        duration_ms: expect.any(Number),
        mutation_count: 0,
        unobserved: { cross_origin_frames: 2, hint: UNOBSERVED_FRAMES_HINT },
      });
    });

    test('a cross-origin iframe nested in a closed root and in a same-origin frame is reported', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const closed = host.attachShadow({ mode: 'closed' });
      const inShadow = document.createElement('iframe');
      closed.appendChild(inShadow);
      Object.defineProperty(inShadow, 'contentDocument', { configurable: true, get: () => null });
      const doc = sameOriginFrame();
      const inFrame = doc.createElement('iframe');
      doc.body.appendChild(inFrame);
      Object.defineProperty(inFrame, 'contentDocument', { configurable: true, get: () => null });
      const result = await evalExpr<Promise<DeepSettleResult>>(settleJs());
      expect(result.unobserved).toEqual({ cross_origin_frames: 2, hint: UNOBSERVED_FRAMES_HINT });
    });

    test('known limit: a closed root attached before the observer was installed is not seen', async () => {
      // Also a declarative shadowrootmode="closed" root, which the parser
      // creates without calling attachShadow: nothing in the page can reach
      // it, so its changes are neither counted nor reported.
      evalExpr(buildObserverTeardownJs());
      const host = document.createElement('div');
      document.body.appendChild(host);
      const closed = host.attachShadow({ mode: 'closed' });
      installObserver();
      const result = await settleWhile(() => closed.appendChild(document.createElement('i')));
      expect(result).toEqual({ settled: true, duration_ms: expect.any(Number), mutation_count: 0 });
    });

    test('a page with no shadow roots or frames gives exactly the fields it always gave', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);
      const result = await settleWhile(() => target.setAttribute('data-x', '1'));
      expect(Object.keys(result)).toEqual(['settled', 'duration_ms', 'mutation_count']);
      expect(result).toEqual({ settled: true, duration_ms: expect.any(Number), mutation_count: 1 });
    });

    test('a shadow root that keeps mutating past the cap gives settled:false', async () => {
      const shadow = openShadowHost();
      const span = shadow.getElementById('inner')!;
      const interval = setInterval(() => span.setAttribute('data-x', String(Date.now())), 10);
      const result = await evalExpr<Promise<DeepSettleResult>>(
        buildSettleJs({ settle_ms: 40, settle_timeout_ms: 120 }),
      );
      clearInterval(interval);
      expect(result.settled).toBe(false);
      expect(result.duration_ms).toBeGreaterThanOrEqual(120);
      expect(result.mutation_count).toBeGreaterThan(0);
    });
  });

  describe('without a current page observer (fallback)', () => {
    const OPEN_ONLY = { shadow_roots: 'open-only', hint: UNOBSERVED_SHADOW_HINT };

    test('observer absent: open roots are scanned and the result says closed and late roots were not watched', async () => {
      const before = Element.prototype.attachShadow;
      const shadow = openShadowHost();
      const result = await settleWhile(() =>
        shadow.getElementById('inner')!.setAttribute('data-x', '1'),
      );
      expect(result).toEqual({
        settled: true,
        duration_ms: expect.any(Number),
        mutation_count: 1,
        unobserved: OPEN_ONLY,
      });
      expect(result.duration_ms).toBeGreaterThanOrEqual(MUTATE_AT + QUIET - TIMER_SLACK);
      expect(Element.prototype.attachShadow).toBe(before);
    });

    test('observer absent: a root attached during the wait is not watched, and the marker says so', async () => {
      const before = Element.prototype.attachShadow;
      const host = document.createElement('div');
      document.body.appendChild(host);
      let during: unknown = null;
      let root: ShadowRoot | null = null;
      const pending = evalExpr<Promise<DeepSettleResult>>(settleJs());
      setTimeout(() => {
        during = Element.prototype.attachShadow;
        root = host.attachShadow({ mode: 'open' });
      }, 5);
      setTimeout(() => root!.appendChild(document.createElement('i')), MUTATE_AT);
      const result = await pending;
      expect(result).toEqual({
        settled: true,
        duration_ms: expect.any(Number),
        mutation_count: 0,
        unobserved: OPEN_ONLY,
      });
      expect(during).toBe(before);
    });

    test('an older observer (version 4) is not used: same fallback and marker', async () => {
      installObserver(window, { version: 4 });
      const host = document.createElement('div');
      document.body.appendChild(host);
      const closed = host.attachShadow({ mode: 'closed' });
      const result = await settleWhile(() => closed.appendChild(document.createElement('i')));
      expect(result).toEqual({
        settled: true,
        duration_ms: expect.any(Number),
        mutation_count: 0,
        unobserved: OPEN_ONLY,
      });
    });

    test('an observer with partial coverage is not used: same fallback and marker', async () => {
      installObserver();
      (window as unknown as Record<string, { coverage: string }>)[OBSERVER_GLOBAL].coverage =
        'partial';
      const result = await evalExpr<Promise<DeepSettleResult>>(settleJs());
      expect(result.unobserved).toEqual(OPEN_ONLY);
    });

    test('a same-origin frame without an observer gets the marker even when the top has one', async () => {
      installObserver();
      const doc = sameOriginFrame(false);
      const result = await settleWhile(() =>
        doc.getElementById('inner')!.setAttribute('data-x', '1'),
      );
      expect(result).toEqual({
        settled: true,
        duration_ms: expect.any(Number),
        mutation_count: 1,
        frame_mutation_count: 1,
        unobserved: OPEN_ONLY,
      });
    });

    test('cross-origin frames and the fallback together give both counts and both hints', async () => {
      crossOriginFrame('null');
      const result = await evalExpr<Promise<DeepSettleResult>>(settleJs());
      expect(result.unobserved).toEqual({
        cross_origin_frames: 1,
        shadow_roots: 'open-only',
        hint: `${UNOBSERVED_FRAMES_HINT} ${UNOBSERVED_SHADOW_HINT}`,
      });
    });
  });
});

describe('buildStateJs', () => {
  interface StateResult {
    url: string;
    title: string;
    viewport: { w: number; h: number };
    focused?: { selector: string; tag: string; ambiguous?: boolean };
    dialogs?: { selector: string; role: string; label?: string }[];
    scroll?: { x: number; y: number };
  }

  test('always reports url, title and viewport', () => {
    document.title = 'My Page';
    const result = evalExpr<StateResult>(buildStateJs());
    expect(result.url).toContain('://');
    expect(result.title).toBe('My Page');
    expect(result.viewport).toEqual({ w: expect.any(Number), h: expect.any(Number) });
  });

  test('omits focused, dialogs and scroll when there is nothing to report', () => {
    const result = evalExpr<StateResult>(buildStateJs());
    expect(result.focused).toBeUndefined();
    expect(result.dialogs).toBeUndefined();
    expect(result.scroll).toBeUndefined();
  });

  test('reports the focused element with a selector that resolves back to it', () => {
    const input = document.createElement('input');
    input.id = 'search';
    document.body.appendChild(input);
    input.focus();

    const result = evalExpr<StateResult>(buildStateJs());
    expect(result.focused?.tag).toBe('input');
    expect(result.focused?.selector).toBeTruthy();
    expect(document.querySelector(result.focused!.selector)).toBe(input);
  });

  test('descends through an open shadow root to the real focused element', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="inner" />';
    const inner = shadow.getElementById('inner') as HTMLInputElement;
    inner.focus();

    const result = evalExpr<StateResult>(buildStateJs());
    expect(result.focused?.tag).toBe('input');
    // Structural selectors are root-scoped by design (see genSelectorInfo's
    // doc comment) — resolving it against the shadow root itself proves the
    // deep descent found the INNER input, not the shadow host.
    expect(shadow.querySelector(result.focused!.selector)).toBe(inner);
  });

  test('reports visible role=dialog elements with a resolved label', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.id = 'confirm-dialog';
    dialog.setAttribute('aria-label', 'Confirm deletion');
    document.body.appendChild(dialog);
    makeVisible(dialog);

    const result = evalExpr<StateResult>(buildStateJs());
    expect(result.dialogs).toHaveLength(1);
    expect(document.querySelector(result.dialogs![0].selector)).toBe(dialog);
    expect(result.dialogs?.[0]?.role).toBe('dialog');
    expect(result.dialogs?.[0]?.label).toBe('Confirm deletion');
  });

  test('does not report a hidden dialog', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    // Not marked visible.

    const result = evalExpr<StateResult>(buildStateJs());
    expect(result.dialogs).toBeUndefined();
  });

  test('reports scroll only when the page is scrolled away from (0,0)', () => {
    Object.defineProperty(window, 'scrollX', { value: 120, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 40, configurable: true });

    const result = evalExpr<StateResult>(buildStateJs());
    expect(result.scroll).toEqual({ x: 120, y: 40 });
  });
});

interface DragProbePoint {
  x: number;
  y: number;
  in_viewport: boolean;
}
type DragProbeResult =
  { err: string } | { from: DragProbePoint; to: DragProbePoint; draggable: boolean };

describe('buildDragProbeJs — deep-query endpoint resolution (v0.20.0)', () => {
  test('resolves a source selector that lives inside an open shadow root (was a hard not_found before v0.20.0)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="card">Card</div><div id="column">Column</div>';
    const card = shadow.getElementById('card')!;
    const column = shadow.getElementById('column')!;
    giveBox(card, { left: 10, top: 20, width: 30, height: 10 });
    giveBox(column, { left: 100, top: 20, width: 30, height: 10 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#card', to_selector: '#column' }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.from).toEqual({ x: 25, y: 25, in_viewport: true });
    expect(result.to).toEqual({ x: 115, y: 25, in_viewport: true });
  });

  test('resolves an endpoint inside a same-origin iframe with the TOP-LEVEL mapped coordinates (not the local iframe-relative ones)', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.getBoundingClientRect = () =>
      ({ left: 200, top: 300, width: 400, height: 400 }) as DOMRect;
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<div id="drop-target">Drop here</div>';
    const target = idoc.getElementById('drop-target')!;
    giveBox(target, { left: 10, top: 20, width: 30, height: 10 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_x: 5, from_y: 5, to_selector: '#drop-target' }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    // Local center would be (25, 25) inside the iframe's own viewport — the
    // TOP-LEVEL point must add the iframe's own rect offset on top of that,
    // exactly like buildClickResolveJs's viewportCenterOf mapping.
    expect(result.to).toEqual({ x: 200 + 25, y: 300 + 25, in_viewport: true });
  });

  test('coordinate-based endpoints pass straight through untouched', () => {
    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_x: 10, from_y: 20, to_x: 300, to_y: 400 }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.from).toEqual({ x: 10, y: 20, in_viewport: true });
    expect(result.to).toEqual({ x: 300, y: 400, in_viewport: true });
  });

  test('from_selector not found returns a descriptive err, not a thrown exception', () => {
    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#does-not-exist', to_x: 1, to_y: 1 }),
    );
    expect('err' in result).toBe(true);
    if (!('err' in result)) return;
    expect(result.err).toContain('from_selector not found');
    expect(result.err).toContain('#does-not-exist');
  });

  test('to_selector not found returns a descriptive err', () => {
    const src = document.createElement('div');
    document.body.appendChild(src);
    giveBox(src, { left: 0, top: 0, width: 10, height: 10 });
    src.id = 'src';

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#src', to_selector: '#does-not-exist' }),
    );
    expect('err' in result).toBe(true);
    if (!('err' in result)) return;
    expect(result.err).toContain('to_selector not found');
  });

  test('draggable:true for a native <img> source resolved from inside a same-origin iframe (cross-realm-safe tag check)', () => {
    // A cross-realm `instanceof HTMLImageElement` check would silently
    // report false here: an <img> from an iframe's contentDocument is an
    // instance of the IFRAME's own HTMLImageElement constructor, not the
    // top document's. The probe must use a tagName check instead.
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<img id="thumb" src="x.png" />';
    const img = idoc.getElementById('thumb')!;
    giveBox(img, { left: 0, top: 0, width: 20, height: 20 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#thumb', to_x: 100, to_y: 100 }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.draggable).toBe(true);
  });

  test('in_viewport:false when the mapped top-level point falls outside the viewport', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    // Iframe itself sits far outside the 1024x768 default jsdom viewport.
    iframe.getBoundingClientRect = () =>
      ({ left: 5000, top: 5000, width: 400, height: 400 }) as DOMRect;
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<div id="offscreen">Offscreen</div>';
    const el = idoc.getElementById('offscreen')!;
    giveBox(el, { left: 10, top: 10, width: 20, height: 20 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#offscreen', to_x: 1, to_y: 1 }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.from.in_viewport).toBe(false);
  });

  test('endpoints in two DIFFERENT realms — from inside an iframe, to in the top document — each mapped independently', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.getBoundingClientRect = () =>
      ({ left: 200, top: 300, width: 400, height: 400 }) as DOMRect;
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<div id="card">Card</div>';
    const card = idoc.getElementById('card')!;
    giveBox(card, { left: 10, top: 20, width: 30, height: 10 });

    const column = document.createElement('div');
    column.id = 'column';
    document.body.appendChild(column);
    giveBox(column, { left: 700, top: 50, width: 40, height: 20 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#card', to_selector: '#column' }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    // from: iframe offset applied. to: top-document element, NO offset —
    // proving the frame chain is computed per endpoint, not shared.
    expect(result.from).toEqual({ x: 200 + 25, y: 300 + 25, in_viewport: true });
    expect(result.to).toEqual({ x: 720, y: 60, in_viewport: true });
  });

  test('endpoints in two DIFFERENT iframes — each endpoint carries its own frame offset', () => {
    const frameA = document.createElement('iframe');
    document.body.appendChild(frameA);
    frameA.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 300, height: 300 }) as DOMRect;
    const docA = frameA.contentDocument!;
    docA.body.innerHTML = '<div id="src">Source</div>';
    const src = docA.getElementById('src')!;
    giveBox(src, { left: 10, top: 10, width: 20, height: 20 });

    const frameB = document.createElement('iframe');
    document.body.appendChild(frameB);
    frameB.getBoundingClientRect = () =>
      ({ left: 500, top: 200, width: 300, height: 300 }) as DOMRect;
    const docB = frameB.contentDocument!;
    docB.body.innerHTML = '<div id="dst">Destination</div>';
    const dst = docB.getElementById('dst')!;
    giveBox(dst, { left: 30, top: 40, width: 20, height: 20 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#src', to_selector: '#dst' }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.from).toEqual({ x: 100 + 20, y: 100 + 20, in_viewport: true });
    expect(result.to).toEqual({ x: 500 + 40, y: 200 + 50, in_viewport: true });
  });

  test('draggable:true for an <a href> source', () => {
    const link = document.createElement('a');
    link.id = 'drag-link';
    link.href = 'https://example.com/page';
    link.textContent = 'Drag me';
    document.body.appendChild(link);
    giveBox(link, { left: 0, top: 0, width: 20, height: 10 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#drag-link', to_x: 100, to_y: 100 }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.draggable).toBe(true);
  });

  test('draggable:false for an <a> WITHOUT href (not implicitly draggable)', () => {
    const anchor = document.createElement('a');
    anchor.id = 'no-href';
    anchor.textContent = 'Not a link';
    document.body.appendChild(anchor);
    giveBox(anchor, { left: 0, top: 0, width: 20, height: 10 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#no-href', to_x: 100, to_y: 100 }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.draggable).toBe(false);
  });

  test('draggable:true for an element with draggable=true (explicit HTML5 opt-in on a plain div)', () => {
    const div = document.createElement('div');
    div.id = 'custom-drag';
    div.draggable = true;
    document.body.appendChild(div);
    giveBox(div, { left: 0, top: 0, width: 20, height: 10 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#custom-drag', to_x: 100, to_y: 100 }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.draggable).toBe(true);
  });

  test('draggable:false for a plain non-draggable div', () => {
    const div = document.createElement('div');
    div.id = 'plain';
    document.body.appendChild(div);
    giveBox(div, { left: 0, top: 0, width: 20, height: 10 });

    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#plain', to_x: 100, to_y: 100 }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.draggable).toBe(false);
  });

  test('a source with no visible box fails naming the source, not a point at its frame origin (D4)', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.getBoundingClientRect = () =>
      ({ left: 200, top: 300, width: 400, height: 400 }) as DOMRect;
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<div id="card" style="display:none">Card</div>';
    const scrolled: Element[] = [];
    idoc.getElementById('card')!.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    expect(
      evalExpr<Json>(buildDragProbeJs({ from_selector: '#card', to_x: 100, to_y: 100 })),
    ).toEqual({
      err:
        'from_selector #card has no visible box (not rendered or visibility-hidden), ' +
        'so there is no point to drag from: make it visible first',
    });
    expect(scrolled).toEqual([]);
  });

  test('a destination with no visible box fails naming the destination (D4)', () => {
    const src = document.createElement('div');
    src.id = 'src';
    document.body.appendChild(src);
    giveBox(src, { left: 10, top: 10, width: 20, height: 20 });
    const dst = document.createElement('div');
    dst.id = 'dst';
    dst.style.visibility = 'hidden';
    document.body.appendChild(dst);
    giveBox(dst, { left: 300, top: 300, width: 20, height: 20 });
    expect(
      evalExpr<Json>(buildDragProbeJs({ from_selector: '#src', to_selector: '#dst' })),
    ).toEqual({
      err:
        'to_selector #dst has no visible box (not rendered or visibility-hidden), ' +
        'so there is no point to drag to: make it visible first',
    });
  });

  test('an endpoint that is an empty rect at the top viewport origin is no box, on either side (same guard as click)', () => {
    const ok = document.createElement('div');
    ok.id = 'ok';
    document.body.appendChild(ok);
    giveBox(ok, { left: 10, top: 10, width: 20, height: 20 });
    const empty = document.createElement('div');
    empty.id = 'empty';
    document.body.appendChild(empty);
    giveBox(empty, { left: 0, top: 0, width: 0, height: 0 });
    expect(
      evalExpr<Json>(buildDragProbeJs({ from_selector: '#empty', to_selector: '#ok' })),
    ).toEqual({
      err:
        'from_selector #empty has no visible box (not rendered or visibility-hidden), ' +
        'so there is no point to drag from: make it visible first',
    });
    expect(
      evalExpr<Json>(buildDragProbeJs({ from_selector: '#ok', to_selector: '#empty' })),
    ).toEqual({
      err:
        'to_selector #empty has no visible box (not rendered or visibility-hidden), ' +
        'so there is no point to drag to: make it visible first',
    });
  });

  test('a real box that only touches the origin still drags; an empty rect elsewhere is a box', () => {
    const corner = document.createElement('div');
    corner.id = 'corner';
    document.body.appendChild(corner);
    giveBox(corner, { left: -10, top: -10, width: 20, height: 20 });
    const dot = document.createElement('div');
    dot.id = 'dot';
    document.body.appendChild(dot);
    giveBox(dot, { left: 40, top: 50, width: 0, height: 0 });
    const result = evalExpr<DragProbeResult>(
      buildDragProbeJs({ from_selector: '#corner', to_selector: '#dot' }),
    );
    expect('err' in result).toBe(false);
    if ('err' in result) return;
    expect(result.from).toEqual({ x: 0, y: 0, in_viewport: true });
    expect(result.to.x).toBe(40);
    expect(result.to.y).toBe(50);
  });
});

describe('buildElementRectJs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('returns the element rect in page coordinates (viewport rect + scroll)', () => {
    const el = document.createElement('div');
    el.id = 'card';
    document.body.appendChild(el);
    el.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 100 }) as DOMRect;
    Object.defineProperty(window, 'scrollX', { value: 5, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 400, configurable: true });
    const res = evalExpr<{ ok: boolean; x: number; y: number; width: number; height: number }>(
      buildElementRectJs({ selector: '#card' }),
    );
    expect(res).toEqual({ ok: true, x: 15, y: 420, width: 300, height: 100 });
  });

  test('scrolls instantly so smooth-scroll containers cannot leave a stale rect', () => {
    const el = document.createElement('div');
    el.id = 'card';
    document.body.appendChild(el);
    const calls: unknown[] = [];
    el.scrollIntoView = ((arg: unknown) => {
      calls.push(arg);
    }) as typeof el.scrollIntoView;
    evalExpr(buildElementRectJs({ selector: '#card' }));
    expect(calls).toEqual([{ block: 'center', inline: 'center', behavior: 'instant' }]);
  });

  test('reports not-found and invalid-selector separately', () => {
    expect(evalExpr<{ reason: string }>(buildElementRectJs({ selector: '#nope' })).reason).toBe(
      'not-found',
    );
    expect(evalExpr<{ reason: string }>(buildElementRectJs({ selector: '(' })).reason).toBe(
      'invalid-selector',
    );
  });

  test('adds same-origin iframe offsets', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 200, width: 400, height: 300 }) as DOMRect;
    const inner = frame.contentDocument!.createElement('p');
    inner.id = 'inner';
    frame.contentDocument!.body.appendChild(inner);
    inner.getBoundingClientRect = () => ({ left: 7, top: 9, width: 50, height: 20 }) as DOMRect;
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    const res = evalExpr<{ ok: boolean; x: number; y: number }>(
      buildElementRectJs({ selector: '#inner' }),
    );
    expect(res.ok).toBe(true);
    expect(res.x).toBe(107);
    expect(res.y).toBe(209);
  });
});

describe('buildExpectProbeJs', () => {
  interface Probe {
    url: string;
    selector_appears?: boolean;
    selector_disappears?: boolean;
    text_appears?: boolean;
    invalid_selector?: string;
  }
  const probe = (opts: Parameters<typeof buildExpectProbeJs>[0]): Probe =>
    evalExpr<Probe>(buildExpectProbeJs(opts));

  test('always reports the current url and nothing else when no condition is asked', () => {
    const out = probe({});
    expect(out.url).toBe(location.href);
    expect(out).not.toHaveProperty('selector_appears');
    expect(out).not.toHaveProperty('text_appears');
  });

  test('selector_appears is true only for a VISIBLE match', () => {
    document.body.innerHTML = '<div id="hidden"></div><div id="shown"></div>';
    makeVisible(document.getElementById('shown')!);
    expect(probe({ selector_appears: '#shown' }).selector_appears).toBe(true);
    expect(probe({ selector_appears: '#hidden' }).selector_appears).toBe(false);
    expect(probe({ selector_appears: '#missing' }).selector_appears).toBe(false);
  });

  test('selector_disappears is true when no visible match remains', () => {
    document.body.innerHTML = '<div id="hidden"></div><div id="shown"></div>';
    makeVisible(document.getElementById('shown')!);
    expect(probe({ selector_disappears: '#shown' }).selector_disappears).toBe(false);
    expect(probe({ selector_disappears: '#hidden' }).selector_disappears).toBe(true);
    expect(probe({ selector_disappears: '#missing' }).selector_disappears).toBe(true);
  });

  test('selector conditions pierce open shadow roots', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="deep"></button>';
    makeVisible(root.getElementById('deep')!);
    expect(probe({ selector_appears: '#deep' }).selector_appears).toBe(true);
  });

  test('an invalid selector is reported instead of silently counting as absent', () => {
    const out = probe({ selector_disappears: '##bad[' });
    expect(out.invalid_selector).toBe('selector_disappears');
    expect(out).not.toHaveProperty('selector_disappears');
  });

  test('text_appears matches case-insensitively with collapsed whitespace', () => {
    document.body.innerHTML = '<p>Lesson   <b>Complete</b></p>';
    // jsdom has no layout engine and no innerText: stub it like a browser would render it.
    Object.defineProperty(document.body, 'innerText', {
      value: 'Lesson Complete',
      configurable: true,
    });
    expect(probe({ text_appears: 'lesson complete' }).text_appears).toBe(true);
    expect(probe({ text_appears: 'nothing here' }).text_appears).toBe(false);
  });

  test('text_appears reads a shadow root only when its host and child are visible', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<p id="msg">Shadow secret</p>';
    const msg = root.getElementById('msg')!;
    expect(probe({ text_appears: 'shadow secret' }).text_appears).toBe(false);
    makeVisible(host);
    expect(probe({ text_appears: 'shadow secret' }).text_appears).toBe(false);
    makeVisible(msg);
    expect(probe({ text_appears: 'shadow secret' }).text_appears).toBe(true);
  });

  test('text_appears skips style/script/template children of a visible shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    makeVisible(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style id="s">.k{content:"cssonly"}</style><script id="j">var x="jsonly"</script><template id="t">tmplonly</template>';
    for (const id of ['s', 'j', 't']) makeVisible(root.getElementById(id)!);
    expect(probe({ text_appears: 'cssonly' }).text_appears).toBe(false);
    expect(probe({ text_appears: 'jsonly' }).text_appears).toBe(false);
    expect(probe({ text_appears: 'tmplonly' }).text_appears).toBe(false);
  });

  test('text_appears reads a same-origin iframe body only when the iframe is visible', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument!.body.textContent = 'Frame secret';
    expect(probe({ text_appears: 'frame secret' }).text_appears).toBe(false);
    makeVisible(frame);
    expect(probe({ text_appears: 'frame secret' }).text_appears).toBe(true);
  });

  test('text_appears prefers rendered innerText over textContent when innerText is a string', () => {
    document.body.innerHTML = '<p>hidden words</p>';
    // A real browser omits non-rendered text from innerText; textContent would still hold it.
    Object.defineProperty(document.body, 'innerText', { value: '', configurable: true });
    expect(probe({ text_appears: 'hidden words' }).text_appears).toBe(false);
  });
});

describe('buildWaitForSelectorJs', () => {
  /** jsdom reports a zero rect for everything; give the element a real size
   * so the visible / hidden probe sees a rendered box. */
  function giveSize(el: Element): void {
    el.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 10,
        bottom: 10,
        width: 10,
        height: 10,
        toJSON() {},
      }) as DOMRect;
  }
  const wait = (
    selector: string,
    condition: 'visible' | 'hidden' | 'attached' | 'detached',
  ): boolean => evalExpr<boolean>(buildWaitForSelectorJs(selector, condition));

  test('finds a selector inside an open shadow root as attached and visible', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="deep">Go</button>';
    giveSize(shadow.getElementById('deep')!);
    expect(wait('#deep', 'attached')).toBe(true);
    expect(wait('#deep', 'detached')).toBe(false);
    expect(wait('#deep', 'visible')).toBe(true);
    expect(wait('#deep', 'hidden')).toBe(false);
  });

  test('finds a selector inside a same-origin iframe', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument!.body.innerHTML = '<p id="in-frame">x</p>';
    expect(wait('#in-frame', 'attached')).toBe(true);
  });

  test('light-DOM attached / detached behave as before', () => {
    document.body.innerHTML = '<div id="here"></div>';
    expect(wait('#here', 'attached')).toBe(true);
    expect(wait('#here', 'detached')).toBe(false);
    expect(wait('#missing', 'attached')).toBe(false);
    expect(wait('#missing', 'detached')).toBe(true);
  });

  test('light-DOM visible / hidden behave as before', () => {
    document.body.innerHTML =
      '<div id="shown"></div><div id="none" style="display:none"></div><div id="ghost" style="visibility:hidden"></div><div id="clear" style="opacity:0"></div><div id="empty"></div>';
    for (const id of ['shown', 'none', 'ghost', 'clear']) giveSize(document.getElementById(id)!);
    expect(wait('#shown', 'visible')).toBe(true);
    expect(wait('#shown', 'hidden')).toBe(false);
    for (const id of ['#none', '#ghost', '#clear', '#empty']) {
      expect(wait(id, 'visible')).toBe(false);
      expect(wait(id, 'hidden')).toBe(true);
    }
    expect(wait('#missing', 'visible')).toBe(false);
    expect(wait('#missing', 'hidden')).toBe(true);
    // <body> stays visible: the probe is computed style plus box size, not offsetParent.
    giveSize(document.body);
    expect(wait('body', 'visible')).toBe(true);
  });

  test('an invalid selector throws, so the poll never reports a match', () => {
    for (const condition of ['visible', 'hidden', 'attached', 'detached'] as const) {
      expect(() => wait('[[bad', condition)).toThrow();
    }
  });
});

/**
 * Baseline pin for S2 of the snapshot-diff slice: when the page observer is
 * NOT installed, `snapshot`, `find` and `state` must produce exactly the
 * output they produced before refs existed. The fixture JSON was captured
 * once from the pre-ref builders on this same page; it is held literally so
 * this test never reads git history.
 */
function buildBaselinePage(): void {
  document.title = 'Baseline fixture';
  document.body.innerHTML = `
    <nav><a id="home" href="/home">Home</a></nav>
    <main id="main">
      <h1>Fixture heading</h1>
      <p>Some plain text for the dump.</p>
      <button id="save">Save changes</button>
      <button>Save draft</button>
      <a href="/docs">Docs link</a>
      <input name="q" type="search" placeholder="Search" aria-label="Search box" />
      <div id="host"></div>
    </main>`;
  const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button id="inner">Shadow action</button>';
  document.querySelectorAll('nav, main, h1, p, button, a, input, #host').forEach(makeVisible);
  makeVisible(shadow.getElementById('inner')!);
}

const baseline = baselineFixture as Record<string, unknown>;

/**
 * The pre-ref output each baseline case must still produce. The one case
 * that is cut (`max_interactive: 2` on a page with 6 entries) also says so
 * since owner decision D6: the fixture plus the `truncated` report, nothing
 * else changed. Every uncut case is the fixture as captured.
 */
const expectedBaseline = (name: string): unknown =>
  name === 'snapshot_max_interactive'
    ? {
        ...(baseline[name] as Record<string, unknown>),
        truncated: {
          interactive: 4,
          next_offset: { interactive: 2, headings: 1 },
          hint: SNAPSHOT_CUT_HINT,
        },
      }
    : baseline[name];

function captureBaselineOutputs(): Record<string, unknown> {
  buildBaselinePage();
  const out: Record<string, unknown> = {};
  out.snapshot = evalExpr(buildSnapshotJs({}));
  out.snapshot_only_interactive = evalExpr(buildSnapshotJs({ only_interactive: true }));
  out.snapshot_exclude_nav = evalExpr(buildSnapshotJs({ exclude: ['nav'] }));
  out.snapshot_within = evalExpr(buildSnapshotJs({ within_selector: '#main' }));
  out.snapshot_within_miss = evalExpr(buildSnapshotJs({ within_selector: '#nope' }));
  out.snapshot_max_interactive = evalExpr(buildSnapshotJs({ max_interactive: 2 }));
  out.find_single = evalExpr(buildFindJs({ text: 'Docs link' }));
  out.find_shadow = evalExpr(buildFindJs({ text: 'Shadow action' }));
  out.find_multi = evalExpr(buildFindJs({ text: 'Save' }));
  out.find_not_found = evalExpr(buildFindJs({ text: 'save settings' }));
  out.find_role_excluded = evalExpr(buildFindJs({ text: 'Docs', role: 'button' }));
  out.state_unfocused = evalExpr(buildStateJs());
  (document.querySelector('input[name="q"]') as HTMLInputElement).focus();
  out.state_focused = evalExpr(buildStateJs());
  (document.activeElement as HTMLElement | null)?.blur();
  return out;
}

describe('snapshot, find and state without the page observer (baseline pin)', () => {
  test('every result is byte-identical to the pre-ref output', () => {
    expect((window as unknown as Record<string, unknown>).__blPageObserver).toBeUndefined();
    const actual = captureBaselineOutputs();
    expect(Object.keys(actual)).toEqual(Object.keys(baseline));
    for (const name of Object.keys(baseline)) {
      // JSON.stringify keeps key order, so this pins field order too.
      expect(JSON.stringify(actual[name]), name).toBe(JSON.stringify(expectedBaseline(name)));
    }
  });
});

interface ObserverHandle {
  doc_id: string;
  refFor(el: Element): string | null;
}
type Json = Record<string, unknown>;

describe('snapshot, find and state with the page observer (refs, doc_id, snapshot_id)', () => {
  const win = window as unknown as Record<string, unknown>;
  let docId = '';

  beforeEach(() => {
    win[OBSERVER_BINDING] = () => undefined;
    evalExpr(buildObserverInstallJs());
    docId = (win[OBSERVER_GLOBAL] as ObserverHandle).doc_id;
  });

  afterEach(() => {
    evalExpr(buildObserverTeardownJs());
    delete win[OBSERVER_BINDING];
  });

  const refPattern = /^[a-z0-9]{1,6}:e\d+$/;

  test('snapshot entries carry a ref right after selector, shadow-root entries included', () => {
    buildBaselinePage();
    const snapshot = evalExpr<{ interactive: Json[] }>(buildSnapshotJs({}));
    expect(snapshot.interactive.length).toBe(6);
    for (const entry of snapshot.interactive) {
      expect(entry.ref).toMatch(refPattern);
      const keys = Object.keys(entry);
      expect(keys[keys.indexOf('selector') + 1]).toBe('ref');
    }
    const shadowEntry = snapshot.interactive.find((e) => e.text === 'Shadow action')!;
    const inner = document.getElementById('host')!.shadowRoot!.getElementById('inner')!;
    expect(shadowEntry.ref).toBe((win[OBSERVER_GLOBAL] as ObserverHandle).refFor(inner));
  });

  test('the same element keeps the same ref across two snapshots', () => {
    buildBaselinePage();
    const first = evalExpr<{ interactive: Json[] }>(buildSnapshotJs({}));
    const second = evalExpr<{ interactive: Json[] }>(buildSnapshotJs({}));
    expect(second.interactive.map((e) => e.ref)).toEqual(first.interactive.map((e) => e.ref));
    expect(new Set(first.interactive.map((e) => e.ref)).size).toBe(first.interactive.length);
  });

  test('snapshot results carry doc_id and a snapshot_id that increments per call', () => {
    buildBaselinePage();
    const first = evalExpr<Json>(buildSnapshotJs({}));
    const second = evalExpr<Json>(buildSnapshotJs({ only_interactive: true }));
    expect(first.doc_id).toBe(docId);
    expect(first.snapshot_id).toBe(docId + ':s1');
    expect(second.doc_id).toBe(docId);
    expect(second.snapshot_id).toBe(docId + ':s2');
  });

  test('find single match, candidates and near_misses carry ref; find carries doc_id only', () => {
    buildBaselinePage();
    const single = evalExpr<Json>(buildFindJs({ text: 'Docs link' }));
    expect(single.ref).toMatch(refPattern);
    expect(Object.keys(single).slice(0, 3)).toEqual(['matched', 'selector', 'ref']);
    expect(single.doc_id).toBe(docId);
    expect(single.snapshot_id).toBeUndefined();

    const multi = evalExpr<{ candidates: Json[]; doc_id: string }>(buildFindJs({ text: 'Save' }));
    expect(multi.candidates.map((c) => Object.keys(c))).toEqual([
      ['selector', 'ref', 'text', 'tag'],
      ['selector', 'ref', 'text', 'tag'],
    ]);
    expect(multi.doc_id).toBe(docId);

    const miss = evalExpr<{ near_misses: Json[]; doc_id: string }>(
      buildFindJs({ text: 'save settings' }),
    );
    expect(miss.near_misses.length).toBe(2);
    for (const nm of miss.near_misses) {
      expect(nm.ref).toMatch(refPattern);
      expect(Object.keys(nm).slice(0, 3)).toEqual(['text', 'selector', 'ref']);
    }
    expect(miss.doc_id).toBe(docId);

    // The same element answers with the same ref from find and snapshot.
    const snapshot = evalExpr<{ interactive: Json[] }>(buildSnapshotJs({}));
    const docsEntry = snapshot.interactive.find((e) => e.text === 'Docs link')!;
    expect(docsEntry.ref).toBe(single.ref);
  });

  test('state.focused carries ref and the state result carries doc_id', () => {
    buildBaselinePage();
    const input = document.querySelector('input[name="q"]') as HTMLInputElement;
    input.focus();
    const state = evalExpr<{ focused: Json; doc_id: string }>(buildStateJs());
    expect(Object.keys(state.focused)).toEqual(['selector', 'ref', 'tag']);
    expect(state.focused.ref).toBe((win[OBSERVER_GLOBAL] as ObserverHandle).refFor(input));
    expect(state.doc_id).toBe(docId);
    input.blur();
  });

  test('a ref of null leaves the entry without a ref key', () => {
    buildBaselinePage();
    const g = win[OBSERVER_GLOBAL] as ObserverHandle;
    const original = g.refFor;
    g.refFor = () => null;
    try {
      const snapshot = evalExpr<{ interactive: Json[]; doc_id: string }>(buildSnapshotJs({}));
      expect(snapshot.interactive.every((e) => !('ref' in e))).toBe(true);
      expect(snapshot.doc_id).toBe(docId);
    } finally {
      g.refFor = original;
    }
  });

  test('a dead observer adds nothing: output equals the baseline', () => {
    const g = win[OBSERVER_GLOBAL] as ObserverHandle & { dead: boolean };
    g.dead = true;
    try {
      const actual = captureBaselineOutputs();
      for (const name of Object.keys(baseline)) {
        expect(JSON.stringify(actual[name]), name).toBe(JSON.stringify(expectedBaseline(name)));
      }
    } finally {
      g.dead = false;
    }
  });

  test('filters and max_interactive behave as before: stripping the new fields gives the baseline', () => {
    const actual = captureBaselineOutputs();
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip);
      if (value && typeof value === 'object') {
        const out: Json = {};
        for (const [k, v] of Object.entries(value)) {
          if (k === 'ref' || k === 'doc_id' || k === 'snapshot_id' || k === 'semantic_key')
            continue;
          out[k] = strip(v);
        }
        return out;
      }
      return value;
    };
    for (const name of Object.keys(baseline)) {
      expect(JSON.stringify(strip(actual[name])), name).toBe(
        JSON.stringify(expectedBaseline(name)),
      );
    }
    const capped = actual.snapshot_max_interactive as { interactive: Json[] };
    expect(capped.interactive.length).toBe(2);
    expect(capped.interactive.every((e) => refPattern.test(String(e.ref)))).toBe(true);
  });
});

/**
 * `snapshot({ since })` (spec v4 §6.2): the observer keeps the last 4
 * snapshot records per document, and a `since` call answers with the
 * entries added, removed and changed by ref against that record.
 */
describe('buildSnapshotJs — since diff', () => {
  const win = window as unknown as Record<string, unknown>;
  let docId = '';
  const sid = (n: number): string => docId + ':s' + n;

  function buildDiffPage(): void {
    document.title = 'Diff fixture';
    document.body.innerHTML = `
      <main id="main">
        <h1 id="title">Inbox</h1>
        <button id="a">Alpha</button>
        <button id="b">Beta</button>
        <ul id="list"></ul>
      </main>`;
    document.querySelectorAll('main, h1, button').forEach(makeVisible);
  }

  function addButton(id: string, text: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = id;
    btn.textContent = text;
    document.getElementById('list')!.appendChild(btn);
    makeVisible(btn);
    return btn;
  }

  function install(): void {
    win[OBSERVER_BINDING] = () => undefined;
    evalExpr(buildObserverInstallJs());
    docId = (win[OBSERVER_GLOBAL] as ObserverHandle).doc_id;
  }

  beforeEach(() => {
    install();
    buildDiffPage();
  });

  afterEach(() => {
    evalExpr(buildObserverTeardownJs());
    delete win[OBSERVER_BINDING];
  });

  test('two snapshots of an idle page diff to empty', () => {
    const first = evalExpr<Json>(buildSnapshotJs({}));
    const diff = evalExpr<Json>(buildSnapshotJs({ since: first.snapshot_id as string }));
    expect(diff).toEqual({
      title: 'Diff fixture',
      url: location.href,
      doc_id: docId,
      snapshot_id: sid(2),
      since: sid(1),
      added: [],
      removed: [],
      changed: [],
    });
    expect(Object.keys(diff)).toEqual([
      'title',
      'url',
      'doc_id',
      'snapshot_id',
      'since',
      'added',
      'removed',
      'changed',
    ]);
  });

  test('an inserted button is reported as exactly one added entry with its ref', () => {
    evalExpr(buildSnapshotJs({}));
    const btn = addButton('c', 'Gamma');
    const diff = evalExpr<{ added: Json[]; removed: Json[]; changed: Json[] }>(
      buildSnapshotJs({ since: sid(1) }),
    );
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([
      {
        tag: 'button',
        role: 'button',
        selector: '#c',
        ref: (win[OBSERVER_GLOBAL] as ObserverHandle).refFor(btn),
        text: 'Gamma',
      },
    ]);
  });

  test('a changed text is one changed entry with the current text', () => {
    evalExpr(buildSnapshotJs({}));
    document.getElementById('b')!.textContent = 'Beta two';
    const diff = evalExpr<{ added: Json[]; removed: Json[]; changed: Json[] }>(
      buildSnapshotJs({ since: sid(1) }),
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ selector: '#b', text: 'Beta two' });
  });

  test('a removed button is one removed entry with its old ref, tag and text', () => {
    const first = evalExpr<{ interactive: Json[] }>(buildSnapshotJs({}));
    const oldRef = first.interactive.find((e) => e.selector === '#b')!.ref;
    document.getElementById('b')!.remove();
    const diff = evalExpr<{ added: Json[]; removed: Json[]; changed: Json[] }>(
      buildSnapshotJs({ since: sid(1) }),
    );
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([{ ref: oldRef, tag: 'button', text: 'Beta' }]);
  });

  test('a since from a previous document gives a full snapshot with since_status doc-changed', () => {
    evalExpr(buildSnapshotJs({}));
    const old = evalExpr<Json>(buildSnapshotJs({})).snapshot_id as string;
    evalExpr(buildObserverTeardownJs());
    install();
    const result = evalExpr<Json>(buildSnapshotJs({ since: old }));
    expect(Array.isArray(result.interactive)).toBe(true);
    expect((result.interactive as Json[]).length).toBe(2);
    expect(result.doc_id).toBe(docId);
    expect(result.snapshot_id).toBe(sid(1));
    expect(result.since).toBe(old);
    expect(result.since_status).toBe('doc-changed');
    expect(result.added).toBeUndefined();
  });

  test('a since with the current doc_id but an unknown number gives since_status evicted', () => {
    evalExpr(buildSnapshotJs({}));
    const result = evalExpr<Json>(buildSnapshotJs({ since: sid(99) }));
    expect((result.interactive as Json[]).length).toBe(2);
    expect(result.doc_id).toBe(docId);
    expect(result.snapshot_id).toBe(sid(2));
    expect(result.since).toBe(sid(99));
    expect(result.since_status).toBe('evicted');
  });

  test('a since without a doc_id prefix is treated as another document', () => {
    evalExpr(buildSnapshotJs({}));
    const result = evalExpr<Json>(buildSnapshotJs({ since: 's1' }));
    expect(result.doc_id).toBe(docId);
    expect(result.since).toBe('s1');
    expect(result.since_status).toBe('doc-changed');
  });
  test('an evicted id gives a full snapshot with since_status evicted', () => {
    for (let i = 0; i < 5; i++) evalExpr(buildSnapshotJs({}));
    const result = evalExpr<Json>(buildSnapshotJs({ since: sid(1) }));
    expect((result.interactive as Json[]).length).toBe(2);
    expect(result.snapshot_id).toBe(sid(6));
    expect(result.since).toBe(sid(1));
    expect(result.since_status).toBe('evicted');
  });

  test('without the observer a since gives a full snapshot with since_status observer-unavailable', () => {
    evalExpr(buildObserverTeardownJs());
    const result = evalExpr<Json>(buildSnapshotJs({ since: sid(1) }));
    expect((result.interactive as Json[]).length).toBe(2);
    expect(result.doc_id).toBeUndefined();
    expect(result.snapshot_id).toBeUndefined();
    expect(result.since).toBe(sid(1));
    expect(result.since_status).toBe('observer-unavailable');
  });

  test('max_interactive applies after diffing: 3 added with a cap of 1 keeps 1, overflow 2', () => {
    evalExpr(buildSnapshotJs({}));
    addButton('c', 'Gamma');
    addButton('d', 'Delta');
    addButton('e', 'Epsilon');
    const diff = evalExpr<{ added: Json[]; changed: Json[]; overflow: number }>(
      buildSnapshotJs({ since: sid(1), max_interactive: 1 }),
    );
    expect(diff.added.map((e) => e.selector)).toEqual(['#c']);
    expect(diff.changed).toEqual([]);
    expect(diff.overflow).toBe(2);
  });

  test('headings and text are omitted when unchanged and headings return when a heading changed', () => {
    evalExpr(buildSnapshotJs({}));
    const idle = evalExpr<Json>(buildSnapshotJs({ since: sid(1) }));
    expect('headings' in idle).toBe(false);
    expect('text' in idle).toBe(false);
    document.getElementById('title')!.textContent = 'Archive';
    const diff = evalExpr<Json>(buildSnapshotJs({ since: sid(2) }));
    expect(diff.headings).toEqual([{ level: 'H1', text: 'Archive' }]);
  });

  test('only_interactive never reports headings or text in a diff', () => {
    evalExpr(buildSnapshotJs({}));
    document.getElementById('title')!.textContent = 'Archive';
    const diff = evalExpr<Json>(buildSnapshotJs({ since: sid(1), only_interactive: true }));
    expect('headings' in diff).toBe(false);
    expect('text' in diff).toBe(false);
  });

  test('a snapshot without since keeps its shape and still records for a later since', () => {
    // Cut by max_interactive, so it says so (owner decision D6) before doc_id.
    const full = evalExpr<Json>(buildSnapshotJs({ max_interactive: 1 }));
    expect(Object.keys(full)).toEqual([
      'title',
      'url',
      'interactive',
      'headings',
      'truncated',
      'doc_id',
      'snapshot_id',
    ]);
    expect((full.interactive as Json[]).length).toBe(1);
    expect(full.truncated).toEqual({
      interactive: 1,
      next_offset: { interactive: 1, headings: 1 },
      hint: SNAPSHOT_CUT_HINT,
    });
    const whole = evalExpr<Json>(buildSnapshotJs({}));
    expect(Object.keys(whole)).toEqual([
      'title',
      'url',
      'interactive',
      'headings',
      'doc_id',
      'snapshot_id',
    ]);
    const diff = evalExpr<Json>(buildSnapshotJs({ since: sid(1) }));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test('a within_selector miss ignores since and keeps its shape plus doc_id', () => {
    evalExpr(buildSnapshotJs({}));
    const miss = evalExpr<Json>(buildSnapshotJs({ within_selector: '#nope', since: sid(1) }));
    expect(miss).toEqual({
      title: 'Diff fixture',
      url: location.href,
      interactive: [],
      notice: 'within_selector did not match any element',
      doc_id: docId,
    });
  });
});

/**
 * `ref` as a target (spec v4 §6.3): the selector-taking builders also accept
 * an observer ref. A live ref resolves to its node; a node replaced by a
 * re-render is re-resolved by its semantic key (`reresolved: true`); a ref
 * with no unique candidate is `ref-stale` and names the `doc_id`; without
 * the observer the ref cannot be resolved at all (`observer-unavailable`).
 */
describe('ref as a target (click, type, focus, rect, wait_for, find)', () => {
  const win = window as unknown as Record<string, unknown>;
  const BUTTONS = '<li><button>Alpha</button></li><li><button>Beta</button></li>';
  const INPUTS = '<li><input aria-label="Alpha" /></li><li><input aria-label="Beta" /></li>';
  let docId = '';

  function install(items: string): void {
    document.body.innerHTML = '<ul id="list">' + items + '</ul>';
    win[OBSERVER_BINDING] = () => undefined;
    evalExpr(buildObserverInstallJs());
    docId = (win[OBSERVER_GLOBAL] as ObserverHandle).doc_id;
    // jsdom has no hit-testing; null fails the occlusion check open.
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () =>
      null;
  }
  // A click target needs a box (see giveBox); without one it is refused or
  // clicked programmatically (owner decision D4).
  const boxEveryButton = (): void => {
    for (const el of document.querySelectorAll('#list button')) giveBox(el);
  };
  const second = (): HTMLElement =>
    document.querySelectorAll<HTMLElement>('#list li')[1].firstElementChild as HTMLElement;
  const refOfSecond = (): string => (win[OBSERVER_GLOBAL] as ObserverHandle).refFor(second())!;
  const rerender = (items: string): void => {
    document.getElementById('list')!.innerHTML = items;
  };
  const removeSecond = (): void => {
    document.querySelectorAll('#list li')[1].remove();
  };

  afterEach(() => {
    evalExpr(buildObserverTeardownJs());
    delete win[OBSERVER_BINDING];
  });

  test('click by a live ref gives the same result as by selector and targets that node', () => {
    install(BUTTONS);
    boxEveryButton();
    const ref = refOfSecond();
    const bySelector = evalExpr<Json>(
      buildClickResolveJs({ selector: '#list li:nth-of-type(2) button', force: false }),
    );
    let scrolled: Element | null = null;
    second().scrollIntoView = function (this: Element) {
      scrolled = this;
    };
    const byRef = evalExpr<Json>(buildClickResolveJs({ ref, force: false }));
    expect(byRef).toEqual(bySelector);
    expect(byRef.reresolved).toBeUndefined();
    expect(scrolled).toBe(second());
  });

  test('click by ref after a replacing re-render resolves the new node with reresolved', () => {
    install(BUTTONS);
    const ref = refOfSecond();
    const old = second();
    rerender(BUTTONS);
    boxEveryButton();
    const fresh = second();
    expect(fresh).not.toBe(old);
    let scrolled: Element | null = null;
    fresh.scrollIntoView = function (this: Element) {
      scrolled = this;
    };
    const resolved = evalExpr<Json>(buildClickResolveJs({ ref, force: false }));
    expect(resolved).toEqual({ ok: true, x: 140, y: 210, tag: 'button', reresolved: true });
    expect(scrolled).toBe(fresh);
    // The rebind is done: the next resolution is a plain live hit.
    expect(evalExpr<Json>(buildClickResolveJs({ ref, force: false })).reresolved).toBeUndefined();
  });

  test('click by a stale ref is ref-stale and names the doc_id', () => {
    install(BUTTONS);
    const ref = refOfSecond();
    removeSecond();
    expect(evalExpr<Json>(buildClickResolveJs({ ref, force: false }))).toEqual({
      ok: false,
      reason: 'ref-stale',
      ref,
      doc_id: docId,
    });
    const unknown = docId.slice(0, 6) + ':e999';
    expect(evalExpr<Json>(buildClickResolveJs({ ref: unknown, force: false }))).toEqual({
      ok: false,
      reason: 'ref-stale',
      ref: unknown,
      doc_id: docId,
    });
  });

  test('click by a ref from a torn-down document is ref-stale although the new one issued the same number', () => {
    install(BUTTONS);
    const first = document.querySelector<HTMLElement>('#list button')!;
    const oldRef = (win[OBSERVER_GLOBAL] as ObserverHandle).refFor(first)!;
    const oldDoc = docId;
    evalExpr(buildObserverTeardownJs());
    evalExpr(buildObserverInstallJs());
    docId = (win[OBSERVER_GLOBAL] as ObserverHandle).doc_id;
    expect(docId).not.toBe(oldDoc);
    const newRef = refOfSecond();
    expect(newRef.slice(newRef.indexOf(':'))).toBe(oldRef.slice(oldRef.indexOf(':')));
    expect(newRef).not.toBe(oldRef);
    expect(evalExpr<Json>(buildClickResolveJs({ ref: oldRef, force: false }))).toEqual({
      ok: false,
      reason: 'ref-stale',
      ref: oldRef,
      doc_id: docId,
    });
    expect(evalExpr<Json>(buildClickResolveJs({ ref: 'e1', force: false }))).toEqual({
      ok: false,
      reason: 'ref-stale',
      ref: 'e1',
      doc_id: docId,
    });
  });

  test('click by ref without the observer is observer-unavailable', () => {
    install(BUTTONS);
    const ref = refOfSecond();
    evalExpr(buildObserverTeardownJs());
    expect(evalExpr<Json>(buildClickResolveJs({ ref, force: false }))).toEqual({
      ok: false,
      reason: 'observer-unavailable',
    });
  });

  test('type by ref focuses the node, clears it, and re-resolves after a re-render', () => {
    install(INPUTS);
    const ref = refOfSecond();
    (second() as HTMLInputElement).value = 'old';
    expect(evalExpr<Json>(buildTypeResolveJs({ ref, clear: true }))).toEqual({ ok: true });
    expect(document.activeElement).toBe(second());
    expect((second() as HTMLInputElement).value).toBe('');
    rerender(INPUTS);
    expect(evalExpr<Json>(buildTypeResolveJs({ ref, clear: false }))).toEqual({
      ok: true,
      reresolved: true,
    });
    expect(document.activeElement).toBe(second());
    removeSecond();
    expect(evalExpr<Json>(buildTypeResolveJs({ ref, clear: false }))).toEqual({
      ok: false,
      reason: 'ref-stale',
      ref,
      doc_id: docId,
    });
    evalExpr(buildObserverTeardownJs());
    expect(evalExpr<Json>(buildTypeResolveJs({ ref, clear: false }))).toEqual({
      ok: false,
      reason: 'observer-unavailable',
    });
  });

  test('focus by ref answers an object (selector mode keeps its boolean)', () => {
    install(INPUTS);
    const ref = refOfSecond();
    expect(evalExpr<Json>(buildFocusJs({ ref }))).toEqual({ ok: true });
    expect(document.activeElement).toBe(second());
    (document.activeElement as HTMLElement).blur();
    rerender(INPUTS);
    expect(evalExpr<Json>(buildFocusJs({ ref }))).toEqual({ ok: true, reresolved: true });
    expect(document.activeElement).toBe(second());
    removeSecond();
    expect(evalExpr<Json>(buildFocusJs({ ref }))).toEqual({
      ok: false,
      reason: 'ref-stale',
      ref,
      doc_id: docId,
    });
    expect(evalExpr<boolean>(buildFocusJs({ selector: '#list input' }))).toBe(true);
    expect(evalExpr<boolean>(buildFocusJs({ selector: '#nope' }))).toBe(false);
    evalExpr(buildObserverTeardownJs());
    expect(evalExpr<Json>(buildFocusJs({ ref }))).toEqual({
      ok: false,
      reason: 'observer-unavailable',
    });
  });

  test('element rect by ref equals the selector rect; stale ref is ref-stale', () => {
    install(BUTTONS);
    const ref = refOfSecond();
    const bySelector = evalExpr<Json>(
      buildElementRectJs({ selector: '#list li:nth-of-type(2) button' }),
    );
    expect(evalExpr<Json>(buildElementRectJs({ ref }))).toEqual(bySelector);
    rerender(BUTTONS);
    expect(evalExpr<Json>(buildElementRectJs({ ref }))).toEqual({
      ...bySelector,
      reresolved: true,
    });
    removeSecond();
    expect(evalExpr<Json>(buildElementRectJs({ ref }))).toEqual({
      ok: false,
      reason: 'ref-stale',
      ref,
      doc_id: docId,
    });
  });

  test('wait_for by ref: live, re-resolved and stale semantics per condition', () => {
    install(BUTTONS);
    const ref = refOfSecond();
    const wait = (condition: 'visible' | 'hidden' | 'attached' | 'detached'): unknown =>
      evalExpr(buildWaitForSelectorJs({ ref }, condition));
    const giveSize = (el: Element): void => {
      el.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 10,
          bottom: 10,
          width: 10,
          height: 10,
          toJSON() {},
        }) as DOMRect;
    };
    giveSize(second());
    expect(wait('attached')).toBe(true);
    expect(wait('detached')).toBe(false);
    expect(wait('visible')).toBe(true);
    expect(wait('hidden')).toBe(false);
    rerender(BUTTONS);
    expect(wait('attached')).toBe(true);
    // The fresh node has no box yet: hidden, not visible.
    expect(wait('visible')).toBe(false);
    expect(wait('hidden')).toBe(true);
    removeSecond();
    // Gone: `detached` and `hidden` are met; `visible` and `attached` answer
    // the failure (not false) so the caller can say the element is gone.
    const gone = { ok: false, reason: 'ref-stale', ref, doc_id: docId, doc_changed: false };
    expect(wait('attached')).toEqual(gone);
    expect(wait('detached')).toBe(true);
    expect(wait('hidden')).toBe(true);
    expect(wait('visible')).toEqual(gone);
  });

  test('wait_for by a ref of another document: doc_changed says it can never come back', () => {
    install(BUTTONS);
    const foreign = 'zzzzzz:e1';
    expect(docId.slice(0, 6)).not.toBe('zzzzzz');
    for (const condition of ['visible', 'attached'] as const) {
      expect(evalExpr(buildWaitForSelectorJs({ ref: foreign }, condition))).toEqual({
        ok: false,
        reason: 'ref-stale',
        ref: foreign,
        doc_id: docId,
        doc_changed: true,
      });
    }
    for (const condition of ['hidden', 'detached'] as const) {
      expect(evalExpr(buildWaitForSelectorJs({ ref: foreign }, condition))).toBe(true);
    }
  });

  test('wait_for by ref without the observer answers observer-unavailable, never a boolean', () => {
    install(BUTTONS);
    const ref = refOfSecond();
    evalExpr(buildObserverTeardownJs());
    for (const condition of ['visible', 'hidden', 'attached', 'detached'] as const) {
      expect(evalExpr(buildWaitForSelectorJs({ ref }, condition))).toEqual({
        ok: false,
        reason: 'observer-unavailable',
      });
    }
  });

  test('wait_for with a selector string builds the selector-only source (no observer code)', () => {
    const source = buildWaitForSelectorJs('#panel .row', 'visible');
    expect(source).not.toContain('resolveTarget');
    expect(source).not.toContain(OBSERVER_GLOBAL);
  });

  test('find by ref gives the single-match shape for that element', () => {
    install(BUTTONS);
    makeVisible(second());
    const ref = refOfSecond();
    const found = evalExpr<Json>(buildFindJs({ ref }));
    expect(found).toEqual({
      matched: true,
      selector: expect.any(String),
      ref,
      coords: { x: 0, y: 0 },
      tag: 'button',
      text: 'Beta',
      semantic_key: expect.objectContaining({ role: 'button', name: 'Beta' }),
      doc_id: docId,
    });
    expect(Object.keys(found)).toEqual([
      'matched',
      'selector',
      'ref',
      'coords',
      'tag',
      'text',
      'semantic_key',
      'doc_id',
    ]);
    expect(document.querySelector(found.selector as string)).toBe(second());
    rerender(BUTTONS);
    const again = evalExpr<Json>(buildFindJs({ ref }));
    expect(again.reresolved).toBe(true);
    expect(again.ref).toBe(ref);
    expect(document.querySelector(again.selector as string)).toBe(second());
  });

  test('find by an unknown ref is ref-stale; without the observer it is observer-unavailable', () => {
    install(BUTTONS);
    const unknown = docId.slice(0, 6) + ':e999';
    expect(evalExpr<Json>(buildFindJs({ ref: unknown }))).toEqual({
      matched: false,
      reason: 'ref-stale',
      ref: unknown,
      doc_id: docId,
    });
    evalExpr(buildObserverTeardownJs());
    expect(evalExpr<Json>(buildFindJs({ ref: 'k3x9ab:e1' }))).toEqual({
      matched: false,
      reason: 'observer-unavailable',
      ref: 'k3x9ab:e1',
    });
  });
});

/**
 * Semantic keys on `find` (spec v4 §6.3, S3): a third targeting mode by
 * `key` (`{ role, name, path? }`, the observer's `semanticKeyFor` shape) and
 * `semantic_key` on every single-match result while the observer is present.
 */
describe('find by semantic key and semantic_key on find results', () => {
  const win = window as unknown as Record<string, unknown>;
  const LIST =
    '<li><button>Alpha</button></li><li><button>Beta</button></li><li><button>Beta</button></li>';
  interface KeyedObserver extends ObserverHandle {
    semanticKeyFor(el: Element): { role: string; name: string; path: Json[] } | null;
  }
  const observer = (): KeyedObserver => win[OBSERVER_GLOBAL] as KeyedObserver;
  const item = (i: number): HTMLElement =>
    document.querySelectorAll<HTMLElement>('#list li')[i].firstElementChild as HTMLElement;
  let docId = '';

  function install(): void {
    document.body.innerHTML = '<ul id="list">' + LIST + '</ul>';
    document.querySelectorAll('button').forEach(makeVisible);
    win[OBSERVER_BINDING] = () => undefined;
    evalExpr(buildObserverInstallJs());
    docId = observer().doc_id;
  }

  afterEach(() => {
    evalExpr(buildObserverTeardownJs());
    delete win[OBSERVER_BINDING];
  });

  test('find by key with path gives the single-match shape with ref and semantic_key', () => {
    install();
    const key = observer().semanticKeyFor(item(0))!;
    expect(key).toEqual({
      role: 'button',
      name: 'Alpha',
      path: [
        { tag: 'body', index: 1 },
        { tag: 'ul', index: 1 },
        { tag: 'li', index: 1 },
        { tag: 'button', index: 1 },
      ],
    });
    const found = evalExpr<Json>(buildFindJs({ key }));
    expect(Object.keys(found)).toEqual([
      'matched',
      'selector',
      'ref',
      'coords',
      'tag',
      'text',
      'semantic_key',
      'doc_id',
    ]);
    expect(found.matched).toBe(true);
    expect(found.ref).toBe(observer().refFor(item(0)));
    expect(found.semantic_key).toEqual(key);
    expect(found.tag).toBe('button');
    expect(found.text).toBe('Alpha');
    expect(found.doc_id).toBe(docId);
    expect(document.querySelector(found.selector as string)).toBe(item(0));
  });

  test('with path, two identical rows (same role, name and tag path) are not-found with the count', () => {
    install();
    const key = observer().semanticKeyFor(item(2))!;
    expect(evalExpr<Json>(buildFindJs({ key }))).toEqual({
      matched: false,
      reason: 'not-found',
      error: 'key: 2 candidates share role, name and tag path',
      doc_id: docId,
    });
  });

  test('with path, a unique same-tag-path candidate matches whatever its sibling indices', () => {
    install();
    const key = observer().semanticKeyFor(item(0))!;
    const moved = { ...key, path: key.path.map((step) => ({ ...step, index: 7 })) };
    const found = evalExpr<Json>(buildFindJs({ key: moved }));
    expect(found.matched).toBe(true);
    expect(document.querySelector(found.selector as string)).toBe(item(0));
  });

  test('two candidates with the same role and name and no path: not-found naming the count', () => {
    install();
    expect(evalExpr<Json>(buildFindJs({ key: { role: 'button', name: 'Beta' } }))).toEqual({
      matched: false,
      reason: 'not-found',
      error: 'key: 2 candidates share role and name; pass path to disambiguate',
      doc_id: docId,
    });
  });

  test('a unique role and name matches without path', () => {
    install();
    const found = evalExpr<Json>(buildFindJs({ key: { role: 'button', name: 'Alpha' } }));
    expect(found.matched).toBe(true);
    expect(document.querySelector(found.selector as string)).toBe(item(0));
  });

  test('a key for a missing element is a plain not-found', () => {
    install();
    expect(evalExpr<Json>(buildFindJs({ key: { role: 'button', name: 'Gamma' } }))).toEqual({
      matched: false,
      reason: 'not-found',
      doc_id: docId,
    });
  });

  test('a path whose tags differ from every candidate is not-found', () => {
    install();
    const key = {
      role: 'button',
      name: 'Beta',
      path: [
        { tag: 'body', index: 1 },
        { tag: 'div', index: 1 },
        { tag: 'button', index: 1 },
      ],
    };
    const found = evalExpr<Json>(buildFindJs({ key }));
    expect(found.matched).toBe(false);
    expect(found.reason).toBe('not-found');
    expect(found.error).toBe('key: 2 candidates share role and name; none has the same tag path');
  });

  test('without the observer, find by key is observer-unavailable', () => {
    document.body.innerHTML = '<ul id="list">' + LIST + '</ul>';
    expect(win[OBSERVER_GLOBAL]).toBeUndefined();
    expect(evalExpr<Json>(buildFindJs({ key: { role: 'button', name: 'Alpha' } }))).toEqual({
      matched: false,
      reason: 'observer-unavailable',
    });
    win[OBSERVER_BINDING] = () => undefined;
    evalExpr(buildObserverInstallJs());
  });

  test('text-mode and ref-mode single matches carry semantic_key; candidates do not', () => {
    install();
    const byText = evalExpr<Json>(buildFindJs({ text: 'Alpha' }));
    expect(byText.semantic_key).toEqual(observer().semanticKeyFor(item(0)));
    const ref = observer().refFor(item(1))!;
    const byRef = evalExpr<Json>(buildFindJs({ ref }));
    expect(byRef.semantic_key).toEqual(observer().semanticKeyFor(item(1)));
    const multi = evalExpr<{ candidates: Json[] }>(buildFindJs({ text: 'Beta' }));
    expect(multi.candidates.length).toBe(2);
    for (const c of multi.candidates) expect(c).not.toHaveProperty('semantic_key');
    const miss = evalExpr<{ near_misses?: Json[] }>(buildFindJs({ text: 'Alphabet' }));
    for (const nm of miss.near_misses ?? []) expect(nm).not.toHaveProperty('semantic_key');
  });

  test('a snapshot entry does not carry semantic_key', () => {
    install();
    const snapshot = evalExpr<{ interactive: Json[] }>(buildSnapshotJs({}));
    expect(snapshot.interactive.length).toBe(3);
    for (const e of snapshot.interactive) expect(e).not.toHaveProperty('semantic_key');
  });
});

/**
 * Owner decision D6: a result that was cut says so, says how much was left
 * out, says that more can be asked for and recommends narrowing the scope;
 * `offset` asks for the rest. A result that was not cut is unchanged.
 */
describe('snapshot and find say when they cut (D6)', () => {
  const pageTitle = 'Cut fixture';

  function addButtons(count: number, label = 'Item'): void {
    for (let i = 0; i < count; i++) {
      const btn = document.createElement('button');
      btn.id = 'b' + i;
      btn.textContent = label + ' ' + i;
      document.body.appendChild(btn);
      makeVisible(btn);
    }
  }

  function addHeadings(count: number): void {
    for (let i = 0; i < count; i++) {
      const h = document.createElement('h2');
      h.textContent = 'Heading ' + i;
      document.body.appendChild(h);
      makeVisible(h);
    }
  }

  /** jsdom has no layout, so no innerText: give the body one. */
  function setBodyText(text: string): void {
    Object.defineProperty(document.body, 'innerText', { value: text, configurable: true });
  }

  const buttonEntry = (i: number, label = 'Item'): Json => ({
    tag: 'button',
    role: 'button',
    selector: '#b' + i,
    text: label + ' ' + i,
  });
  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from }, (_, k) => from + k);
  const headingEntry = (i: number): Json => ({ level: 'H2', text: 'Heading ' + i });
  const pattern = (length: number): string => 'abcdefghij'.repeat(length / 10);

  beforeEach(() => {
    document.title = pageTitle;
  });

  afterEach(() => {
    delete (document.body as unknown as Record<string, unknown>).innerText;
  });

  // JSON.stringify keeps key order, so every comparison below pins field order too.
  const same = (actual: unknown, expected: unknown): void =>
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));

  test('interactive: 130 elements with the default cap of 120 say 10 were left out', () => {
    addButtons(130);
    same(evalExpr(buildSnapshotJs({})), {
      title: pageTitle,
      url: location.href,
      interactive: range(0, 120).map((i) => buttonEntry(i)),
      headings: [],
      truncated: {
        interactive: 10,
        next_offset: { interactive: 120 },
        hint: SNAPSHOT_CUT_HINT,
      },
    });
  });

  test("interactive: exactly 120 elements is not cut and keeps today's shape", () => {
    addButtons(120);
    same(evalExpr(buildSnapshotJs({})), {
      title: pageTitle,
      url: location.href,
      interactive: range(0, 120).map((i) => buttonEntry(i)),
      headings: [],
    });
  });

  test('headings: 40 headings say 10 were left out', () => {
    addButtons(1);
    addHeadings(40);
    same(evalExpr(buildSnapshotJs({})), {
      title: pageTitle,
      url: location.href,
      interactive: [buttonEntry(0)],
      headings: range(0, 30).map(headingEntry),
      truncated: {
        headings: 10,
        next_offset: { interactive: 1, headings: 30 },
        hint: SNAPSHOT_CUT_HINT,
      },
    });
  });

  test("headings: exactly 30 headings is not cut and keeps today's shape", () => {
    addButtons(1);
    addHeadings(30);
    same(evalExpr(buildSnapshotJs({})), {
      title: pageTitle,
      url: location.href,
      interactive: [buttonEntry(0)],
      headings: range(0, 30).map(headingEntry),
    });
  });

  test('text: 10000 characters say 6000 characters were left out', () => {
    const full = pattern(10000);
    setBodyText(full);
    same(evalExpr(buildSnapshotJs({})), {
      title: pageTitle,
      url: location.href,
      interactive: [],
      headings: [],
      text: full.slice(0, 4000),
      truncated: {
        text: 6000,
        next_offset: { text: 4000 },
        hint: SNAPSHOT_CUT_HINT,
      },
    });
  });

  test("text: exactly 4000 characters is not cut and keeps today's shape", () => {
    const full = pattern(4000);
    setBodyText(full);
    same(evalExpr(buildSnapshotJs({})), {
      title: pageTitle,
      url: location.href,
      interactive: [],
      headings: [],
      text: full,
    });
  });

  test('only_interactive reports only the interactive cut', () => {
    addButtons(3);
    addHeadings(40);
    setBodyText(pattern(10000));
    same(evalExpr(buildSnapshotJs({ only_interactive: true, max_interactive: 2 })), {
      title: pageTitle,
      url: location.href,
      interactive: [buttonEntry(0), buttonEntry(1)],
      truncated: {
        interactive: 1,
        next_offset: { interactive: 2 },
        hint: SNAPSHOT_CUT_HINT,
      },
    });
  });

  test('the hint says the result was cut, how to ask for the rest and how to narrow', () => {
    expect(SNAPSHOT_CUT_HINT).toContain('left out');
    expect(SNAPSHOT_CUT_HINT).toContain('offset set to truncated.next_offset');
    expect(SNAPSHOT_CUT_HINT).toContain('within_selector');
    expect(FIND_CUT_HINT).toContain('left out');
    expect(FIND_CUT_HINT).toContain('offset set to truncated.next_offset');
    expect(FIND_CUT_HINT).toContain('exact');
  });

  test('offset set to next_offset returns the rest of every part and nothing twice', () => {
    addButtons(130);
    addHeadings(40);
    const full = pattern(10000);
    setBodyText(full);
    const first = evalExpr<Json>(buildSnapshotJs({}));
    const cut = first.truncated as Json;
    same(cut, {
      interactive: 10,
      headings: 10,
      text: 6000,
      next_offset: { interactive: 120, headings: 30, text: 4000 },
      hint: SNAPSHOT_CUT_HINT,
    });
    const second = evalExpr<Json>(
      buildSnapshotJs({ offset: cut.next_offset as Record<string, number> }),
    );
    same(second, {
      title: pageTitle,
      url: location.href,
      interactive: range(120, 130).map((i) => buttonEntry(i)),
      headings: range(30, 40).map(headingEntry),
      text: full.slice(4000, 8000),
      truncated: {
        text: 2000,
        next_offset: { interactive: 130, headings: 40, text: 8000 },
        hint: SNAPSHOT_CUT_HINT,
      },
    });
    const third = evalExpr<Json>(
      buildSnapshotJs({ offset: (second.truncated as Json).next_offset as Record<string, number> }),
    );
    same(third, {
      title: pageTitle,
      url: location.href,
      interactive: [],
      headings: [],
      text: full.slice(8000),
    });
    const selectors = [first, second, third].flatMap((r) =>
      (r.interactive as Json[]).map((e) => e.selector),
    );
    expect(selectors).toEqual(range(0, 130).map((i) => '#b' + i));
    const texts = [first, second, third].map((r) => (r.text as string | undefined) ?? '');
    expect(texts.join('')).toBe(full);
  });

  test('an invalid offset counts as 0', () => {
    addButtons(3);
    for (const bad of [-1, 1.5, '2', null]) {
      const r = evalExpr<Json>(
        buildSnapshotJs({ offset: { interactive: bad as unknown as number } }),
      );
      expect((r.interactive as Json[]).map((e) => e.selector)).toEqual(['#b0', '#b1', '#b2']);
    }
  });

  test('find: 8 matches with 5 candidates say 3 were left out', () => {
    addButtons(8, 'Save');
    same(evalExpr(buildFindJs({ text: 'Save' })), {
      matched: false,
      reason: 'multiple-matches',
      candidates: range(0, 5).map((i) => ({
        selector: '#b' + i,
        text: 'Save ' + i,
        tag: 'button',
      })),
      truncated: {
        candidates: 3,
        next_offset: { candidates: 5 },
        hint: FIND_CUT_HINT,
      },
    });
  });

  test("find: exactly 5 matches is not cut and keeps today's shape", () => {
    addButtons(5, 'Save');
    same(evalExpr(buildFindJs({ text: 'Save' })), {
      matched: false,
      reason: 'multiple-matches',
      candidates: range(0, 5).map((i) => ({
        selector: '#b' + i,
        text: 'Save ' + i,
        tag: 'button',
      })),
    });
  });

  test('find: offset set to next_offset returns the remaining candidates and nothing twice', () => {
    addButtons(12, 'Save');
    const first = evalExpr<Json>(buildFindJs({ text: 'Save' }));
    const next = (first.truncated as Json).next_offset as { candidates: number };
    const second = evalExpr<Json>(buildFindJs({ text: 'Save', offset: next }));
    same(second.truncated, {
      candidates: 2,
      next_offset: { candidates: 10 },
      hint: FIND_CUT_HINT,
    });
    const third = evalExpr<Json>(
      buildFindJs({
        text: 'Save',
        offset: (second.truncated as Json).next_offset as { candidates: number },
      }),
    );
    same(third, {
      matched: false,
      reason: 'multiple-matches',
      candidates: range(10, 12).map((i) => ({
        selector: '#b' + i,
        text: 'Save ' + i,
        tag: 'button',
      })),
    });
    const selectors = [first, second, third].flatMap((r) =>
      (r.candidates as Json[]).map((c) => c.selector),
    );
    expect(selectors).toEqual(range(0, 12).map((i) => '#b' + i));
  });

  test('snapshot: offsets that leave every requested part empty say so; any part still returning items, an offset inside the list or no offset adds nothing', () => {
    addButtons(3);
    addHeadings(2);
    const atEnd = evalExpr<Json>(
      buildSnapshotJs({ only_interactive: true, offset: { interactive: 3 } }),
    );
    expect(atEnd.interactive).toEqual([]);
    same(atEnd.offset_past_end, { interactive: { offset: 3, total: 3 } });
    // The headings still return items: the empty interactive part is paging, not an empty page.
    const stillItems = evalExpr<Json>(buildSnapshotJs({ offset: { interactive: 3 } }));
    expect(stillItems.interactive).toEqual([]);
    expect(stillItems.headings).toHaveLength(2);
    expect(stillItems).not.toHaveProperty('offset_past_end');
    const beyond = evalExpr<Json>(
      buildSnapshotJs({ offset: { interactive: 50, headings: 2, text: 9 } }),
    );
    same(beyond.offset_past_end, {
      interactive: { offset: 50, total: 3 },
      headings: { offset: 2, total: 2 },
      text: { offset: 9, total: 0 },
    });
    // Normal paging: finished parts sit at offset == total while text still returns.
    setBodyText('abc');
    const paging = evalExpr<Json>(
      buildSnapshotJs({ offset: { interactive: 3, headings: 2, text: 1 } }),
    );
    expect(paging.text).toBe('bc');
    expect(paging).not.toHaveProperty('offset_past_end');
    setBodyText('');
    const inside = evalExpr<Json>(buildSnapshotJs({ offset: { interactive: 2, headings: 1 } }));
    expect(inside).not.toHaveProperty('offset_past_end');
    expect((inside.interactive as Json[]).map((e) => e.selector)).toEqual(['#b2']);
    expect(evalExpr<Json>(buildSnapshotJs({}))).not.toHaveProperty('offset_past_end');
    expect(evalExpr<Json>(buildSnapshotJs({ offset: {} }))).not.toHaveProperty('offset_past_end');
  });

  test('find: an offset at or past the end of the candidates says so; inside the list or absent, nothing is added', () => {
    addButtons(8, 'Save');
    const atEnd = evalExpr<Json>(buildFindJs({ text: 'Save', offset: { candidates: 8 } }));
    expect(atEnd.candidates).toEqual([]);
    same(atEnd.offset_past_end, { candidates: { offset: 8, total: 8 } });
    expect(atEnd).not.toHaveProperty('truncated');
    const inside = evalExpr<Json>(buildFindJs({ text: 'Save', offset: { candidates: 7 } }));
    expect(inside).not.toHaveProperty('offset_past_end');
    expect((inside.candidates as Json[]).map((c) => c.selector)).toEqual(['#b7']);
    expect(evalExpr<Json>(buildFindJs({ text: 'Save' }))).not.toHaveProperty('offset_past_end');
  });

  test('text: a window never ends between the halves of a surrogate pair; the pages concatenate to the text', () => {
    const full = 'a'.repeat(3999) + '😀' + 'b'.repeat(100);
    expect(full.charCodeAt(3999)).toBe(0xd83d);
    setBodyText(full);
    const first = evalExpr<Json>(buildSnapshotJs({}));
    expect(first.text).toBe('a'.repeat(3999));
    same(first.truncated, {
      text: 102,
      next_offset: { text: 3999 },
      hint: SNAPSHOT_CUT_HINT,
    });
    const second = evalExpr<Json>(buildSnapshotJs({ offset: { text: 3999 } }));
    expect(second.text).toBe('😀' + 'b'.repeat(100));
    expect(second).not.toHaveProperty('truncated');
    expect((first.text as string) + (second.text as string)).toBe(full);
  });

  test('text: a pair that ends exactly on the window, or a cut with no pair at the boundary, is cut as before', () => {
    const whole = 'a'.repeat(3998) + '😀' + 'b'.repeat(10);
    setBodyText(whole);
    const ends = evalExpr<Json>(buildSnapshotJs({}));
    expect(ends.text).toBe(whole.slice(0, 4000));
    same((ends.truncated as Json).next_offset, { text: 4000 });
    const plain = 'a'.repeat(4000) + '😀';
    setBodyText(plain);
    const cut = evalExpr<Json>(buildSnapshotJs({}));
    expect(cut.text).toBe('a'.repeat(4000));
    same((cut.truncated as Json).next_offset, { text: 4000 });
    expect((cut.truncated as Json).text).toBe(2);
  });

  describe('with since (diff)', () => {
    const win = window as unknown as Record<string, unknown>;
    let docId = '';

    beforeEach(() => {
      win[OBSERVER_BINDING] = () => undefined;
      evalExpr(buildObserverInstallJs());
      docId = (win[OBSERVER_GLOBAL] as ObserverHandle).doc_id;
    });

    afterEach(() => {
      evalExpr(buildObserverTeardownJs());
      delete win[OBSERVER_BINDING];
    });

    test('a diff cut by max_interactive keeps overflow, says so and offset returns the rest', () => {
      addButtons(1);
      evalExpr(buildSnapshotJs({ only_interactive: true }));
      const holder = document.createElement('div');
      document.body.appendChild(holder);
      for (const id of ['c', 'd', 'e']) {
        const btn = document.createElement('button');
        btn.id = id;
        btn.textContent = id;
        holder.appendChild(btn);
        makeVisible(btn);
      }
      const since = docId + ':s1';
      const diff = evalExpr<Json>(
        buildSnapshotJs({ since, only_interactive: true, max_interactive: 1 }),
      );
      expect((diff.added as Json[]).map((e) => e.selector)).toEqual(['#c']);
      expect(diff.changed).toEqual([]);
      expect(diff.overflow).toBe(2);
      same(diff.truncated, {
        interactive: 2,
        next_offset: { interactive: 1 },
        hint: SNAPSHOT_CUT_HINT,
      });
      expect(Object.keys(diff).slice(-2)).toEqual(['overflow', 'truncated']);
      const rest = evalExpr<Json>(
        buildSnapshotJs({
          since,
          only_interactive: true,
          max_interactive: 1,
          offset: { interactive: 1 },
        }),
      );
      expect((rest.added as Json[]).map((e) => e.selector)).toEqual(['#d']);
      const last = evalExpr<Json>(
        buildSnapshotJs({
          since,
          only_interactive: true,
          max_interactive: 1,
          offset: { interactive: 2 },
        }),
      );
      expect((last.added as Json[]).map((e) => e.selector)).toEqual(['#e']);
      expect('overflow' in last).toBe(false);
      expect('truncated' in last).toBe(false);
    });

    test('a diff of a page past 500 entries says how many entries it did not compare', () => {
      addButtons(510);
      evalExpr(buildSnapshotJs({ only_interactive: true }));
      const late = document.createElement('button');
      late.id = 'late';
      late.textContent = 'Late';
      document.body.appendChild(late);
      makeVisible(late);
      const diff = evalExpr<Json>(
        buildSnapshotJs({ since: docId + ':s1', only_interactive: true }),
      );
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([]);
      // 11 entries of this snapshot and 10 of the recorded one past 500.
      same(diff.truncated, { not_compared: 21, hint: SNAPSHOT_NOT_COMPARED_HINT });
    });

    test("an uncut diff keeps today's shape", () => {
      addButtons(2);
      evalExpr(buildSnapshotJs({}));
      const diff = evalExpr<Json>(buildSnapshotJs({ since: docId + ':s1' }));
      expect(Object.keys(diff)).toEqual([
        'title',
        'url',
        'doc_id',
        'snapshot_id',
        'since',
        'added',
        'removed',
        'changed',
      ]);
    });
  });
});

/**
 * A diff compares headings and text only on their first windows (30
 * headings, 4000 characters). When either snapshot held more, the diff says
 * that changes beyond them were not looked at; otherwise it is unchanged.
 */
describe('a since diff says when it did not look at headings or text (D6)', () => {
  const win = window as unknown as Record<string, unknown>;
  let docId = '';

  function addHeadings(count: number): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let i = 0; i < count; i++) {
      const h = document.createElement('h2');
      h.textContent = 'Heading ' + i;
      document.body.appendChild(h);
      makeVisible(h);
      out.push(h);
    }
    return out;
  }
  function setBodyText(text: string): void {
    Object.defineProperty(document.body, 'innerText', { value: text, configurable: true });
  }

  beforeEach(() => {
    win[OBSERVER_BINDING] = () => undefined;
    evalExpr(buildObserverInstallJs());
    docId = (win[OBSERVER_GLOBAL] as ObserverHandle).doc_id;
  });

  afterEach(() => {
    evalExpr(buildObserverTeardownJs());
    delete win[OBSERVER_BINDING];
    delete (document.body as unknown as Record<string, unknown>).innerText;
  });

  test('40 headings: a change in heading 35 is not looked at and the diff says so', () => {
    const hs = addHeadings(40);
    evalExpr(buildSnapshotJs({}));
    hs[35].textContent = 'Changed';
    const diff = evalExpr<Json>(buildSnapshotJs({ since: docId + ':s1' }));
    expect('headings' in diff).toBe(false);
    // 10 headings past the first 30 in this snapshot and 10 in the recorded one.
    expect(JSON.stringify(diff.truncated)).toBe(
      JSON.stringify({ not_compared_headings: 20, hint: SNAPSHOT_NOT_COMPARED_TEXT_HINT }),
    );
  });

  test('5000 characters of text: the 1000 past 4000 of each snapshot are not looked at', () => {
    setBodyText('a'.repeat(5000));
    evalExpr(buildSnapshotJs({}));
    setBodyText('a'.repeat(4999) + 'b');
    const diff = evalExpr<Json>(buildSnapshotJs({ since: docId + ':s1' }));
    expect('text' in diff).toBe(false);
    expect(JSON.stringify(diff.truncated)).toBe(
      JSON.stringify({ not_compared_text: 2000, hint: SNAPSHOT_NOT_COMPARED_TEXT_HINT }),
    );
  });

  test("exactly 30 headings and 4000 characters: the diff keeps today's shape", () => {
    addHeadings(30);
    setBodyText('a'.repeat(4000));
    evalExpr(buildSnapshotJs({}));
    const diff = evalExpr<Json>(buildSnapshotJs({ since: docId + ':s1' }));
    expect(Object.keys(diff)).toEqual([
      'title',
      'url',
      'doc_id',
      'snapshot_id',
      'since',
      'added',
      'removed',
      'changed',
    ]);
  });

  test('only_interactive never reports headings or text as not compared', () => {
    addHeadings(40);
    evalExpr(buildSnapshotJs({ only_interactive: true }));
    const diff = evalExpr<Json>(buildSnapshotJs({ since: docId + ':s1', only_interactive: true }));
    expect('truncated' in diff).toBe(false);
  });
});

/**
 * The deep-query depth guard (more than 20 nested shadow roots or frames)
 * must not cut silently: snapshot, find, state and the click / type
 * resolvers say that part of the page was not walked, only when it fired.
 */
describe('results say when part of the page was not walked (depth guard)', () => {
  function nest(levels: number, label: string): HTMLButtonElement {
    let scope: Element | ShadowRoot = document.body;
    for (let i = 0; i < levels; i++) {
      const host = document.createElement('div');
      makeVisible(host);
      scope.appendChild(host);
      scope = host.attachShadow({ mode: 'open' });
    }
    const btn = document.createElement('button');
    btn.id = 'deepest';
    btn.textContent = label;
    scope.appendChild(btn);
    makeVisible(btn);
    return btn;
  }

  test('snapshot: 22 nested roots say not_walked; 21 do not and list the button', () => {
    nest(22, 'Deep');
    const cut = evalExpr<Json>(buildSnapshotJs({}));
    expect(cut.interactive).toEqual([]);
    expect(cut.not_walked).toBe(NOT_WALKED_NOTE);
    expect(Object.keys(cut)).toEqual(['title', 'url', 'interactive', 'headings', 'not_walked']);
    document.body.innerHTML = '';
    nest(21, 'Deep');
    const whole = evalExpr<Json>(buildSnapshotJs({}));
    expect((whole.interactive as Json[]).length).toBe(1);
    expect('not_walked' in whole).toBe(false);
  });

  test('find: a not-found under a depth cut says part of the page was not walked', () => {
    nest(22, 'Deep');
    expect(NOT_WALKED_NOTE).toMatch(/not walked/);
    expect(evalExpr(buildFindJs({ text: 'Deep' }))).toHaveProperty('not_walked');
    expect(evalExpr(buildFindJs({ text: 'Deep' }))).toEqual({
      matched: false,
      reason: 'not-found',
      not_walked: NOT_WALKED_NOTE,
    });
    document.body.innerHTML = '';
    nest(21, 'Deep');
    const found = evalExpr<Json>(buildFindJs({ text: 'Deep' }));
    expect(found.matched).toBe(true);
    expect('not_walked' in found).toBe(false);
  });

  test('state: says not_walked only under a depth cut', () => {
    nest(22, 'Deep');
    expect(evalExpr<Json>(buildStateJs())).toHaveProperty('not_walked', NOT_WALKED_NOTE);
    document.body.innerHTML = '';
    nest(21, 'Deep');
    expect('not_walked' in evalExpr<Json>(buildStateJs())).toBe(false);
  });

  test('click and type resolvers: a not-found under a depth cut carries not_walked', () => {
    nest(22, 'Deep');
    expect(evalExpr(buildClickResolveJs({ selector: '#deepest', force: false }))).toHaveProperty(
      'not_walked',
    );
    expect(evalExpr(buildTypeResolveJs({ selector: '#deepest', clear: false }))).toHaveProperty(
      'not_walked',
    );
    expect(evalExpr(buildClickResolveJs({ selector: '#deepest', force: false }))).toEqual({
      ok: false,
      reason: 'not-found',
      not_walked: NOT_WALKED_NOTE,
    });
    expect(evalExpr(buildTypeResolveJs({ selector: '#deepest', clear: false }))).toEqual({
      ok: false,
      reason: 'not-found',
      not_walked: NOT_WALKED_NOTE,
    });
    document.body.innerHTML = '<p>flat</p>';
    expect(evalExpr(buildClickResolveJs({ selector: '#nope', force: false }))).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('password values: shown by default, hidden by a setting (D12)', () => {
  const win = window as unknown as Record<string, unknown>;
  const SECRET = 'hunter2-SECRET';

  /** A visible, filled field appended to the body. */
  function filled(html: string, value: string): HTMLInputElement {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const el = holder.firstElementChild as HTMLInputElement;
    document.body.appendChild(el);
    makeVisible(el);
    el.value = value;
    return el;
  }

  function entries(result: Json): Json[] {
    return result.interactive as Json[];
  }

  test('by default a snapshot returns the text of a filled password field (pinned default)', () => {
    filled('<input id="pw" type="password" name="pw">', SECRET);
    const result = evalExpr<Json>(buildSnapshotJs({}));
    expect(entries(result)).toEqual([
      { tag: 'input', role: 'input', selector: '#pw', value: SECRET, name: 'pw', type: 'password' },
    ]);
    expect('values_hidden' in result).toBe(false);
  });

  test('by default find matches a password field by its text and quotes it (pinned default)', () => {
    filled('<input id="pw" type="password">', SECRET);
    const match = evalExpr<Json>(buildFindJs({ text: 'hunter2', role: 'textbox' }));
    expect(match).toMatchObject({ matched: true, selector: '#pw' });
    const miss = evalExpr<FindNoMatch>(buildFindJs({ text: 'hunter2', role: 'button' }));
    expect(JSON.stringify(miss)).toContain(SECRET);
  });

  test('setting on: the entry says filled, N characters in place of value, and the result says why', () => {
    filled('<input id="pw" type="password" name="pw">', SECRET);
    const result = evalExpr<Json>(buildSnapshotJs({ hide_password_values: true }));
    expect(entries(result)).toEqual([
      {
        tag: 'input',
        role: 'input',
        selector: '#pw',
        value_hidden: 'filled, 14 characters',
        name: 'pw',
        type: 'password',
      },
    ]);
    expect(Object.keys(entries(result)[0])).toEqual([
      'tag',
      'role',
      'selector',
      'value_hidden',
      'name',
      'type',
    ]);
    expect(result.values_hidden).toBe(PASSWORD_VALUES_HIDDEN_NOTE);
    expect(typeof result.values_hidden).toBe('string');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  test('setting on: one character is singular, and the count is in characters, not code units', () => {
    filled('<input id="a" type="password">', 'x');
    filled('<input id="b" type="password">', '\u{1F511}é');
    const shown = entries(evalExpr<Json>(buildSnapshotJs({ hide_password_values: true })));
    expect(shown.map((e) => e.value_hidden)).toEqual([
      'filled, 1 character',
      'filled, 2 characters',
    ]);
  });

  test.each(['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'])(
    'setting on: a field marked autocomplete="%s" is hidden too',
    (token) => {
      filled(`<input id="f" type="text" autocomplete="section-x ${token.toUpperCase()}">`, SECRET);
      const result = evalExpr<Json>(buildSnapshotJs({ hide_password_values: true }));
      expect(entries(result)[0]).toMatchObject({ value_hidden: 'filled, 14 characters' });
      expect(JSON.stringify(result)).not.toContain('hunter2');
    },
  );

  test('setting on: a password field a show-password button turned into text stays hidden', () => {
    const pw = filled('<input id="pw" type="password">', SECRET);
    evalExpr(buildSnapshotJs({ hide_password_values: true }));
    pw.type = 'text';
    const result = evalExpr<Json>(buildSnapshotJs({ hide_password_values: true }));
    expect(entries(result)[0]).toMatchObject({ value_hidden: 'filled, 14 characters' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(
      evalExpr<Json>(buildFindJs({ text: 'hunter2', hide_password_values: true })),
    ).toMatchObject({ matched: false, reason: 'not-found' });
  });

  test('setting on: a field the page does not mark sensitive keeps its value', () => {
    filled('<input id="q" type="search" name="password">', 'shoes');
    const result = evalExpr<Json>(buildSnapshotJs({ hide_password_values: true }));
    expect(entries(result)[0]).toMatchObject({ value: 'shoes' });
    expect('value_hidden' in entries(result)[0]).toBe(false);
  });

  test('setting on: an empty password field carries neither value nor value_hidden', () => {
    filled('<input id="pw" type="password">', '');
    const [entry] = entries(evalExpr<Json>(buildSnapshotJs({ hide_password_values: true })));
    expect(entry).toEqual({ tag: 'input', role: 'input', selector: '#pw', type: 'password' });
  });

  test('setting on: a sensitive textarea shows neither its value nor its text', () => {
    const area = document.createElement('textarea');
    area.id = 'otp';
    area.setAttribute('autocomplete', 'one-time-code');
    area.textContent = SECRET;
    document.body.appendChild(area);
    makeVisible(area);
    const result = evalExpr<Json>(buildSnapshotJs({ hide_password_values: true }));
    expect(entries(result)[0]).toEqual({
      tag: 'textarea',
      role: 'textarea',
      selector: '#otp',
      value_hidden: 'filled, 14 characters',
    });
  });

  test('setting on: find never matches on a hidden value, nor quotes it in near_misses or the error', () => {
    filled('<input id="pw" type="password" placeholder="Your password">', SECRET);
    const hide = { hide_password_values: true } as const;
    expect(evalExpr<Json>(buildFindJs({ text: 'hunter2', role: 'textbox', ...hide }))).toEqual({
      matched: false,
      reason: 'not-found',
      values_hidden: PASSWORD_VALUES_HIDDEN_NOTE,
    });
    const miss = evalExpr<Json>(buildFindJs({ text: 'hunter2', role: 'button', ...hide }));
    expect(JSON.stringify(miss)).not.toContain('hunter2');
    // Still found by what the page shows: its placeholder.
    expect(
      evalExpr<Json>(buildFindJs({ text: 'password', role: 'textbox', ...hide })),
    ).toMatchObject({ matched: true, selector: '#pw', values_hidden: PASSWORD_VALUES_HIDDEN_NOTE });
    // A near miss quotes the placeholder, never the value.
    const near = evalExpr<FindNoMatch>(
      buildFindJs({ text: 'your password', exact: true, role: 'button', ...hide }),
    );
    expect(JSON.stringify(near)).not.toContain('hunter2');
    expect(near.near_misses?.[0]?.text).toBe('Your password');
  });

  test('setting on: multiple-matches candidates carry no value', () => {
    filled('<input id="a" type="password" aria-label="Password field">', SECRET);
    filled('<input id="b" type="password" aria-label="Password field">', SECRET);
    const many = evalExpr<Json>(
      buildFindJs({ text: 'password field', hide_password_values: true }),
    );
    expect(many.reason).toBe('multiple-matches');
    expect(JSON.stringify(many)).not.toContain('hunter2');
    expect(many.values_hidden).toBe(PASSWORD_VALUES_HIDDEN_NOTE);
  });

  test('setting on: a since diff lists a changed password field without its text', () => {
    win[OBSERVER_BINDING] = () => undefined;
    evalExpr(buildObserverInstallJs());
    try {
      const pw = filled('<input id="pw" type="password">', 'old-SECRET');
      const first = evalExpr<Json>(buildSnapshotJs({}));
      expect(entries(first)[0]).toMatchObject({ value: 'old-SECRET' });
      pw.value = SECRET;
      const diff = evalExpr<Json>(
        buildSnapshotJs({ since: first.snapshot_id as string, hide_password_values: true }),
      );
      expect(diff.changed).toEqual([
        expect.objectContaining({ selector: '#pw', value_hidden: 'filled, 14 characters' }),
      ]);
      expect(diff.values_hidden).toBe(PASSWORD_VALUES_HIDDEN_NOTE);
      expect(JSON.stringify(diff)).not.toContain('SECRET');
    } finally {
      evalExpr(buildObserverTeardownJs());
      delete win[OBSERVER_BINDING];
    }
  });

  test('setting off: the expression and every result are exactly as without the option', () => {
    filled('<input id="pw" type="password">', SECRET);
    filled('<input id="q" type="search">', 'shoes');
    expect(buildSnapshotJs({ hide_password_values: false })).toBe(buildSnapshotJs({}));
    expect(buildFindJs({ text: 'hunter2', hide_password_values: false })).toBe(
      buildFindJs({ text: 'hunter2' }),
    );
    const snap = evalExpr<Json>(buildSnapshotJs({}));
    expect(entries(snap).map((e) => e.value)).toEqual([SECRET, 'shoes']);
    expect(JSON.stringify(snap)).not.toContain('values_hidden');
  });
});

describe('buildClickAimJs / buildClickHitCheckJs: a click is reported only where it landed', () => {
  type Aim =
    | { ok: true; x: number; y: number; tag: string; hit_element?: string }
    | { ok: false; reason: string; blocker?: string; hit_element?: string };

  afterEach(() => {
    // Disarm any watch a test left behind.
    evalExpr(buildClickHitCheckJs());
  });

  function button(id: string): HTMLButtonElement {
    const el = document.createElement('button');
    el.id = id;
    document.body.appendChild(el);
    giveBox(el);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => el;
    return el;
  }

  test('a press that reaches the target is reported as landed', async () => {
    const el = button('go');
    const aim = await evalExpr<Promise<Aim>>(buildClickAimJs({ selector: '#go', force: false }));
    expect(aim).toMatchObject({ ok: true, x: 140, y: 210, tag: 'button' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    expect(evalExpr(buildClickHitCheckJs())).toEqual({ armed: true, landed: true });
  });

  test('no press in the target document (delivered elsewhere) is a miss, not a click', async () => {
    button('go');
    await evalExpr<Promise<Aim>>(buildClickAimJs({ selector: '#go', force: false }));
    expect(evalExpr(buildClickHitCheckJs())).toEqual({ armed: true, landed: false });
  });

  test('a press on another element is a miss that names where it landed', async () => {
    button('go');
    const other = document.createElement('div');
    other.id = 'cover';
    document.body.appendChild(other);
    await evalExpr<Promise<Aim>>(buildClickAimJs({ selector: '#go', force: false }));
    other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    expect(evalExpr(buildClickHitCheckJs())).toEqual({
      armed: true,
      landed: false,
      landed_on: 'div#cover',
    });
  });

  test('a press on the element the hit test named (pointer-events:none target) is landed', async () => {
    const acc = document.createElement('div');
    acc.id = 'acc';
    acc.style.pointerEvents = 'none';
    document.body.appendChild(acc);
    giveBox(acc);
    const layer = document.createElement('div');
    layer.id = 'layer';
    document.body.appendChild(layer);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => layer;
    const aim = await evalExpr<Promise<Aim>>(buildClickAimJs({ selector: '#acc', force: false }));
    expect(aim).toMatchObject({ ok: true, hit_element: 'div#layer' });
    layer.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    expect(evalExpr(buildClickHitCheckJs())).toEqual({ armed: true, landed: true });
  });

  test('the aim re-checks occlusion after waiting: a cover that appeared fails as occluded', async () => {
    button('go');
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    document.body.appendChild(overlay);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => overlay;
    const aim = await evalExpr<Promise<Aim>>(buildClickAimJs({ selector: '#go', force: false }));
    expect(aim).toEqual({ ok: false, reason: 'occluded', blocker: 'div.modal-backdrop' });
    expect(evalExpr(buildClickHitCheckJs())).toEqual({ armed: false });
  });

  test.each(['iframe', 'frame', 'embed', 'object'])(
    'a click on a <%s> element is not watched: the press lands in the document inside it',
    async (tagName) => {
      const el = document.createElement(tagName);
      el.id = 'f';
      document.body.appendChild(el);
      giveBox(el);
      (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => el;
      const aim = await evalExpr<Promise<Aim>>(buildClickAimJs({ selector: '#f', force: false }));
      expect(aim).toMatchObject({ ok: true, tag: tagName, hit_check: 'not_verifiable' });
      // Nothing armed: the check can claim nothing.
      expect(evalExpr(buildClickHitCheckJs())).toEqual({ armed: false });
    },
  );

  test('force, box gone since the resolve: the aim answers no_box (D4 programmatic click), not a failure', async () => {
    const el = document.createElement('button');
    el.id = 'gone';
    document.body.appendChild(el);
    // No giveBox: no client rects, as for an element that stopped rendering.
    const forced = await evalExpr<Promise<unknown>>(
      buildClickAimJs({ selector: '#gone', force: true }),
    );
    expect(forced).toEqual({ ok: true, no_box: true, tag: 'button' });
    const plain = await evalExpr<Promise<unknown>>(
      buildClickAimJs({ selector: '#gone', force: false }),
    );
    expect(plain).toEqual({ ok: false, reason: 'no-box' });
  });

  test('without an armed watch (document replaced) nothing is claimed either way', () => {
    expect(evalExpr(buildClickHitCheckJs())).toEqual({ armed: false });
  });

  test('clickMissedMessage: a press never seen may be a miss or a swallowed press; check the effect', () => {
    expect(clickMissedMessage('#add', { x: 295.27, y: 90.4 })).toBe(
      "Click on #add did not reach it: the mouse events were sent at (295, 90), but no press was seen in the target's document. Either the browser delivered them elsewhere (another frame, possibly a cross-origin one, may have received them), or a page listener stopped the press before anything else saw it (stopImmediatePropagation at window capture). Check whether the click had its effect (browser.snapshot or browser.screenshot) before retrying",
    );
    expect(clickMissedMessage('#add', { x: 1, y: 2 }, 'div#cover')).toContain(
      'the press at (1, 2) landed on div#cover instead',
    );
  });
});

describe('buildFrameWatchStartJs / buildFrameWatchReadJs: same-origin frames (D5)', () => {
  test('counts a change made inside a same-origin frame at once, before settle starts', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<p id="mark">frame</p>';
    expect(evalExpr(buildFrameWatchStartJs())).toEqual({ ok: true, frames: 1 });
    idoc.getElementById('mark')!.textContent = 'poked';
    // Read synchronously: the records are still queued, takeRecords gets them.
    const read = evalExpr<{ ok: boolean; records: number }>(buildFrameWatchReadJs());
    expect(read.ok).toBe(true);
    expect(read.records).toBeGreaterThanOrEqual(1);
    // Read once: the watch is gone afterwards.
    expect(evalExpr(buildFrameWatchReadJs())).toEqual({ ok: false });
  });

  test('a change in the top document is not counted here (the page observer counts it)', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    evalExpr(buildFrameWatchStartJs());
    document.body.appendChild(document.createElement('span'));
    expect(evalExpr(buildFrameWatchReadJs())).toEqual({ ok: true, records: 0 });
  });
});
