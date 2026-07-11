import { beforeEach, describe, expect, test } from 'vitest';
import { DEEP_QUERY_JS } from './deep-query.js';
import { DOM_HELPERS_JS } from './dom-helpers.js';

/**
 * `genSelector` (in DOM_HELPERS_JS) calls `deepQueryAll` (in DEEP_QUERY_JS)
 * to verify candidate uniqueness — both constants must be evaluated
 * together, in that order, exactly like every builder in `builders.ts`
 * concatenates them. See `deep-query.test.ts` for why indirect eval is
 * used here instead of `new Function`.
 */
const globalEval = eval;

interface DomHelperGlobals {
  genSelector: (el: Element) => string;
  genSelectorInfo: (el: Element) => { selector: string; ambiguous: boolean };
  frameSelectorFor: (el: Element) => string | null;
  deepQueryAll: (selector: string, start?: Document | Element) => Element[];
  deepQueryFirst: (selector: string, start?: Document | Element) => Element | null;
}

function loadHelpers(): DomHelperGlobals {
  globalEval(DEEP_QUERY_JS);
  globalEval(DOM_HELPERS_JS);
  return globalThis as unknown as DomHelperGlobals;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('genSelector — round-trip invariant (find/snapshot selector must resolve via deepQueryFirst)', () => {
  test('top-document element with an id', () => {
    const { genSelector, deepQueryFirst } = loadHelpers();
    const el = document.createElement('button');
    el.id = 'save';
    document.body.appendChild(el);

    const selector = genSelector(el);
    expect(deepQueryFirst(selector)).toBe(el);
  });

  test('element inside an open shadow root, no id (falls back to structural path)', () => {
    const { genSelector, deepQueryFirst } = loadHelpers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<section><button>Confirm</button><button>Cancel</button></section>';

    const target = shadow.querySelectorAll('button')[1];
    const selector = genSelector(target);
    expect(deepQueryFirst(selector)).toBe(target);
  });

  test('element inside a same-origin iframe with an id', () => {
    const { genSelector, deepQueryFirst } = loadHelpers();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<input id="email" />';
    const target = idoc.getElementById('email')!;

    const selector = genSelector(target);
    expect(deepQueryFirst(selector)).toBe(target);
  });

  test('an id duplicated across the top document and a shadow root is rejected as a selector shortcut', () => {
    const { genSelector, deepQueryAll } = loadHelpers();
    // document.querySelectorAll('#dup') from the top document alone would
    // only see its OWN #dup (shadow content is invisible to plain
    // document.querySelectorAll) — the pre-fix uniqueness check used
    // exactly that call and would have confidently returned '#dup' for
    // BOTH elements, even though it only actually resolves to whichever
    // element deepQueryFirst visits first. deepQueryAll sees both and
    // must make genSelector reject the shortcut for both sides.
    const topEl = document.createElement('button');
    topEl.id = 'dup';
    document.body.appendChild(topEl);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="dup">shadow dup</button>';
    const shadowEl = shadow.getElementById('dup')!;

    expect(deepQueryAll('#dup')).toHaveLength(2);
    expect(genSelector(topEl)).not.toBe('#dup');
    expect(genSelector(shadowEl)).not.toBe('#dup');
  });

  test('known limitation: two structurally-identical bare elements in different roots cannot be told apart by plain CSS — deepQueryFirst is deterministic (start root, then nested roots, depth-first)', () => {
    const { deepQueryFirst } = loadHelpers();
    const topEl = document.createElement('button');
    document.body.appendChild(topEl);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>shadow twin</button>';

    // Both elements independently reduce to the same unqualified "button"
    // selector — there is no CSS syntax that says "only inside this shadow
    // root". deepQueryFirst resolves it to the FIRST root in traversal
    // order (the top document), documented behavior rather than a crash
    // or a silent wrong answer.
    expect(deepQueryFirst('button')).toBe(topEl);
  });

  test('frameSelectorFor returns null for a top-document element and a selector for a framed element', () => {
    const { frameSelectorFor, deepQueryFirst } = loadHelpers();
    const topEl = document.createElement('button');
    document.body.appendChild(topEl);
    expect(frameSelectorFor(topEl)).toBeNull();

    const iframe = document.createElement('iframe');
    iframe.id = 'content-frame';
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<button id="in-frame">go</button>';
    const framedEl = idoc.getElementById('in-frame')!;

    const frameSelector = frameSelectorFor(framedEl);
    expect(frameSelector).not.toBeNull();
    // The frame selector must itself resolve back to the iframe element.
    expect(deepQueryFirst(frameSelector!)).toBe(iframe);
  });
});

describe('genSelectorInfo — structural fallback verification', () => {
  const DEEP_TWIN = '<div><div><div><div><div><button>deep</button></div></div></div></div></div>';

  test('an ambiguous short structural path is rescued by the fully-qualified retry', () => {
    // Two wrapper divs under <body>, each containing an identical
    // 6-level-deep chain. The short structural path (capped at 6 parts)
    // truncates BEFORE the wrapper level — the only level that
    // distinguishes the twins — so it matches both buttons. The qualified
    // retry (uncapped, every level indexed) reaches the wrapper's
    // :nth-of-type and resolves uniquely.
    const wrapperA = document.createElement('div');
    wrapperA.innerHTML = DEEP_TWIN;
    document.body.appendChild(wrapperA);
    const wrapperB = document.createElement('div');
    wrapperB.innerHTML = DEEP_TWIN;
    document.body.appendChild(wrapperB);

    const { genSelectorInfo, deepQueryFirst } = loadHelpers();
    const buttonB = wrapperB.querySelector('button')!;
    const info = genSelectorInfo(buttonB);
    expect(info.ambiguous).toBe(false);
    expect(deepQueryFirst(info.selector)).toBe(buttonB);
  });

  test('twins in different shadow roots stay ambiguous even after the qualified retry', () => {
    // Root-boundary twins: qualification cannot help because each shadow
    // root restarts the structural path — the qualified selectors are
    // byte-identical too. The flag is the honest signal.
    const buttons: Element[] = [];
    for (let i = 0; i < 2; i++) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<button>twin</button>';
      buttons.push(shadow.querySelector('button')!);
    }

    const { genSelectorInfo } = loadHelpers();
    for (const btn of buttons) {
      expect(genSelectorInfo(btn).ambiguous).toBe(true);
    }
  });
});
