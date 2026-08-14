import { describe, expect, test } from 'vitest';
import { MODIFIER_BITS, buildKeyEventSequence, modifiersToBitmask, resolveKey } from './keymap.js';

describe('resolveKey — named control/navigation keys', () => {
  test('resolves every documented named key with the expected Windows virtual-key code', () => {
    expect(resolveKey('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(resolveKey('Escape')).toEqual({ key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(resolveKey('Tab')).toEqual({ key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(resolveKey('Backspace')).toEqual({ key: 'Backspace', code: 'Backspace', keyCode: 8 });
    expect(resolveKey('Delete')).toEqual({ key: 'Delete', code: 'Delete', keyCode: 46 });
    expect(resolveKey('ArrowUp')).toEqual({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 });
    expect(resolveKey('ArrowDown')).toEqual({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
    expect(resolveKey('ArrowLeft')).toEqual({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 });
    expect(resolveKey('ArrowRight')).toEqual({
      key: 'ArrowRight',
      code: 'ArrowRight',
      keyCode: 39,
    });
    expect(resolveKey('Home')).toEqual({ key: 'Home', code: 'Home', keyCode: 36 });
    expect(resolveKey('End')).toEqual({ key: 'End', code: 'End', keyCode: 35 });
    expect(resolveKey('PageUp')).toEqual({ key: 'PageUp', code: 'PageUp', keyCode: 33 });
    expect(resolveKey('PageDown')).toEqual({ key: 'PageDown', code: 'PageDown', keyCode: 34 });
  });

  test('Space resolves with a text field (it produces visible input)', () => {
    expect(resolveKey('Space')).toEqual({ key: ' ', code: 'Space', keyCode: 32, text: ' ' });
  });

  test('a literal space character resolves to the same definition as the named Space key', () => {
    expect(resolveKey(' ')).toEqual(resolveKey('Space'));
  });

  test('Enter carries text \\r — the char event is what drives implicit form submission', () => {
    // WHATWG implicit submission runs as the default action of KEYPRESS,
    // and the CDP sequence only produces a keypress via the char event —
    // emitted only for text-bearing keys. Enter without text would fire
    // keydown/keyup but never submit a form. '\r' matches Puppeteer's
    // USKeyboardLayout.
    expect(resolveKey('Enter')?.text).toBe('\r');
  });

  test('control keys carry no text field — no char event should fire for them', () => {
    for (const name of ['Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'Home']) {
      expect(resolveKey(name)?.text).toBeUndefined();
    }
  });

  test('named key matching is case-insensitive', () => {
    expect(resolveKey('enter')).toEqual(resolveKey('Enter'));
    expect(resolveKey('ARROWUP')).toEqual(resolveKey('ArrowUp'));
    expect(resolveKey('pageDown')).toEqual(resolveKey('PageDown'));
  });
});

describe('resolveKey — printable characters', () => {
  test('lowercase and uppercase letters share code/keyCode but differ in key/text/needsShift', () => {
    const lower = resolveKey('a');
    const upper = resolveKey('A');
    expect(lower).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(upper).toEqual({ key: 'A', code: 'KeyA', keyCode: 65, text: 'A', needsShift: true });
  });

  test('printable character matching is case-SENSITIVE, unlike named keys', () => {
    expect(resolveKey('a')).not.toEqual(resolveKey('A'));
  });

  test('digits resolve to Digit<n> with the ASCII-derived keyCode', () => {
    expect(resolveKey('5')).toEqual({ key: '5', code: 'Digit5', keyCode: 53, text: '5' });
    expect(resolveKey('0')).toEqual({ key: '0', code: 'Digit0', keyCode: 48, text: '0' });
  });

  test('shifted digit-row symbols resolve to the same physical key with needsShift', () => {
    const two = resolveKey('2');
    const at = resolveKey('@');
    expect(two).toEqual({ key: '2', code: 'Digit2', keyCode: 50, text: '2' });
    expect(at).toEqual({ key: '@', code: 'Digit2', keyCode: 50, text: '@', needsShift: true });
  });

  test('punctuation resolves to its physical key; the shifted glyph shares code/keyCode', () => {
    const period = resolveKey('.');
    const gt = resolveKey('>');
    expect(period).toEqual({ key: '.', code: 'Period', keyCode: 190, text: '.' });
    expect(gt).toEqual({ key: '>', code: 'Period', keyCode: 190, text: '>', needsShift: true });
  });

  test('an unlisted printable character still resolves — best-effort code/keyCode', () => {
    const yen = resolveKey('¥');
    expect(yen).not.toBeNull();
    expect(yen?.key).toBe('¥');
    expect(yen?.text).toBe('¥');
  });

  test('multi-character strings that are not a named key resolve to null', () => {
    expect(resolveKey('Ctrl+A')).toBeNull();
    expect(resolveKey('notakey')).toBeNull();
    expect(resolveKey('')).toBeNull();
  });
});

describe('modifiersToBitmask', () => {
  test('maps each modifier to its documented CDP bit', () => {
    expect(MODIFIER_BITS).toEqual({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });
  });

  test('empty/undefined modifiers produce a zero mask', () => {
    expect(modifiersToBitmask(undefined)).toBe(0);
    expect(modifiersToBitmask([])).toBe(0);
  });

  test('a single modifier maps to its bit', () => {
    expect(modifiersToBitmask(['Shift'])).toBe(8);
    expect(modifiersToBitmask(['Control'])).toBe(2);
  });

  test('multiple modifiers OR together (e.g. Ctrl+Shift)', () => {
    expect(modifiersToBitmask(['Control', 'Shift'])).toBe(10);
    expect(modifiersToBitmask(['Alt', 'Control', 'Meta', 'Shift'])).toBe(15);
  });

  test('unknown modifier names are ignored defensively', () => {
    expect(modifiersToBitmask(['Control', 'Bogus' as unknown as string])).toBe(2);
  });
});

describe('buildKeyEventSequence', () => {
  test('Enter emits keyDown / char("\\r") / keyUp — the char event fires for Enter', () => {
    const seq = buildKeyEventSequence(resolveKey('Enter')!, 0);
    expect(seq.map((e) => e.type)).toEqual(['keyDown', 'char', 'keyUp']);
    const char = seq[1];
    expect(char.text).toBe('\r');
    expect(char.unmodifiedText).toBe('\r');
    expect(char.windowsVirtualKeyCode).toBe(13);
  });

  test('a control key without text emits rawKeyDown / keyUp only — no char event', () => {
    const seq = buildKeyEventSequence(resolveKey('Escape')!, 0);
    expect(seq.map((e) => e.type)).toEqual(['rawKeyDown', 'keyUp']);
  });

  test('a printable character emits keyDown / char / keyUp, keyDown WITHOUT text (no double-insert)', () => {
    const seq = buildKeyEventSequence(resolveKey('a')!, 0);
    expect(seq.map((e) => e.type)).toEqual(['keyDown', 'char', 'keyUp']);
    expect(seq[0].text).toBeUndefined();
    expect(seq[1].text).toBe('a');
  });

  test('the modifiers bitmask propagates to every event in the sequence', () => {
    const seq = buildKeyEventSequence(resolveKey('Enter')!, 10);
    for (const e of seq) {
      expect(e.modifiers).toBe(10);
    }
  });
});
