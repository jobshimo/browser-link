import { beforeEach, describe, expect, test } from 'vitest';
import {
  buildClickResolveJs,
  buildFindJs,
  buildFocusJs,
  buildSettleJs,
  buildSnapshotJs,
  buildStateJs,
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
  | { ok: true; x: number; y: number; tag: string }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'occluded'; blocker: string };

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
      buildSettleJs({ settle_ms: 30, settle_timeout_ms: 500 }),
    );
    // One mutation shortly after the observer starts, then silence — the
    // quiet period should be measured from THIS mutation, not from t=0.
    setTimeout(() => target.setAttribute('data-x', '1'), 5);

    const result = await resultPromise;
    expect(result.settled).toBe(true);
    expect(result.mutation_count).toBeGreaterThanOrEqual(1);
    expect(result.duration_ms).toBeGreaterThanOrEqual(30);
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
      buildSettleJs({ settle_ms: 30, settle_timeout_ms: 300 }),
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
