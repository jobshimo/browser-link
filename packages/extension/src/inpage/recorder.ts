/**
 * In-page flow recorder — injected via CDP `Runtime.evaluate` ONLY while a
 * recording is active (see `background.ts`'s `startRecording`/
 * `stopRecording`). Never present on a page unless the user opted in via
 * the popup toggle AND pressed Record on that specific tab.
 *
 * Communicates with background.ts over a CDP binding (`Runtime.addBinding`
 * / `Runtime.bindingCalled`, wired in background.ts) rather than a WS/fetch
 * call — the binding is the one channel CDP gives an in-page script to
 * reach the extension without any page-visible network traffic. Each
 * captured user action is emitted as ONE compact JSON string:
 *
 *   { nonce, kind: 'click', selector, ambiguous? }
 *   { nonce, kind: 'type', selector, ambiguous? }
 *   { nonce, kind: 'press', key }
 *
 * THREAT MODEL — the binding function is reachable by EVERY script running
 * in the page (the page's own code, ads, third-party widgets, injected
 * XSS). Two layered defenses keep hostile page scripts from fabricating
 * steps or using the channel for exfiltration:
 *
 *  1. PER-SESSION NONCE: background.ts generates a random nonce for each
 *     recording session and interpolates it into this script at injection
 *     time. Every emitted payload carries it, and background.ts REJECTS any
 *     binding call whose nonce does not match the active session — a page
 *     script calling the binding blind produces zero recorded steps,
 *     because it cannot know the nonce (it lives only inside this closure
 *     and in the extension process). The binding NAME is likewise
 *     randomized per session (see `generateRecordingSession` in
 *     `recording.ts`) so a page cannot even cheaply probe a well-known
 *     global to detect that recording is active.
 *  2. TRUSTED EVENTS ONLY: every listener bails on `!ev.isTrusted`, so
 *     synthetic events a page dispatches programmatically (`el.click()`,
 *     `dispatchEvent(new KeyboardEvent(...))`) are never captured as user
 *     actions. Deliberate tradeoff: page code that activates its OWN
 *     widgets via `.click()` during a demonstration will not be captured
 *     either — record the underlying real gesture instead.
 *  3. GESTURE CORRELATION for type-commits: `isTrusted` alone is NOT
 *     enough for the focus/blur path — per the HTML spec, programmatic
 *     `element.focus()` / `.blur()` from page script DO fire
 *     focus/focusin/blur/focusout events with `isTrusted:true` (unlike
 *     `.click()`, which fires untrusted). So a hostile page could call
 *     `attackerInput.focus(); attackerInput.blur()` to walk
 *     focusin->focusout and fabricate a `{type: selector}` step for an
 *     attacker-chosen replay target. Defeated by CORRELATION rather than by
 *     trusting the focus event: a type-commit is emitted only when the
 *     field's focus was driven by a real user gesture — a trusted
 *     pointerdown/mousedown that landed on the field just before focus, OR
 *     a trusted key event on the field while focused. A field that focuses
 *     and blurs with no such gesture is dropped. (A page cannot forge the
 *     gesture: synthetic pointer/key events are `isTrusted:false`.)
 *
 * Residual risk (documented in the README's privacy section): a script
 * that can read THIS closure's variables could learn the nonce — but any
 * script with that power already owns the page outright. The nonce closes
 * the realistic blind-injection hole, not a hypothetical full-compromise.
 *
 * PRIVACY-CRITICAL: the `type` payload NEVER carries the field's value —
 * there is no field for it in the shape above. `recording.ts` (the
 * background-side pure step builder) is the ONLY place a placeholder
 * string is attached, and it always uses the constant `"<TEXT>"` — the
 * recorder itself has no code path capable of reading, let alone
 * transmitting, what the user typed. No keystroke-level listener exists
 * anywhere in this file.
 *
 * Idempotent: re-running this expression on a document that already has
 * the recorder installed is a no-op — matters because `background.ts`
 * re-injects after every navigation detected while recording, and the two
 * injections could in principle race on the same document. All three
 * page-visible globals (the binding function, the active flag, the stop
 * function) derive from the per-session binding name, so none of them is a
 * stable, guessable fingerprinting surface. `buildStopRecorderJs()` builds
 * the companion teardown expression background.ts evaluates on
 * stop/disconnect/navigation-away.
 */
import { DEEP_QUERY_JS } from './deep-query.js';
import { DOM_HELPERS_JS } from './dom-helpers.js';

/** Options interpolated into the injected source at build time. All four
 * come from `generateRecordingSession()` in `recording.ts` — fresh per
 * recording start, never reused across sessions. The three global names
 * (binding, active-flag, stop-fn) are INDEPENDENT random values with no
 * shared prefix OR suffix, so a page cannot cheaply enumerate
 * `Object.getOwnPropertyNames(window)` for a predictable pattern (e.g.
 * `startsWith('__blRec_')` or `endsWith('_active')`) to detect that
 * recording is active — every recorder global looks like an ordinary
 * random page global. */
export interface RecorderInjectionOptions {
  /** Name of the CDP binding this session calls — background.ts passes the
   * same name to `Runtime.addBinding` and matches it on every
   * `Runtime.bindingCalled` event. Bare random identifier, no shared affix. */
  bindingName: string;
  /** Idempotency flag global (independent random name). */
  activeFlag: string;
  /** Teardown-function global (independent random name). `buildStopRecorderJs`
   * is given this same value so its expression can call it. */
  stopFn: string;
  /** Secret the page scripts cannot know — carried in every payload,
   * checked by background.ts before a payload is parsed at all. */
  nonce: string;
}

export function buildRecorderJs(opts: RecorderInjectionOptions): string {
  const ACTIVE_FLAG = JSON.stringify(opts.activeFlag);
  const STOP_FN = JSON.stringify(opts.stopFn);
  return `
(() => {
  if (window[${ACTIVE_FLAG}]) return;
  window[${ACTIVE_FLAG}] = true;
  ${DEEP_QUERY_JS}
  ${DOM_HELPERS_JS}

  const BINDING_NAME = ${JSON.stringify(opts.bindingName)};
  const NONCE = ${JSON.stringify(opts.nonce)};
  // Non-text special keys that get their own {press:{key}} step, EXCEPT
  // Enter — Enter's handling depends on focus (see the keydown listener
  // below), so it is deliberately not in this list.
  const SPECIAL_KEYS = ['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  // A physical mouse click fires pointerdown then click in quick
  // succession; this window is how long a click is considered "the same
  // gesture" as the pointerdown that preceded it, for dedupe purposes.
  const CLICK_DEDUPE_MS = 800;

  function emit(payload) {
    try {
      const fn = window[BINDING_NAME];
      payload.nonce = NONCE;
      if (typeof fn === 'function') fn(JSON.stringify(payload));
    } catch (_) {
      // Binding gone (recording stopped mid-flight) or serialization
      // failed — never let the recorder throw into page code.
    }
  }

  function deepestTarget(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : null;
    const el = path && path.length > 0 ? path[0] : ev.target;
    return el instanceof Element ? el : null;
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    // Fall back to the raw attribute — belt-and-braces for engines/test
    // environments where the isContentEditable computed property is not
    // fully implemented, and for the (rare) contenteditable="plaintext-only"
    // spelling some editors use.
    const ce = el.getAttribute ? el.getAttribute('contenteditable') : null;
    if (ce === 'true' || ce === '' || ce === 'plaintext-only') return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    const TEXTY = ['text', 'search', 'email', 'tel', 'url', 'password', 'number', ''];
    return TEXTY.indexOf(type) !== -1;
  }

  function emitClickFor(el) {
    const info = genSelectorInfo(el);
    const payload = { kind: 'click', selector: info.selector };
    if (info.ambiguous) payload.ambiguous = true;
    emit(payload);
  }

  // === trusted-gesture tracking ===
  // Records the element + time of the most recent TRUSTED
  // pointerdown/mousedown, and marks a focused field as "gestured" when a
  // trusted key event lands on it. Used by the type-commit gate below to
  // reject fabricated focus/blur sequences (see the THREAT MODEL doc:
  // element.focus()/.blur() from page script fire focus/blur events with
  // isTrusted:TRUE — unlike .click() — so the isTrusted guard alone does
  // NOT stop a page from walking focusin->focusout to fabricate a type
  // step for an attacker-chosen selector). A window bounds the
  // pointer-gesture-before-focus correlation; the key-on-field signal is a
  // per-session boolean, no window needed.
  const GESTURE_WINDOW_MS = 1000;
  let lastTrustedPointerTarget = null;
  let lastTrustedPointerAt = 0;

  function noteTrustedPointer(el) {
    lastTrustedPointerTarget = el;
    lastTrustedPointerAt = Date.now();
  }

  // === click: pointerdown is the primary signal (survives an element
  // that gets removed from the DOM before 'click' would fire — a common
  // pattern for menu/dropdown items); 'click' is a fallback for
  // keyboard-driven activation (Enter/Space on a focused button) and is
  // deduped against a pointerdown on the SAME element within
  // CLICK_DEDUPE_MS so one physical mouse click is never recorded twice.
  // Both bail on untrusted events — see the THREAT MODEL note above. ===
  let lastPointerDownTarget = null;
  let lastPointerDownAt = 0;

  function onPointerDown(ev) {
    if (!ev.isTrusted) return;
    // Only the primary (left) button represents a click gesture for replay
    // purposes. A right-click opens a context menu and a middle-click
    // commonly opens a new tab or triggers autoscroll — recording either as
    // a {kind:'click'} step would replay the wrong action. This also skips
    // the gesture-tracking below for non-left buttons, which is correct:
    // a right-click on a field should not be able to authorize a
    // subsequent fabricated type-commit either.
    if (ev.button !== 0) return;
    const target = deepestTarget(ev);
    if (!target) return;
    noteTrustedPointer(target);
    emitClickFor(target);
    lastPointerDownTarget = target;
    lastPointerDownAt = Date.now();
  }

  // mousedown is tracked for gesture-correlation ONLY (it never emits a
  // click — pointerdown already covers that in every modern Chrome). Some
  // widgets fire mousedown without a preceding pointerdown in edge cases;
  // recording the gesture here keeps the type-commit gate from dropping a
  // legitimate field focus in those cases.
  function onMouseDown(ev) {
    if (!ev.isTrusted) return;
    // Same left-button gate as onPointerDown — WITHOUT it, a trusted
    // right/middle mousedown on a field would still note a gesture and
    // authorize a type-commit that the pointerdown gate above just refused,
    // making the "cannot authorize a fabricated type-commit" claim false.
    if (ev.button !== 0) return;
    const target = deepestTarget(ev);
    if (target) noteTrustedPointer(target);
  }

  function onClick(ev) {
    if (!ev.isTrusted) return;
    // Same button gate as onPointerDown above — Chrome only fires 'click'
    // for the primary button in practice (other buttons fire 'auxclick'
    // instead), but check explicitly rather than relying on that behavior:
    // this keeps the keyboard-activation fallback path (Enter/Space on a
    // focused button, which always reports button:0) correct regardless.
    if (ev.button !== 0) return;
    const target = deepestTarget(ev);
    if (!target) return;
    if (target === lastPointerDownTarget && Date.now() - lastPointerDownAt < CLICK_DEDUPE_MS) {
      // Second half of the physical click already recorded on pointerdown.
      lastPointerDownTarget = null;
      return;
    }
    emitClickFor(target);
  }

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('click', onClick, true);

  // === type: ONE {type:{selector}} step per focused text field, emitted
  // on commit (blur / change / Enter). The actual value is NEVER read.
  //
  // GATE: a commit is emitted ONLY when the field's focus was driven by a
  // real user gesture — a trusted pointerdown/mousedown that landed on the
  // field (or a descendant) just before focus, OR a trusted key event on
  // the field while it held focus (covers Tab-into-then-type). A field
  // that focuses and blurs with NO such gesture (a page calling
  // field.focus(); field.blur()) is DROPPED — it was not user-driven, even
  // though the focus/blur events themselves are isTrusted:true. ===
  let focusedField = null; // { el, committed, gestured }

  function commitFocusedField() {
    if (!focusedField || focusedField.committed) return;
    focusedField.committed = true;
    if (!focusedField.gestured) return; // fabricated focus/blur — drop it.
    const info = genSelectorInfo(focusedField.el);
    const payload = { kind: 'type', selector: info.selector };
    if (info.ambiguous) payload.ambiguous = true;
    emit(payload);
  }

  function onFocusIn(ev) {
    if (!ev.isTrusted) return;
    const target = ev.target;
    if (!isTextField(target)) {
      focusedField = null;
      return;
    }
    // Correlate with a just-happened trusted pointer gesture ON this field
    // (or a child of it, for a click inside a contenteditable). The pointer
    // gesture fires BEFORE focusin, so this is the moment to check it.
    const gestured =
      !!lastTrustedPointerTarget &&
      Date.now() - lastTrustedPointerAt < GESTURE_WINDOW_MS &&
      (lastTrustedPointerTarget === target || composedContains(target, lastTrustedPointerTarget));
    focusedField = { el: target, committed: false, gestured: gestured };
  }

  function onFocusOut(ev) {
    if (!ev.isTrusted) return;
    if (focusedField && ev.target === focusedField.el) {
      commitFocusedField();
      focusedField = null;
    }
  }

  function onChange(ev) {
    if (!ev.isTrusted) return;
    if (focusedField && ev.target === focusedField.el) commitFocusedField();
  }

  window.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('change', onChange, true);

  // === press: special keys outside text-field commits. Enter's dedupe
  // rule is deliberate: Enter WHILE a tracked text field has focus belongs
  // to that field's type-commit (see commitFocusedField above), never a
  // separate press step — pressing Enter to submit a search box is one
  // user action, not two. Tab is NOT swallowed the same way: it both
  // commits any pending text (moving focus away triggers the same commit
  // a native blur would) AND is recorded as its own {press:{key:"Tab"}}
  // step, since Tab is a real, independently-replayable navigational
  // action distinct from "the field lost focus". ===
  function onKeyDown(ev) {
    if (!ev.isTrusted) return;
    // OS key-repeat (holding a key down) fires a fresh keydown every
    // repeat interval for ONE physical keystroke. Recording each as its own
    // press step would burn through the 20-step recording budget on a
    // single held key; only the initial, non-repeat keydown is a genuine
    // new user action.
    if (ev.repeat) return;
    const key = ev.key;
    const inTrackedField = !!focusedField && ev.target === focusedField.el;
    // A trusted key event ON the focused field is itself a user gesture —
    // this is what makes the Tab-into-field-then-type path commit even
    // though no pointer gesture focused it (the typed keystrokes, or the
    // Tab keydown that navigates through it, are real user actions). A page
    // cannot forge these: a synthetic keydown is isTrusted:false and bails
    // at the top of this handler.
    if (inTrackedField) focusedField.gestured = true;

    if (key === 'Enter') {
      if (inTrackedField) {
        commitFocusedField();
      } else {
        emit({ kind: 'press', key: 'Enter' });
      }
      return;
    }
    if (SPECIAL_KEYS.indexOf(key) === -1) return;
    if (key === 'Tab' && inTrackedField) commitFocusedField();
    emit({ kind: 'press', key: key });
  }

  window.addEventListener('keydown', onKeyDown, true);

  window[${STOP_FN}] = () => {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('change', onChange, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window[${ACTIVE_FLAG}] = false;
    delete window[${STOP_FN}];
  };
})()
`;
}

/** Companion teardown expression for the given session: calls the
 * installed recorder's own stop function (named by the session's random
 * `stopFn` global) when present, no-op otherwise (e.g. the tab already
 * navigated away and the recorder was never re-injected into the new
 * document — in that case there is nothing to tear down, which is itself
 * the desired end state). background.ts evaluates this on Stop, on
 * Discard-while-recording, on tab disconnect/removal/idle-sweep cleanup,
 * and when the flow-recording setting flips off mid-recording —
 * teardown-on-every-exit-path is part of the documented privacy contract,
 * not an optimization. Safe to evaluate any number of times. */
export function buildStopRecorderJs(stopFn: string): string {
  const STOP_FN = JSON.stringify(stopFn);
  return `
(() => {
  const stop = window[${STOP_FN}];
  if (typeof stop === 'function') stop();
  return true;
})()
`;
}
