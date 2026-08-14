import { describe, expect, test } from 'vitest';
import { MODIFIER_BITS, buildKeyEventSequence, modifiersToBitmask, resolveKey } from './keymap.js';

/* Local execution coverage of the server's verbatim keymap copy — the
 * drift.test.ts guard proves it stays identical to the extension original,
 * this proves the copy actually behaves. */

describe('resolveKey', () => {
  test('resolves a named control key case-insensitively', () => {
    expect(resolveKey('Enter')?.keyCode).toBe(13);
    expect(resolveKey('enter')?.keyCode).toBe(13);
    expect(resolveKey('ARROWUP')?.key).toBe('ArrowUp');
  });

  test('Enter carries text so it can drive implicit form submission', () => {
    expect(resolveKey('Enter')?.text).toBe('\r');
  });

  test('a lowercase letter is case-sensitive and unshifted', () => {
    const a = resolveKey('a');
    expect(a?.text).toBe('a');
    expect(a?.needsShift).toBeUndefined();
  });

  test('an uppercase letter needs shift', () => {
    expect(resolveKey('A')?.needsShift).toBe(true);
  });

  test('a shifted symbol needs shift', () => {
    expect(resolveKey('@')?.needsShift).toBe(true);
  });

  test('an unrecognized multi-char name returns null', () => {
    expect(resolveKey('NotAKey')).toBeNull();
  });
});

describe('modifiersToBitmask', () => {
  test('folds names into the CDP bitmask', () => {
    expect(modifiersToBitmask(['Control', 'Shift'])).toBe(
      MODIFIER_BITS.Control | MODIFIER_BITS.Shift,
    );
  });

  test('ignores unknown modifiers defensively', () => {
    expect(modifiersToBitmask(['Bogus'])).toBe(0);
    expect(modifiersToBitmask(undefined)).toBe(0);
  });
});

describe('buildKeyEventSequence', () => {
  test('a text-bearing key emits keyDown + char + keyUp', () => {
    const def = resolveKey('a')!;
    const seq = buildKeyEventSequence(def, 0);
    expect(seq.map((e) => e.type)).toEqual(['keyDown', 'char', 'keyUp']);
    expect(seq[1].text).toBe('a');
  });

  test('a control key with no text emits rawKeyDown + keyUp only', () => {
    const def = resolveKey('Escape')!;
    const seq = buildKeyEventSequence(def, 0);
    expect(seq.map((e) => e.type)).toEqual(['rawKeyDown', 'keyUp']);
  });
});
