import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildRecorderJs, buildStopRecorderJs } from './recorder.js';

/**
 * End-to-end tests for the actual expression string background.ts ships to
 * CDP `Runtime.evaluate` while a recording is active — same pattern as
 * `builders.test.ts`: indirect eval executes the exact source, real DOM
 * events are dispatched, and we assert on what the recorder would have
 * sent over the CDP binding (stubbed here as `window[BINDING_NAME]`).
 */
const globalEval = eval;

// jsdom does not implement `CSS.escape` (used by `genSelectorInfo`'s
// id/data-testid/aria-label shortcuts in dom-helpers.ts) — real Chrome
// always has it. Without a polyfill every generated selector in this test
// file would silently fall back to the structural form, which would test a
// materially different code path than production. Scoped to this test file
// only; production code (dom-helpers.ts) is untouched.
if (typeof (globalThis as unknown as { CSS?: unknown }).CSS === 'undefined') {
  (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
    escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`),
  };
}

/**
 * jsdom marks every event `isTrusted: false` and — per the DOM spec —
 * RESETS it to false at the start of `dispatchEvent`, so a plain
 * pre-dispatch flip is clobbered before any listener runs. To exercise the
 * recorder's trusted path we install a getter/setter accessor on the
 * event's internal jsdom impl slot: the getter always returns true, the
 * setter swallows jsdom's dispatch-time reset. The rejection tests dispatch
 * WITHOUT this override, so the event stays `isTrusted:false`, exactly like
 * a page-dispatched synthetic event (`el.click()`, `dispatchEvent(...)`) in
 * a real browser.
 */
function markTrusted(ev: Event): Event {
  for (const s of Object.getOwnPropertySymbols(ev)) {
    const impl = (ev as unknown as Record<symbol, unknown>)[s];
    if (impl && typeof impl === 'object' && 'isTrusted' in impl) {
      Object.defineProperty(impl, 'isTrusted', {
        configurable: true,
        get: () => true,
        set: () => {
          /* swallow jsdom's dispatch-time reset to false */
        },
      });
    }
  }
  return ev;
}

function dispatchTrusted(el: EventTarget, ev: Event): void {
  el.dispatchEvent(markTrusted(ev));
}

const BINDING_NAME = 'atestbinding';
const ACTIVE_FLAG = 'btestactive';
const STOP_FN = 'cteststop';
const NONCE = 'test-nonce-abc123';

interface CapturedPayload {
  nonce?: string;
  kind: 'click' | 'type' | 'press';
  selector?: string;
  key?: string;
  ambiguous?: boolean;
}

let captured: CapturedPayload[];
/** Raw JSON strings exactly as they crossed the binding, so a test can
 * assert on the wire form (e.g. that the nonce is present, that a secret
 * substring never appears anywhere in the payload). */
let rawEmitted: string[];

function install(opts: { bindingName?: string; nonce?: string } = {}): void {
  captured = [];
  rawEmitted = [];
  const bindingName = opts.bindingName ?? BINDING_NAME;
  const nonce = opts.nonce ?? NONCE;
  (window as unknown as Record<string, unknown>)[bindingName] = vi.fn((raw: string): void => {
    rawEmitted.push(raw);
    captured.push(JSON.parse(raw) as CapturedPayload);
  });
  globalEval(buildRecorderJs({ bindingName, activeFlag: ACTIVE_FLAG, stopFn: STOP_FN, nonce }));
}

/** Strip the transport nonce so step-shape assertions stay readable — the
 * nonce presence is asserted separately in the security block. */
function steps(): Array<Omit<CapturedPayload, 'nonce'>> {
  return captured.map(({ nonce: _n, ...rest }) => rest);
}

function stop(bindingName = BINDING_NAME): void {
  globalEval(buildStopRecorderJs(STOP_FN));
  delete (window as unknown as Record<string, unknown>)[bindingName];
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  stop();
});

/** `button` defaults to 0 (left/primary) — the SECURITY block below passes
 * 1 (middle) / 2 (right) explicitly to exercise the non-left-button gate. */
function pointerDown(el: Element, button = 0): void {
  dispatchTrusted(el, new MouseEvent('pointerdown', { bubbles: true, composed: true, button }));
}

/** A trusted mousedown — the recorder notes it as a user gesture but does
 * NOT emit a click (unlike pointerdown). Used to satisfy the type-commit
 * gesture gate in tests that assert on the type step alone. `button`
 * defaults to 0 (left/primary); the button-filter block passes 2 to prove a
 * non-left mousedown does not authorize a commit. */
function mouseDown(el: Element, button = 0): void {
  dispatchTrusted(el, new MouseEvent('mousedown', { bubbles: true, composed: true, button }));
}

function click(el: Element, button = 0): void {
  dispatchTrusted(el, new MouseEvent('click', { bubbles: true, composed: true, button }));
}

function focusIn(el: Element): void {
  dispatchTrusted(el, new FocusEvent('focusin', { bubbles: true }));
}

function focusOut(el: Element): void {
  dispatchTrusted(el, new FocusEvent('focusout', { bubbles: true }));
}

/** Simulate a user focusing a text field the legitimate way: a real
 * (trusted) pointer gesture lands on it, then focus moves in. This is what
 * the type-commit gesture gate requires — without it, a focusin/focusout
 * pair is treated as a fabricated (non-user-driven) sequence and dropped. */
function focusInWithGesture(el: Element): void {
  mouseDown(el);
  focusIn(el);
}

function change(el: Element): void {
  dispatchTrusted(el, new Event('change', { bubbles: true }));
}

/** `repeat` defaults to false — the SECURITY block below passes true to
 * simulate OS key-repeat from a held-down key. */
function keyDown(el: EventTarget, key: string, repeat = false): void {
  dispatchTrusted(el, new KeyboardEvent('keydown', { key, bubbles: true, repeat }));
}

describe('click capture', () => {
  test('pointerdown on a button emits a click step with its generated selector', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'save-btn';
    document.body.appendChild(btn);

    pointerDown(btn);

    expect(steps()).toEqual([{ kind: 'click', selector: '#save-btn' }]);
  });

  test('a click that immediately follows a pointerdown on the SAME element is deduped', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'save-btn';
    document.body.appendChild(btn);

    pointerDown(btn);
    click(btn);

    expect(steps()).toEqual([{ kind: 'click', selector: '#save-btn' }]);
  });

  test('a click with no preceding pointerdown (keyboard activation) is still recorded', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'submit-btn';
    document.body.appendChild(btn);

    click(btn);

    expect(steps()).toEqual([{ kind: 'click', selector: '#submit-btn' }]);
  });

  test('clicks on two different elements are both recorded independently', () => {
    install();
    const a = document.createElement('button');
    a.id = 'a-btn';
    const b = document.createElement('button');
    b.id = 'b-btn';
    document.body.append(a, b);

    pointerDown(a);
    pointerDown(b);

    expect(steps()).toEqual([
      { kind: 'click', selector: '#a-btn' },
      { kind: 'click', selector: '#b-btn' },
    ]);
  });
});

describe('click capture — right/middle click is not recorded as a click', () => {
  test('a right-click (button:2) pointerdown records no step', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'ctx-btn';
    document.body.appendChild(btn);

    pointerDown(btn, 2);

    expect(captured).toHaveLength(0);
  });

  test('a middle-click (button:1) pointerdown records no step', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'mid-btn';
    document.body.appendChild(btn);

    pointerDown(btn, 1);

    expect(captured).toHaveLength(0);
  });

  test('a non-left-button click event alone (no pointerdown) records no step', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'aux-btn';
    document.body.appendChild(btn);

    click(btn, 2);

    expect(captured).toHaveLength(0);
  });

  test('a left-click that follows a right-click on the same element is still recorded on its own', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'menu-btn';
    document.body.appendChild(btn);

    pointerDown(btn, 2); // opens a context menu — no step
    pointerDown(btn, 0); // a real left click right after — recorded normally

    expect(steps()).toEqual([{ kind: 'click', selector: '#menu-btn' }]);
  });

  test('a non-left mousedown does NOT authorize a subsequent type-commit', () => {
    install();
    const input = document.createElement('input');
    input.id = 'ctx-input';
    document.body.appendChild(input);

    // A right-click on a field (e.g. to open the paste context menu) is not
    // the gesture that authorizes recording a type step for it — only a
    // primary-button gesture (or a trusted key event while focused) is.
    // Without the button gate in onMouseDown, this sequence emitted a
    // fabricated {kind:'type'} step.
    mouseDown(input, 2); // trusted, but right button — no gesture noted
    focusIn(input);
    focusOut(input);

    expect(captured).toHaveLength(0);
  });
});

describe('type-commit capture — privacy contract', () => {
  test('blur commits ONE type step carrying only the selector — never the value', () => {
    install();
    const input = document.createElement('input');
    input.id = 'search-box';
    document.body.appendChild(input);

    focusInWithGesture(input);
    input.value = 'super-secret-patient-name';
    focusOut(input);

    expect(steps()).toEqual([{ kind: 'type', selector: '#search-box' }]);
    // The real value must never appear in ANY emitted payload — not the
    // parsed object, not the raw wire string.
    expect(JSON.stringify(captured)).not.toContain('super-secret-patient-name');
    expect(rawEmitted.join('')).not.toContain('super-secret-patient-name');
  });

  test('change event also commits the type step', () => {
    install();
    const input = document.createElement('input');
    input.id = 'qty';
    document.body.appendChild(input);

    focusInWithGesture(input);
    change(input);

    expect(steps()).toEqual([{ kind: 'type', selector: '#qty' }]);
  });

  test('Enter inside a focused text field commits type and does NOT also emit a press step', () => {
    install();
    const input = document.createElement('input');
    input.id = 'query';
    document.body.appendChild(input);

    // No preceding pointer gesture — the trusted Enter keydown on the field
    // is itself the user gesture that authorizes the commit.
    focusIn(input);
    keyDown(input, 'Enter');

    expect(steps()).toEqual([{ kind: 'type', selector: '#query' }]);
  });

  test('committing twice for the same focus session only emits once', () => {
    install();
    const input = document.createElement('input');
    input.id = 'once';
    document.body.appendChild(input);

    focusInWithGesture(input);
    change(input);
    focusOut(input);

    expect(captured).toHaveLength(1);
  });

  test('a textarea and a contenteditable div both count as text fields', () => {
    install();
    const textarea = document.createElement('textarea');
    textarea.id = 'notes';
    const editable = document.createElement('div');
    editable.id = 'rich-notes';
    editable.setAttribute('contenteditable', 'true');
    document.body.append(textarea, editable);

    focusInWithGesture(textarea);
    focusOut(textarea);
    focusInWithGesture(editable);
    focusOut(editable);

    expect(steps()).toEqual([
      { kind: 'type', selector: '#notes' },
      { kind: 'type', selector: '#rich-notes' },
    ]);
  });
});

describe('SECURITY: fabricated focus/blur (trusted events, no user gesture) is dropped', () => {
  test('focus()+blur() with NO preceding trusted gesture records ZERO steps', () => {
    install();
    const input = document.createElement('input');
    input.id = 'attacker-input';
    document.body.appendChild(input);

    // Reproduces the attack: element.focus()/.blur() from page script fire
    // focus/blur events with isTrusted:TRUE (unlike .click()), so the
    // isTrusted gate alone does NOT stop this. There is no preceding
    // trusted pointerdown/mousedown/keydown ON the field, so the gesture
    // correlation gate drops the fabricated type-commit.
    focusIn(input); // trusted, but unsolicited
    focusOut(input); // trusted blur

    expect(captured).toHaveLength(0);
  });

  test('a real trusted pointerdown on the field THEN focus/blur DOES record the type step (legit path intact)', () => {
    install();
    const input = document.createElement('input');
    input.id = 'legit-input';
    document.body.appendChild(input);

    // The user really clicked the field: trusted pointerdown lands on it,
    // then focus moves in, then they move on (blur).
    pointerDown(input); // emits a click step AND records the gesture
    focusIn(input);
    focusOut(input);

    // The type step is recorded — the legitimate path still works.
    expect(steps()).toContainEqual({ kind: 'type', selector: '#legit-input' });
  });

  test('a mousedown gesture (no pointerdown) also authorizes the commit', () => {
    install();
    const input = document.createElement('input');
    input.id = 'md-input';
    document.body.appendChild(input);

    focusInWithGesture(input); // mousedown + focusin, no click emitted
    focusOut(input);

    expect(steps()).toEqual([{ kind: 'type', selector: '#md-input' }]);
  });

  test('cross-element decoy: a gesture on X does NOT authorize a fabricated commit on unrelated Y', () => {
    install();
    const decoy = document.createElement('button');
    decoy.id = 'decoy';
    const target = document.createElement('input');
    target.id = 'victim';
    document.body.append(decoy, target);

    // The user's real gesture lands on an UNRELATED element (a decoy the
    // attacker got them to interact with). The attacker then scripts
    // focus()+blur() on the victim field within the correlation window. The
    // gate requires the gesture to be ON the focused field (or a
    // descendant), so the fabricated commit for #victim is rejected.
    mouseDown(decoy); // trusted gesture, but on the wrong element (no emit)
    focusIn(target); // fabricated focus on the victim
    focusOut(target); // fabricated blur

    expect(steps().some((s) => s.kind === 'type')).toBe(false);
  });

  test('composed-tree descendant: a gesture on a child span inside a contenteditable commits the ancestor field', () => {
    install();
    const editor = document.createElement('div');
    editor.id = 'editor';
    editor.setAttribute('contenteditable', 'true');
    const span = document.createElement('span');
    span.id = 'rich-child';
    span.textContent = 'hello';
    editor.appendChild(span);
    document.body.appendChild(editor);

    // The user clicks a child span; focus lands on the contenteditable
    // ANCESTOR. composedContains(editor, span) is true, so the gesture
    // authorizes the commit — the legitimate rich-text path still works.
    mouseDown(span); // trusted gesture on the descendant (no click emitted)
    focusIn(editor); // focus resolves to the contenteditable ancestor
    focusOut(editor);

    expect(steps()).toContainEqual({ kind: 'type', selector: '#editor' });
  });
});

describe('press capture — special keys outside text-field commits', () => {
  test('Escape/Tab/arrows emit a press step when nothing text-like has focus', () => {
    install();
    for (const key of ['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      keyDown(window, key);
    }
    expect(steps()).toEqual([
      { kind: 'press', key: 'Escape' },
      { kind: 'press', key: 'Tab' },
      { kind: 'press', key: 'ArrowUp' },
      { kind: 'press', key: 'ArrowDown' },
      { kind: 'press', key: 'ArrowLeft' },
      { kind: 'press', key: 'ArrowRight' },
    ]);
  });

  test('Enter with no text field focused emits a press step (not a type-commit)', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'go-btn';
    document.body.appendChild(btn);
    keyDown(btn, 'Enter');

    expect(steps()).toEqual([{ kind: 'press', key: 'Enter' }]);
  });

  test('Tab while a text field is focused BOTH commits the type AND emits its own press step', () => {
    install();
    const input = document.createElement('input');
    input.id = 'city';
    document.body.appendChild(input);

    focusIn(input);
    keyDown(input, 'Tab');

    expect(steps()).toEqual([
      { kind: 'type', selector: '#city' },
      { kind: 'press', key: 'Tab' },
    ]);
  });

  test('a plain letter keydown is never captured (no keylogging)', () => {
    install();
    const input = document.createElement('input');
    document.body.appendChild(input);
    focusIn(input);
    for (const key of ['a', 'b', 'c', ' ', 'Shift', 'Control']) {
      keyDown(input, key);
    }
    expect(captured).toEqual([]);
  });
});

describe('press capture — OS key-repeat does not flood the step budget', () => {
  test('a repeated (held-down) special key records no step', () => {
    install();
    keyDown(window, 'Escape', true);

    expect(captured).toHaveLength(0);
  });

  test('holding a key down emits ONE press step (the initial keydown), not one per repeat', () => {
    install();
    const btn = document.createElement('button');
    document.body.appendChild(btn);

    keyDown(btn, 'Enter', false); // initial press — recorded
    keyDown(btn, 'Enter', true); // OS repeat — ignored
    keyDown(btn, 'Enter', true); // OS repeat — ignored

    expect(steps()).toEqual([{ kind: 'press', key: 'Enter' }]);
  });

  test('holding Tab inside a focused field emits ONE commit+press pair, not one per repeat', () => {
    install();
    const input = document.createElement('input');
    input.id = 'held-tab';
    document.body.appendChild(input);

    focusIn(input);
    keyDown(input, 'Tab', false); // initial press — commits the type AND emits press
    keyDown(input, 'Tab', true); // OS repeat — must not emit another press step

    expect(steps()).toEqual([
      { kind: 'type', selector: '#held-tab' },
      { kind: 'press', key: 'Tab' },
    ]);
  });
});

describe('SECURITY: untrusted (page-synthesized) events are never captured', () => {
  test('a synthetic click (isTrusted:false, like el.click()) records NOTHING', () => {
    install();
    const btn = document.createElement('button');
    btn.id = 'evil-btn';
    document.body.appendChild(btn);

    // Dispatched WITHOUT markTrusted — stays isTrusted:false, exactly like
    // a page calling el.click() or dispatchEvent(new MouseEvent(...)).
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    // el.click() convenience method — also synthetic/untrusted in jsdom.
    btn.click();

    expect(captured).toHaveLength(0);
  });

  test('synthetic type-commit and key events record NOTHING', () => {
    install();
    const input = document.createElement('input');
    input.id = 'evil-input';
    document.body.appendChild(input);

    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(captured).toHaveLength(0);
  });
});

describe('every emitted payload carries the session nonce', () => {
  test('a captured step includes the exact nonce the recorder was injected with', () => {
    install({ nonce: 'unique-nonce-xyz' });
    const btn = document.createElement('button');
    btn.id = 'n-btn';
    document.body.appendChild(btn);
    pointerDown(btn);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.nonce).toBe('unique-nonce-xyz');
  });
});

describe('idempotency + teardown', () => {
  test('installing the recorder twice on the same document does not double-register listeners', () => {
    install();
    // 2nd injection with the same session globals — must be a no-op.
    globalEval(
      buildRecorderJs({
        bindingName: BINDING_NAME,
        activeFlag: ACTIVE_FLAG,
        stopFn: STOP_FN,
        nonce: NONCE,
      }),
    );

    const btn = document.createElement('button');
    btn.id = 'dup-btn';
    document.body.appendChild(btn);
    pointerDown(btn);

    expect(captured).toHaveLength(1);
  });

  test('after stop(), no further events are captured (listeners torn down)', () => {
    install();
    stop();

    const btn = document.createElement('button');
    btn.id = 'after-stop';
    document.body.appendChild(btn);
    pointerDown(btn);

    expect(captured).toHaveLength(0);
  });

  test('buildStopRecorderJs is a no-op when no recorder is installed', () => {
    // No install() — simulates cleanup running on a page that already
    // navigated away and never got a recorder. Must not throw.
    expect(() => globalEval(buildStopRecorderJs('someRandomStopFnNeverInstalled'))).not.toThrow();
  });

  test('after stop(), the recorder can be installed again fresh', () => {
    install();
    stop();
    install();

    const btn = document.createElement('button');
    btn.id = 'fresh-btn';
    document.body.appendChild(btn);
    pointerDown(btn);

    expect(steps()).toEqual([{ kind: 'click', selector: '#fresh-btn' }]);
  });
});
