import { describe, expect, test } from 'vitest';
import { MAX_FLOW_STEPS, type FlowStep } from './flow.js';
import {
  DISCARDED_WHILE_SAVING_MESSAGE,
  MAX_RECORDED_SELECTOR_LENGTH,
  MAX_RECORDING_STEPS,
  TEXT_PLACEHOLDER,
  appendRecordingStep,
  buildAmbiguousNote,
  buildNavigationWaitForStep,
  describeFlowStep,
  generateRecordingSession,
  isNavigationForRecording,
  isSameRecordingSession,
  parseRecordedPayload,
  toFlowStep,
} from './recording.js';

const NONCE = 'sess-nonce-1';

/** Helper: build a payload JSON string with the correct nonce baked in, so
 * the happy-path tests read cleanly. Pass `nonce` to override for the
 * security tests. */
function wire(obj: Record<string, unknown>, nonce: string = NONCE): string {
  return JSON.stringify({ nonce, ...obj });
}

describe('parseRecordedPayload — happy path', () => {
  test('parses a click payload (nonce stripped from the result)', () => {
    expect(parseRecordedPayload(wire({ kind: 'click', selector: '#save' }), NONCE)).toEqual({
      kind: 'click',
      selector: '#save',
    });
  });

  test('parses a click payload carrying ambiguous:true', () => {
    expect(
      parseRecordedPayload(wire({ kind: 'click', selector: 'div', ambiguous: true }), NONCE),
    ).toEqual({ kind: 'click', selector: 'div', ambiguous: true });
  });

  test('drops ambiguous when it is not literally true', () => {
    expect(
      parseRecordedPayload(wire({ kind: 'click', selector: '#x', ambiguous: 'yes' }), NONCE),
    ).toEqual({ kind: 'click', selector: '#x' });
  });

  test('parses a type payload — never carries anything beyond kind + selector', () => {
    const parsed = parseRecordedPayload(wire({ kind: 'type', selector: '#search' }), NONCE);
    expect(parsed).toEqual({ kind: 'type', selector: '#search' });
    expect(Object.keys(parsed as object)).toEqual(['kind', 'selector']);
  });

  test('parses each allowlisted press key', () => {
    for (const key of [
      'Enter',
      'Escape',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
    ]) {
      expect(parseRecordedPayload(wire({ kind: 'press', key }), NONCE)).toEqual({
        kind: 'press',
        key,
      });
    }
  });
});

describe('parseRecordedPayload — SECURITY: nonce gate', () => {
  test('rejects a payload whose nonce does not match the active session', () => {
    expect(
      parseRecordedPayload(wire({ kind: 'click', selector: '#x' }, 'wrong'), NONCE),
    ).toBeNull();
  });

  test('rejects a payload with no nonce at all (a blind page-script call)', () => {
    expect(parseRecordedPayload('{"kind":"click","selector":"#x"}', NONCE)).toBeNull();
  });

  test('a fabricated exfiltration attempt (cookie-as-selector) is rejected without the nonce', () => {
    // The classic abuse: a page script calls the binding directly with a
    // secret smuggled as a "selector". Without the nonce it never parses,
    // so it never reaches the map DB.
    const evil = '{"kind":"type","selector":"session=abc123; token=xyz"}';
    expect(parseRecordedPayload(evil, NONCE)).toBeNull();
  });
});

describe('parseRecordedPayload — SECURITY: stricter-than-agent validation', () => {
  test('rejects a selector longer than MAX_RECORDED_SELECTOR_LENGTH', () => {
    const long = '#' + 'a'.repeat(MAX_RECORDED_SELECTOR_LENGTH);
    expect(parseRecordedPayload(wire({ kind: 'click', selector: long }), NONCE)).toBeNull();
    // Exactly at the cap is still accepted.
    const atCap = 'a'.repeat(MAX_RECORDED_SELECTOR_LENGTH);
    expect(parseRecordedPayload(wire({ kind: 'click', selector: atCap }), NONCE)).not.toBeNull();
  });

  test('rejects a selector containing C0 controls / newline / DEL', () => {
    expect(parseRecordedPayload(wire({ kind: 'click', selector: 'a\u0000b' }), NONCE)).toBeNull();
    expect(parseRecordedPayload(wire({ kind: 'type', selector: 'a\nb' }), NONCE)).toBeNull();
    expect(parseRecordedPayload(wire({ kind: 'click', selector: 'a\u007Fb' }), NONCE)).toBeNull();
  });

  test('rejects a selector containing C1 controls or genuinely invisible / spoofing chars', () => {
    // These slip past a naive /[\u0000-\u001F]/ filter but no real genSelectorInfo
    // selector contains them — reject as defense in depth (the nonce is the real gate).
    for (const ch of [
      '\u0085', // NEL (C1)
      '\u009F', // C1 control
      '\u200B', // ZERO WIDTH SPACE
      '\u2028', // LINE SEPARATOR
      '\u2029', // PARAGRAPH SEPARATOR
      '\u202A', // LEFT-TO-RIGHT EMBEDDING (legacy bidi)
      '\u202E', // RIGHT-TO-LEFT OVERRIDE (classic spoofing char)
      '\u2060', // WORD JOINER
      '\u2066', // LEFT-TO-RIGHT ISOLATE (modern bidi)
      '\u2069', // POP DIRECTIONAL ISOLATE
      '\uFEFF', // BOM / ZWNBSP
    ]) {
      expect(parseRecordedPayload(wire({ kind: 'click', selector: `a${ch}b` }), NONCE)).toBeNull();
    }
  });

  test('does NOT over-block a legit aria-label selector with a ZWJ emoji + directional marks', () => {
    // Regression guard: genSelectorInfo's aria-label branch inlines raw
    // attribute text, so a label containing a multi-codepoint emoji (ZWJ
    // U+200D between codepoints) or an LRM/RLM directional mark (U+200E/F,
    // common on RTL-aware sites) is a REAL selector that must still parse —
    // the earlier filter over-blocked these and silently dropped the step.
    const zwjFamily = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // family emoji
    const selector = `button[aria-label="Share ${zwjFamily} \u200Ewith team"]`;
    const parsed = parseRecordedPayload(wire({ kind: 'click', selector }), NONCE);
    expect(parsed).toEqual({ kind: 'click', selector });
  });

  test('rejects a press key OUTSIDE the recorder allowlist (stricter than browser.press)', () => {
    // 'a', 'F5', 'PageDown' are all valid keys browser.press would accept,
    // but the recorder only ever emits the special-navigation set — so a
    // press payload for anything else is not a real recorder step.
    expect(parseRecordedPayload(wire({ kind: 'press', key: 'a' }), NONCE)).toBeNull();
    expect(parseRecordedPayload(wire({ kind: 'press', key: 'F5' }), NONCE)).toBeNull();
    expect(parseRecordedPayload(wire({ kind: 'press', key: 'PageDown' }), NONCE)).toBeNull();
  });
});

describe('parseRecordedPayload — malformed input', () => {
  test('rejects invalid JSON', () => {
    expect(parseRecordedPayload('not json', NONCE)).toBeNull();
  });

  test('rejects an unknown kind', () => {
    expect(parseRecordedPayload(wire({ kind: 'scroll' }), NONCE)).toBeNull();
  });

  test('rejects click/type with a missing or empty selector', () => {
    expect(parseRecordedPayload(wire({ kind: 'click' }), NONCE)).toBeNull();
    expect(parseRecordedPayload(wire({ kind: 'click', selector: '' }), NONCE)).toBeNull();
    expect(parseRecordedPayload(wire({ kind: 'type', selector: 123 }), NONCE)).toBeNull();
  });

  test('rejects press with a missing or empty key', () => {
    expect(parseRecordedPayload(wire({ kind: 'press' }), NONCE)).toBeNull();
    expect(parseRecordedPayload(wire({ kind: 'press', key: '' }), NONCE)).toBeNull();
  });

  test('rejects non-object top level', () => {
    expect(parseRecordedPayload('null', NONCE)).toBeNull();
    expect(parseRecordedPayload('42', NONCE)).toBeNull();
    expect(parseRecordedPayload('"str"', NONCE)).toBeNull();
  });
});

describe('generateRecordingSession', () => {
  test('produces four fresh, distinct random values each call', () => {
    const a = generateRecordingSession();
    const b = generateRecordingSession();
    // All four fields are independent randoms — distinct within a session
    // AND across sessions.
    const aVals = [a.bindingName, a.activeFlag, a.stopFn, a.nonce];
    expect(new Set(aVals).size).toBe(4);
    expect(a.bindingName).not.toBe(b.bindingName);
    expect(a.activeFlag).not.toBe(b.activeFlag);
    expect(a.stopFn).not.toBe(b.stopFn);
    expect(a.nonce).not.toBe(b.nonce);
  });

  test('the global names have NO shared, guessable prefix or suffix (fingerprint resistance)', () => {
    // The whole point of the fix: a page must not be able to detect
    // recording by scanning window for a known pattern. Each name is a bare
    // identifier (leading letter, then hex) with no `__blRec_` prefix or
    // `_active`/`_stop` suffix. Sample many sessions and assert no fixed
    // affix survives across them.
    const names: string[] = [];
    for (let i = 0; i < 50; i++) {
      const s = generateRecordingSession();
      names.push(s.bindingName, s.activeFlag, s.stopFn);
    }
    // Valid identifier: starts with a letter, rest alphanumeric.
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9]+$/);
    // No two names share the first 2 chars universally (i.e. the first
    // char varies) — a fixed prefix would make them all share char 0.
    const firstChars = new Set(names.map((n) => n[0]));
    expect(firstChars.size).toBeGreaterThan(1);
    // None carries the old distinctive prefix/suffixes.
    for (const n of names) {
      expect(n.startsWith('__blRec_')).toBe(false);
      expect(n.endsWith('_active')).toBe(false);
      expect(n.endsWith('_stop')).toBe(false);
    }
  });
});

describe('isSameRecordingSession — Discard/Save race guard', () => {
  test('true when the live nonce matches the captured session nonce', () => {
    expect(isSameRecordingSession('nonce-a', 'nonce-a')).toBe(true);
  });

  test('false when a DIFFERENT recording is now live on the tab (new nonce)', () => {
    // The Discard-then-Record race: the user discarded the session
    // saveRecording captured, then immediately started a new one on the
    // same tab before the old save's server response arrived.
    expect(isSameRecordingSession('nonce-b', 'nonce-a')).toBe(false);
  });

  test('false when nothing is recording anymore (live nonce undefined, e.g. after Discard)', () => {
    expect(isSameRecordingSession(undefined, 'nonce-a')).toBe(false);
  });
});

describe('DISCARDED_WHILE_SAVING_MESSAGE', () => {
  test('is a non-empty, human-readable string', () => {
    expect(typeof DISCARDED_WHILE_SAVING_MESSAGE).toBe('string');
    expect(DISCARDED_WHILE_SAVING_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe('buildAmbiguousNote', () => {
  test('returns null when nothing was ambiguous', () => {
    expect(buildAmbiguousNote([])).toBeNull();
  });

  test('renders 0-based indices as 1-based step numbers, singular', () => {
    expect(buildAmbiguousNote([2])).toMatch(/^Step 3: selector may match multiple elements/);
  });

  test('renders multiple indices, plural', () => {
    expect(buildAmbiguousNote([0, 4])).toMatch(/^Steps 1, 5: selector may match multiple elements/);
  });
});

describe('toFlowStep — the privacy boundary', () => {
  test('click converts to {click:{selector}}', () => {
    expect(toFlowStep({ kind: 'click', selector: '#save' })).toEqual({
      click: { selector: '#save' },
    });
  });

  test('type converts to {type:{selector, text: TEXT_PLACEHOLDER}} — always the placeholder', () => {
    const step = toFlowStep({ kind: 'type', selector: '#search' });
    expect(step).toEqual({ type: { selector: '#search', text: TEXT_PLACEHOLDER } });
    expect(TEXT_PLACEHOLDER).toBe('<TEXT>');
  });

  test('press converts to {press:{key}}', () => {
    expect(toFlowStep({ kind: 'press', key: 'Tab' })).toEqual({ press: { key: 'Tab' } });
  });

  test('no RecordedPayload shape can produce a type step with a non-placeholder text — the type is structurally incapable of carrying one', () => {
    // toFlowStep's only source for `text` is the TEXT_PLACEHOLDER constant;
    // RecordedPayload's `type` variant has no field that could feed it
    // anything else. This test exists to make that guarantee explicit and
    // catch any future refactor that accidentally threads a real value in.
    const payloads: Array<{ kind: 'type'; selector: string }> = [
      { kind: 'type', selector: '#a' },
      { kind: 'type', selector: '#b' },
    ];
    for (const p of payloads) {
      const step = toFlowStep(p);
      expect('type' in step && step.type.text).toBe(TEXT_PLACEHOLDER);
    }
  });
});

describe('appendRecordingStep — cap enforcement', () => {
  test('appends below the cap', () => {
    const result = appendRecordingStep([], { click: { selector: '#a' } });
    expect(result.capped).toBe(false);
    expect(result.steps).toEqual([{ click: { selector: '#a' } }]);
  });

  test('does not mutate the input array', () => {
    const original: FlowStep[] = [{ click: { selector: '#a' } }];
    const result = appendRecordingStep(original, { press: { key: 'Tab' } });
    expect(original).toHaveLength(1);
    expect(result.steps).toHaveLength(2);
  });

  test('refuses to append once MAX_RECORDING_STEPS is already reached', () => {
    const full: FlowStep[] = Array.from({ length: MAX_RECORDING_STEPS }, (_, i) => ({
      press: { key: `k${i}` },
    }));
    const result = appendRecordingStep(full, { press: { key: 'overflow' } });
    expect(result.capped).toBe(true);
    expect(result.steps).toHaveLength(MAX_RECORDING_STEPS);
    expect(result.steps).toEqual(full);
  });

  test('MAX_RECORDING_STEPS matches the browser.flow ceiling (20)', () => {
    expect(MAX_RECORDING_STEPS).toBe(20);
  });

  test('MAX_RECORDING_STEPS IS MAX_FLOW_STEPS — one source of truth, not two literals that happen to match', () => {
    expect(MAX_RECORDING_STEPS).toBe(MAX_FLOW_STEPS);
  });
});

describe('isNavigationForRecording', () => {
  test('true when the URL changed', () => {
    expect(isNavigationForRecording('https://a.com/x', 'https://a.com/y')).toBe(true);
  });

  test('false when the URL is unchanged (no real navigation)', () => {
    expect(isNavigationForRecording('https://a.com/x', 'https://a.com/x')).toBe(false);
  });

  test('false for an empty incoming URL (mid-navigation blank)', () => {
    expect(isNavigationForRecording('https://a.com/x', '')).toBe(false);
  });
});

describe('buildNavigationWaitForStep', () => {
  test('returns a valid wait_for expression step', () => {
    expect(buildNavigationWaitForStep()).toEqual({
      wait_for: { expression: "document.readyState === 'complete'" },
    });
  });
});

describe('describeFlowStep', () => {
  test('describes every step kind', () => {
    expect(describeFlowStep({ click: { selector: '#a' } })).toBe('Click #a');
    expect(describeFlowStep({ type: { selector: '#b', text: TEXT_PLACEHOLDER } })).toBe(
      'Type into #b',
    );
    expect(describeFlowStep({ press: { key: 'Enter' } })).toBe('Press Enter');
    expect(describeFlowStep(buildNavigationWaitForStep())).toBe(
      "Wait for document.readyState === 'complete'",
    );
    expect(describeFlowStep({ find: { text: 'Save' } })).toBe('Find "Save"');
  });
});
